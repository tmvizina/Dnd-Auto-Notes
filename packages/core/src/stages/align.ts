import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { alignRolls, projectSequence, type AlignRoll } from "../align/rollSpeech.js";
import type { Manifest } from "../contracts/manifest.js";
import type { Roll, Timeline, TurnOrderEvent } from "../contracts/timeline.js";
import type { Transcript } from "../contracts/utterances.js";
import { parseRoll20, resolveRoll20Time } from "../intake/roll20/index.js";
import type { Roll20TimeResolution } from "../intake/roll20/index.js";
import type { Roll20ParseResult } from "../intake/roll20/parser.js";
import type { FileIo } from "../session/io.js";
import { readArtifact, writeArtifact } from "../session/session.js";
import type { Session } from "../session/session.js";
import { runStage } from "../stage/runner.js";
import type { ProgressFn, StageResult } from "../stage/runner.js";

export const ALIGN_STAGE_VERSION = 1;

export interface AlignStageOptions {
  readonly session: Session;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressFn;
  readonly io?: FileIo;
}

interface Roll20Evidence {
  readonly parsed: Roll20ParseResult;
  readonly timing: Roll20TimeResolution;
}

function timelineRolls(
  manifest: Manifest,
  expectedBySequence: ReadonlyMap<number, number>,
): AlignRoll[] {
  return manifest.rolls
    .filter((roll) => roll.total !== null)
    .map((roll): AlignRoll => ({
      id: roll.id,
      seq: roll.seq,
      who: roll.who ?? "",
      player_id: roll.player_id,
      formula: roll.formula,
      dice: roll.dice.flatMap((die) =>
        die.sides === null ? [] : [{ sides: die.sides, value: die.value, dropped: die.dropped }],
      ),
      modifiers: roll.modifiers,
      total: roll.total ?? 0,
      kind: roll.roll_kind,
      advantage: roll.advantage,
      raw_ref: roll.raw_ref,
      expected_time_s: expectedBySequence.get(roll.seq) ?? null,
    }));
}

async function roll20Evidence(
  session: Session,
  manifest: Manifest,
): Promise<Roll20Evidence | null> {
  if (manifest.roll20 === null) return null;
  const path = join(session.paths.root, manifest.roll20.path);
  const text = await readFile(path, "utf8");
  const raw: unknown = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : text;
  const parsed = parseRoll20(raw);
  const timing = resolveRoll20Time(parsed.normalized, {
    started_at: manifest.recording.started_at,
    duration_s: manifest.recording.duration_s,
  });
  return { parsed, timing };
}

function expectedTimes(
  records: readonly { readonly seq: number; readonly t_audio_s: number | null }[],
) {
  const result = new Map<number, number>();
  for (const record of records) {
    if (record.t_audio_s !== null && !result.has(record.seq))
      result.set(record.seq, record.t_audio_s);
  }
  return result;
}

function alignedTurnorder(
  evidence: Roll20Evidence | null,
  fit: ReturnType<typeof alignRolls>["fit"],
): TurnOrderEvent[] {
  if (evidence === null) return [];
  const expectedBySequence = expectedTimes(evidence.timing.turnorder_events);
  return evidence.parsed.turnorder_events
    .map((event): TurnOrderEvent => {
      const entries = event.entries.flatMap((entry) =>
        entry.value === null || entry.name.trim() === ""
          ? []
          : [
              {
                name: entry.name,
                value: entry.value,
                ...(entry.token_id === null ? {} : { token_id: entry.token_id }),
              },
            ],
      );
      const projected = projectSequence(event.seq, fit, expectedBySequence.get(event.seq));
      return {
        seq: event.seq,
        t_audio_s: projected.t_audio_s,
        entries,
        marker: event.marker,
      };
    })
    .sort((left, right) => left.seq - right.seq);
}

/** Build the shared audio-time timeline for rolls and turn-order transitions. */
export async function runAlignStage(options: AlignStageOptions): Promise<StageResult<Timeline>> {
  const manifest = (await readArtifact(options.session, "manifest")) as Manifest;
  const transcript = (await readArtifact(options.session, "transcript")) as Transcript;
  const roll20Path =
    manifest.roll20 === null ? null : join(options.session.paths.root, manifest.roll20.path);
  const inputs = [
    options.session.paths.artifact("manifest"),
    options.session.paths.artifact("transcript"),
    ...(roll20Path === null ? [] : [roll20Path]),
  ];
  return runStage(
    {
      session: options.session,
      stage: "align",
      version: ALIGN_STAGE_VERSION,
      output: "timeline",
      inputs,
      params: { time_basis: manifest.roll20?.time_basis ?? "order_only" },
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.io === undefined ? {} : { io: options.io }),
    },
    async ({ progress, signal }) => {
      progress(0.1, "reading Roll20 timing evidence");
      if (signal?.aborted) throw new Error("alignment cancelled");
      const evidence = await roll20Evidence(options.session, manifest);
      const expectedBySequence = expectedTimes(evidence?.timing.messages ?? []);
      const rolls = timelineRolls(manifest, expectedBySequence);
      progress(0.35, "matching rolls to speech");
      const aligned = alignRolls(rolls, transcript.utterances, {
        timeBasis: manifest.roll20?.time_basis ?? "order_only",
      });
      const timeline: Timeline = {
        rolls: rolls.map((roll): Roll => ({
          id: roll.id,
          seq: roll.seq,
          who: roll.who,
          player_id: roll.player_id,
          formula: roll.formula,
          dice: [...roll.dice],
          modifiers: roll.modifiers,
          total: roll.total,
          kind: roll.kind,
          advantage: roll.advantage,
          ...(roll.raw_ref === undefined ? {} : { raw_ref: roll.raw_ref }),
        })),
        anchors: [...aligned.anchors],
        turnorder: alignedTurnorder(evidence, aligned.fit),
        quality: aligned.quality,
      };
      progress(0.9, "writing alignment quality report");
      if (signal?.aborted) throw new Error("alignment cancelled");
      await writeArtifact(options.session, "timeline", timeline, options.io);
      progress(1, "alignment complete");
      return timeline;
    },
  );
}

export const alignStage = runAlignStage;
