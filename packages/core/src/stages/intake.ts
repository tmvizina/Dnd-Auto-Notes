import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Registry } from "../campaign/registry.js";
import { byRoll20Account, loadRegistry } from "../campaign/registry.js";
import type { QaEntry } from "../contracts/common.js";
import type { Manifest, ManifestRoll } from "../contracts/manifest.js";
import { writeArtifact } from "../session/session.js";
import type { Session } from "../session/session.js";
import type { FileIo } from "../session/io.js";
import { hashFile, hashFileIfPresent } from "../stage/hash.js";
import { runStage } from "../stage/runner.js";
import type { ProgressFn, StageResult } from "../stage/runner.js";
import { craigIntake } from "../intake/craig/intake.js";
import type { TrackProber } from "../intake/craig/probe.js";
import { parseRoll20, resolveRoll20Time } from "../intake/roll20/index.js";
import type { Roll20ParseResult } from "../intake/roll20/parser.js";
import type { RollData } from "../intake/roll20/parser.js";

/** The manifest shape produced by the first pipeline stage. */
export const INTAKE_STAGE_VERSION = 2;

export interface IntakeStageOptions {
  readonly session: Session;
  /** Campaign registry to join against; defaults to `<session>/campaign`. */
  readonly campaignRoot?: string;
  readonly prober?: TrackProber;
  readonly alignmentToleranceS?: number;
  readonly force?: boolean;
  readonly onProgress?: ProgressFn;
  readonly io?: FileIo;
}

export type IntakeStageResult = StageResult<Manifest>;

interface Roll20Input {
  readonly path: string;
  readonly raw: unknown;
  readonly source: "json" | "html";
}

function slashRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** Read a directory as a sorted list, ignoring a missing directory. */
async function filesUnder(root: string, skipDirectory?: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      if (entry.name === skipDirectory) continue;
      files.push(...(await filesUnder(join(root, entry.name), skipDirectory)));
    } else if (entry.isFile()) {
      files.push(join(root, entry.name));
    }
  }
  return files;
}

/**
 * Input paths are explicit so `runStage` can hash them, while the signature
 * also notices a newly dropped track whose path did not exist on the first
 * run. Derived Craig extraction files are excluded: the archive is the source
 * of truth and the extraction receipt is a cache, not a second input.
 */
async function stageInputs(
  session: Session,
  campaignRoot: string,
): Promise<{
  readonly paths: string[];
  readonly signature: readonly string[];
}> {
  const inputRoot = join(session.paths.root, "input");
  const sourceFiles = [
    ...(await filesUnder(join(inputRoot, "craig"), "extracted")),
    ...(await filesUnder(join(inputRoot, "roll20"))),
    ...(await filesUnder(campaignRoot)),
  ];

  // Keep absent conventional inputs declared as well. Their later appearance
  // is then a cheap hash mismatch even before the directory signature changes.
  const conventional = [
    join(session.paths.root, "session.json"),
    join(inputRoot, "craig", "info.txt"),
    join(inputRoot, "roll20", "roll20-capture.json"),
    join(inputRoot, "roll20", "chat-archive.html"),
    join(campaignRoot, "campaign.json"),
    join(campaignRoot, "players.json"),
    join(campaignRoot, "npcs.json"),
    join(campaignRoot, "glossary.md"),
    join(campaignRoot, "lexicon.ooc.json"),
  ];
  const paths = [...new Set([...sourceFiles, ...conventional])].sort();
  const signature: string[] = [];
  for (const path of paths) {
    const digest = await hashFileIfPresent(path);
    signature.push(`${slashRelative(session.paths.root, path)}:${digest ?? "0".repeat(64)}`);
  }
  return { paths, signature };
}

async function findRoll20Input(sessionRoot: string): Promise<Roll20Input | null> {
  const root = join(sessionRoot, "input", "roll20");
  const files = (await filesUnder(root)).filter((path) => {
    const lower = path.toLowerCase();
    return lower.endsWith(".json") || lower.endsWith(".html") || lower.endsWith(".htm");
  });
  const preferred = files.sort((left, right) => {
    const rank = (path: string): number => {
      const lower = path.toLowerCase();
      if (lower.endsWith("roll20-capture.json")) return 0;
      if (lower.endsWith(".json")) return 1;
      if (lower.endsWith(".html") || lower.endsWith(".htm")) return 2;
      return 3;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  })[0];
  if (preferred === undefined) return null;

  const lower = preferred.toLowerCase();
  if (lower.endsWith(".json")) {
    return {
      path: preferred,
      source: "json",
      raw: JSON.parse(await readFile(preferred, "utf8")) as unknown,
    };
  }
  return { path: preferred, source: "html", raw: await readFile(preferred, "utf8") };
}

function captureMode(input: Roll20Input): "live" | "post_hoc" | "archive" {
  if (input.source === "html") return "archive";
  const raw = input.raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const mode = (raw as { mode?: unknown }).mode;
    if (mode === "post_hoc" || mode === "post-hoc") return "post_hoc";
    if (mode === "archive") return "archive";
  }
  return "live";
}

function parserQa(
  entries: Roll20ParseResult["qa"]["entries"],
  path: string,
  sessionRoot: string,
): QaEntry[] {
  return entries.map((entry) => ({
    code: "ROLL20_UNPARSED_MESSAGES",
    severity: "warning",
    message: entry.message,
    hint: `inspect ${slashRelative(sessionRoot, path)} and preserve the raw message for a parser update`,
  }));
}

function pipelineRollId(index: number): ManifestRoll["id"] {
  return `r${String(index + 1).padStart(4, "0")}`;
}

function mapRoll(roll: RollData, index: number, registry: Registry): ManifestRoll {
  const account = roll.player_id ?? roll.who;
  const playerId = account === null ? null : (byRoll20Account(registry, account)?.id ?? null);
  return {
    id: pipelineRollId(index),
    source_id: roll.id,
    seq: roll.seq,
    who: roll.who,
    roll20_player_id: roll.player_id,
    player_id: playerId,
    formula: roll.formula,
    dice: roll.dice.map((die) => ({
      sides: die.sides,
      value: die.value,
      dropped: die.dropped,
    })),
    modifiers: roll.modifiers,
    total: roll.total,
    kind: roll.kind,
    roll_kind: roll.roll_kind,
    advantage: roll.advantage,
    used: roll.used,
    used_result: roll.used_result,
    target: roll.target,
    npc_mentions: [...roll.npc_mentions],
    raw_ref: roll.raw_ref,
  };
}

function mapRolls(parsed: Roll20ParseResult, registry: Registry): ManifestRoll[] {
  return parsed.rolls.map((roll, index) => mapRoll(roll, index, registry));
}

function rollQa(rolls: readonly ManifestRoll[]): QaEntry[] {
  const byAccount = new Map<string, number>();
  for (const roll of rolls) {
    if (roll.player_id !== null) continue;
    const account = roll.who?.trim() || roll.roll20_player_id?.trim() || "(unknown account)";
    byAccount.set(account, (byAccount.get(account) ?? 0) + 1);
  }

  return [...byAccount.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([account, count]) => ({
      code: "ROLL20_ACCOUNT_UNMAPPED",
      severity: "error",
      message: `${String(count)} Roll20 roll${count === 1 ? "" : "s"} by "${account}" has no mapped player_id`,
      subject: account,
      hint: `add roll20.account_name: "${account}" to the matching player in campaign/players.json`,
    }));
}

function qaForMissingRoll20(path: string): QaEntry {
  return {
    code: "ROLL20_NO_CAPTURE",
    severity: "error",
    message: "no Roll20 capture was found",
    subject: path,
    hint: "put roll20-capture.json or a saved chat archive under input/roll20",
  };
}

/**
 * Run the intake stage and atomically write `work/01-intake/manifest.json`.
 * The callback owns all domain work; `runStage` owns skip/re-run metadata and
 * failure atomicity.
 */
export async function runIntakeStage(options: IntakeStageOptions): Promise<IntakeStageResult> {
  const { session } = options;
  const campaignRoot = options.campaignRoot ?? join(session.paths.root, "campaign");
  const inputs = await stageInputs(session, campaignRoot);

  return runStage(
    {
      session,
      stage: "intake",
      version: INTAKE_STAGE_VERSION,
      output: "manifest",
      inputs: inputs.paths,
      params: {
        alignment_tolerance_s: options.alignmentToleranceS ?? 2,
        prober: options.prober === undefined ? "default" : "custom",
        source_signature: inputs.signature,
      },
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.io === undefined ? {} : { io: options.io }),
    },
    async ({ progress }) => {
      progress(0.05, "loading campaign registry");
      const registry = await loadRegistry(campaignRoot);
      progress(0.2, "measuring Craig tracks");
      const craig = await craigIntake({
        sessionRoot: session.paths.root,
        registry,
        ...(options.prober === undefined ? {} : { prober: options.prober }),
        ...(options.alignmentToleranceS === undefined
          ? {}
          : { alignmentToleranceS: options.alignmentToleranceS }),
      });

      const qa: QaEntry[] = [...craig.qa];
      let rolls: ManifestRoll[] = [];
      const roll20 = await findRoll20Input(session.paths.root);
      let roll20Source: Manifest["roll20"] = null;
      if (roll20 === null) {
        qa.push(qaForMissingRoll20(join(session.paths.root, "input", "roll20")));
      } else {
        progress(0.65, "parsing Roll20 capture");
        const parsed = parseRoll20(roll20.raw);
        const timing = resolveRoll20Time(parsed.normalized, {
          started_at: craig.recording.started_at,
          duration_s: craig.recording.duration_s,
        });
        rolls = mapRolls(parsed, registry);
        qa.push(...parserQa(parsed.qa.entries, roll20.path, session.paths.root));
        qa.push(...timing.qa);
        qa.push(...rollQa(rolls));
        const clockOffset = timing.clock_offset_s;
        roll20Source = {
          path: slashRelative(session.paths.root, roll20.path),
          sha256: await hashFile(roll20.path),
          message_count: parsed.messages.length + parsed.turnorder_events.length,
          roll_count: rolls.length,
          capture_mode: captureMode(roll20),
          time_basis: timing.time_basis,
          ...(clockOffset === null ? {} : { clock_offset_s: clockOffset }),
        };
      }

      const manifest: Manifest = {
        session_id: session.descriptor.id,
        recording: craig.recording,
        tracks: craig.tracks,
        rolls,
        roll20: roll20Source,
        qa,
      };
      progress(0.95, "writing intake manifest");
      await writeArtifact(session, "manifest", manifest, options.io);
      progress(1, "intake complete");
      return manifest;
    },
  );
}

/** Short aliases for callers that name stages by their operation. */
export const intakeStage = runIntakeStage;
export const runIntake = runIntakeStage;
