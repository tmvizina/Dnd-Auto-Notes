import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildIntakeQaReport,
  StageMeta,
  createSession,
  planStages,
  qaExitCode,
  readArtifact,
  readIntakeQaReport,
  renderQaTable,
  resolveSession,
  runIntakeStage,
  stageNames,
} from "@dnd/core";
import type { QaReport, Session, StageResult } from "@dnd/core";
import { formatConfig, resolveConfig } from "./config.js";
import { PLANNED_COMMANDS, USAGE } from "./usage.js";
import { labelSession, LabelUsageError, type LabelChoiceInput } from "./commands/label.js";
import {
  appendCalibrationDoc,
  calibrate,
  measureProfileAccuracy,
  profilePartitions,
  readLabels,
  readProfiles,
  seedMissingProfiles,
  writeCalibration,
} from "@dnd/core";

export const CLI_VERSION = "0.1.0";

export interface Outcome {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface ProgressEvent {
  readonly event: "progress";
  readonly terminal: false;
  readonly stage: string;
  readonly fraction: number;
  readonly message: string;
}

export interface RunOptions {
  /** Set by the executable; tests can force either rendering mode. */
  readonly isTTY?: boolean;
  /** Receives live progress lines when plain output is attached to a TTY. */
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly labelPrompt?: (item: LabelChoiceInput) => Promise<{
    mode: "in_character" | "out_of_character" | "narration" | "uncertain";
    character_id: string | null;
  }>;
  readonly labelPlayer?: (clip: LabelChoiceInput["clip"]) => Promise<void>;
  readonly now?: () => string;
}

export function playLabelClip(
  clip: LabelChoiceInput["clip"],
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  if (!existsSync(clip.path))
    return Promise.reject(new Error(`audio clip not found: ${clip.path}`));
  const duration = clip.end_s - clip.start_s;
  if (
    !Number.isFinite(clip.start_s) ||
    !Number.isFinite(duration) ||
    clip.start_s < 0 ||
    duration <= 0
  )
    return Promise.reject(new Error("audio clip bounds are invalid"));
  const command = "ffplay";
  const args = [
    "-nodisp",
    "-autoexit",
    "-ss",
    String(clip.start_s),
    "-t",
    String(duration),
    clip.path,
  ];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: "ignore", windowsHide: true });
    let settled = false;
    let terminating = false;
    const timeout: NodeJS.Timeout = setTimeout(() => {
      if (settled) return;
      terminating = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
      hardTimer = setTimeout(
        () => finish(new Error("audio player timed out and was terminated")),
        2_000,
      );
      hardTimer.unref();
    }, 30_000);
    let killTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (code: number | null): void => {
      if (terminating) {
        finish(new Error("audio player timed out and was terminated"));
      } else if (code === 0) finish();
      else finish(new Error(`audio player exited with ${String(code)}`));
    };
    timeout.unref();
    child.once("error", onError);
    child.once("close", onClose);
  });
}

export function platformLabelPlayer(clip: LabelChoiceInput["clip"]): Promise<void> {
  return playLabelClip(clip);
}

function interactiveLabelPrompt(): {
  readonly choose: NonNullable<RunOptions["labelPrompt"]>;
  readonly close: () => void;
} {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const choose = async (item: LabelChoiceInput) => {
    const answer = await readline.question(
      `\n${item.utterance_id} [${item.clip.path} ${item.clip.start_s}-${item.clip.end_s}s]\nmode (i/o/n/u), optional character id: `,
    );
    const [modeCode, character] = answer.trim().toLowerCase().split(/\s+/u);
    const modes = {
      i: "in_character",
      o: "out_of_character",
      n: "narration",
      u: "uncertain",
    } as const;
    const mode = modeCode === undefined ? undefined : modes[modeCode as keyof typeof modes];
    if (mode === undefined) throw new LabelUsageError("mode must be i, o, n, or u");
    return { mode, character_id: mode === "in_character" ? (character ?? null) : null };
  };
  return { choose, close: () => readline.close() };
}

interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs | string {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = equals < 0 ? argument.slice(2) : argument.slice(2, equals);
      if (name === "") return "empty option name";
      if (equals >= 0) {
        values.set(name, argument.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        values.set(name, next);
        index += 1;
      } else {
        flags.add(name);
      }
      continue;
    }
    if (argument.startsWith("-") && argument !== "-") return `unknown option ${argument}`;
    positionals.push(argument);
  }
  return { values, flags, positionals };
}

function option(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.values.get(name);
}

function has(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name) || parsed.values.has(name);
}

function validateOptions(
  parsed: ParsedArgs,
  values: readonly string[],
  flags: readonly string[],
): string | null {
  const allowedValues = new Set(values);
  const allowedFlags = new Set(flags);
  for (const name of parsed.values.keys()) {
    if (!allowedValues.has(name)) return `unknown option --${name}`;
  }
  for (const name of parsed.flags) {
    if (!allowedFlags.has(name)) return `unknown option --${name}`;
  }
  return null;
}

function usageError(message: string, json = false): Outcome {
  if (json) {
    return {
      stdout: `${JSON.stringify({ event: "run", terminal: true, status: "error", exit_code: 2, error: message })}\n`,
      exitCode: 2,
    };
  }
  return { stdout: `Error: ${message}\n\n${USAGE}`, exitCode: 2 };
}

function isPathValue(value: string): boolean {
  return (
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function requestedSession(parsed: ParsedArgs, cwd: string): string | null {
  if (has(parsed, "latest")) return "latest";
  const value = option(parsed, "session");
  if (value === undefined || value.trim() === "") return null;
  return isPathValue(value) ? resolve(cwd, value) : value;
}

async function resolveRequestedSession(
  parsed: ParsedArgs,
  cwd: string,
  json = false,
): Promise<
  { readonly session: Session; readonly config: ReturnType<typeof resolveConfig> } | Outcome
> {
  const config = resolveConfig(cwd);
  const idOrPath = requestedSession(parsed, cwd);
  if (idOrPath === null) {
    return usageError("--session <id|folder> or --latest is required", json);
  }
  let session = await resolveSession(config.sessionsRoot.value, idOrPath);
  // A bare folder name is ambiguous with a session id. Prefer the configured
  // sessions root, then accept a folder relative to the caller's cwd when the
  // id lookup did not find anything.
  if (session === null && idOrPath !== "latest" && !isAbsolute(idOrPath)) {
    session = await resolveSession(config.sessionsRoot.value, resolve(cwd, idOrPath));
  }
  if (session === null) {
    if (json) return usageError(`session not found: ${idOrPath}`, true);
    return {
      stdout: `Session not found: ${idOrPath}\n`,
      exitCode: 1,
    };
  }
  return { session, config };
}

function campaignRootFor(session: Session, configured: string): string {
  const besideSession = join(session.paths.root, "campaign");
  return existsSync(join(besideSession, "campaign.json")) ||
    existsSync(join(besideSession, "players.json"))
    ? besideSession
    : configured;
}

function stageDuration(result: StageResult<unknown>): string {
  return `${result.meta.duration_s.toFixed(3)}s`;
}

function stageEvent(result: StageResult<unknown>): Record<string, unknown> {
  return {
    event: "stage",
    terminal: false,
    stage: result.stage,
    status: result.skipped ? "skipped" : result.meta.status,
    duration_s: result.meta.duration_s,
    finished_at: result.meta.finished_at,
  };
}

function progressEvent(stage: string, fraction: number, message: string): ProgressEvent {
  return { event: "progress", terminal: false, stage, fraction, message };
}

export function formatProgress(event: ProgressEvent): string {
  const percent = Math.round(event.fraction * 100);
  return `${event.stage}: ${String(percent)}% ${event.message}`;
}

async function readQaForSession(session: Session): Promise<QaReport> {
  try {
    return await readIntakeQaReport(session);
  } catch {
    // A session created by an older build may have a manifest but no separate
    // QA artifact. Reconstructing it keeps `pipeline qa` useful and does not
    // invent active-session membership.
    const manifest = await readArtifact(session, "manifest");
    return buildIntakeQaReport({ manifest });
  }
}

function qaExit(report: QaReport): 0 | 2 {
  return qaExitCode(report);
}

function plainQa(session: Session, report: QaReport): string {
  return `QA for ${session.descriptor.id}\n${renderQaTable(report)}`;
}

function jsonQa(session: Session, report: QaReport): string {
  return `${JSON.stringify({
    event: "qa",
    terminal: true,
    session_id: session.descriptor.id,
    stage: report.stage,
    entries: report.entries,
    metrics: report.metrics,
    exit_code: qaExit(report),
  })}\n`;
}

async function runPipeline(parsed: ParsedArgs, cwd: string, options: RunOptions): Promise<Outcome> {
  const json = has(parsed, "json");
  for (const name of ["session", "stage", "from"] as const) {
    if (parsed.flags.has(name)) return usageError(`--${name} requires a value`, json);
  }
  const resolved = await resolveRequestedSession(parsed, cwd, json);
  if ("exitCode" in resolved) return resolved;
  const { session, config } = resolved;
  const requestedStage = option(parsed, "stage");
  const from = option(parsed, "from");
  if (requestedStage !== undefined && requestedStage !== "all" && from !== undefined) {
    return usageError("--stage and --from cannot be combined", json);
  }
  const only =
    requestedStage === undefined || requestedStage === "all" ? undefined : requestedStage;
  const plan = planStages({
    ...(only === undefined ? {} : { only }),
    ...(from === undefined ? {} : { from }),
  });
  if (plan.length === 0) {
    return usageError(
      `unknown stage ${requestedStage ?? from ?? "(none)"}; choose one of ${stageNames().join(", ")}`,
      json,
    );
  }

  const events: Record<string, unknown>[] = [];
  const plain: string[] = [];
  let report: QaReport | undefined;
  let currentStage = "intake";
  try {
    for (const definition of plan) {
      currentStage = definition.name;
      if (definition.name !== "intake") {
        throw new Error(`stage ${definition.name} is not implemented yet`);
      }
      const result = await runIntakeStage({
        session,
        campaignRoot: campaignRootFor(session, config.campaignRoot.value),
        databasePath: config.databasePath.value,
        force: has(parsed, "force"),
        onProgress: (fraction, message) => {
          const event = progressEvent(definition.name, fraction, message);
          if (json) {
            events.push({ ...event });
          } else if (options.isTTY === true) {
            if (options.onProgress === undefined) plain.push(formatProgress(event));
            else options.onProgress(event);
          }
        },
      });
      events.push(stageEvent(result));
      plain.push(
        `${result.stage}: ${result.skipped ? "skipped" : result.meta.status} (${stageDuration(result)})`,
      );
      report = await readQaForSession(session);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      events.push({
        event: "stage",
        terminal: false,
        stage: currentStage,
        status: "error",
        error: message,
      });
      events.push({ event: "run", terminal: true, status: "error", exit_code: 1, error: message });
      return {
        stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        exitCode: 1,
      };
    }
    plain.push(`error: ${message}`);
    return { stdout: `${plain.join("\n")}\n`, exitCode: 1 };
  }

  const qaCode = report === undefined ? 0 : qaExit(report);
  if (json) {
    events.push({
      event: "run",
      terminal: true,
      status: qaCode === 0 ? "ok" : "qa_error",
      exit_code: qaCode,
      session_id: session.descriptor.id,
      qa_errors: report?.entries.filter((entry) => entry.severity === "error").length ?? 0,
      qa: report?.entries ?? [],
    });
    return {
      stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      exitCode: qaCode,
    };
  }
  if (report !== undefined) plain.push(renderQaTable(report).trimEnd());
  plain.push(qaCode === 0 ? "run: completed" : "run: completed with QA errors");
  return { stdout: `${plain.join("\n")}\n`, exitCode: qaCode };
}

async function newSession(parsed: ParsedArgs, cwd: string): Promise<Outcome> {
  const title = parsed.positionals.join(" ").trim();
  if (title === "") return usageError("session new requires a title");
  for (const name of ["date", "number"] as const) {
    if (parsed.flags.has(name)) return usageError(`--${name} requires a value`);
  }
  const date = option(parsed, "date");
  const numberValue = option(parsed, "number");
  let number: number | null = null;
  if (numberValue !== undefined) {
    number = Number.parseInt(numberValue, 10);
    if (!Number.isInteger(number) || number <= 0)
      return usageError("--number must be a positive integer");
  }
  const config = resolveConfig(cwd);
  const session = await createSession(config.sessionsRoot.value, {
    title,
    ...(date === undefined ? {} : { date }),
    number,
  });
  await mkdir(session.paths.input("craig"), { recursive: true });
  await mkdir(session.paths.input("roll20"), { recursive: true });
  await mkdir(session.paths.media("clips"), { recursive: true });
  return {
    stdout: [
      `Created session ${session.descriptor.id}`,
      `Drop Craig audio under ${session.paths.input("craig")}`,
      `Drop the Roll20 capture under ${session.paths.input("roll20")}`,
      "",
    ].join("\n"),
    exitCode: 0,
  };
}

async function status(parsed: ParsedArgs, cwd: string): Promise<Outcome> {
  const resolved = await resolveRequestedSession(parsed, cwd, has(parsed, "json"));
  if ("exitCode" in resolved) return resolved;
  const { session } = resolved;
  const json = has(parsed, "json");
  const rows: Array<Record<string, unknown>> = [];
  const plain = [`Status for ${session.descriptor.id}`];
  for (const name of stageNames()) {
    const definition = planStages({ only: name })[0];
    if (definition === undefined) continue;
    const metaPath = session.paths.stageMeta(definition.output);
    let meta: StageMeta | null = null;
    if (existsSync(metaPath)) {
      try {
        meta = StageMeta.parse(JSON.parse(await readFile(metaPath, "utf8")) as unknown);
      } catch {
        meta = null;
      }
    }
    const row = {
      stage: name,
      status: meta?.status ?? "pending",
      inputs: meta?.inputs ?? {},
      last_run: meta?.finished_at ?? null,
      duration_s: meta?.duration_s ?? null,
    };
    rows.push(row);
    const hashes = Object.entries(row.inputs)
      .map(([path, digest]) => `${path}=${digest}`)
      .join(", ");
    plain.push(
      `  ${name}: ${row.status} last=${row.last_run ?? "never"}${hashes === "" ? "" : ` hashes=${hashes}`}`,
    );
  }
  if (json) {
    return {
      stdout: `${JSON.stringify({ event: "status", terminal: true, session_id: session.descriptor.id, stages: rows })}\n`,
      exitCode: 0,
    };
  }
  return { stdout: `${plain.join("\n")}\n`, exitCode: 0 };
}

async function qa(parsed: ParsedArgs, cwd: string): Promise<Outcome> {
  const resolved = await resolveRequestedSession(parsed, cwd, has(parsed, "json"));
  if ("exitCode" in resolved) return resolved;
  try {
    const report = await readQaForSession(resolved.session);
    const exitCode = qaExit(report);
    return {
      stdout: has(parsed, "json")
        ? jsonQa(resolved.session, report)
        : plainQa(resolved.session, report),
      exitCode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (has(parsed, "json")) {
      return {
        stdout: `${JSON.stringify({
          event: "qa",
          terminal: true,
          status: "error",
          session_id: resolved.session.descriptor.id,
          exit_code: 1,
          error: message,
        })}\n`,
        exitCode: 1,
      };
    }
    return {
      stdout: `Unable to read intake QA: ${message}\n`,
      exitCode: 1,
    };
  }
}

/**
 * Async command entry point. Filesystem-backed commands intentionally return a
 * promise so the thin bin can keep stdout and exit-code ownership in one place.
 */
export async function run(
  argv: readonly string[],
  cwd: string = process.cwd(),
  options: RunOptions = {},
): Promise<Outcome> {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    return { stdout: USAGE, exitCode: 0 };
  }
  if (first === "--version" || first === "-v") {
    return { stdout: `${CLI_VERSION}\n`, exitCode: 0 };
  }
  if (first === "config") {
    const parsed = parseArgs(rest);
    if (typeof parsed === "string") return usageError(parsed);
    const invalid = validateOptions(parsed, [], []);
    if (invalid !== null || parsed.positionals.length > 0)
      return usageError(invalid ?? "config does not accept arguments");
    return { stdout: `${formatConfig(resolveConfig(cwd))}\n`, exitCode: 0 };
  }
  const planned = PLANNED_COMMANDS.get(first);
  if (first === "label") {
    const parsed = parseArgs(rest);
    if (typeof parsed === "string") return usageError(parsed);
    const invalid = validateOptions(
      parsed,
      ["session", "strategy", "minutes", "labeller"],
      ["latest", "relabel"],
    );
    if (invalid !== null || parsed.positionals.length > 0)
      return usageError(invalid ?? "label does not accept positional arguments");
    const strategyValue = option(parsed, "strategy");
    if (parsed.flags.has("strategy")) return usageError("--strategy requires a value");
    if (
      strategyValue !== undefined &&
      !["uncertain", "stratified", "sequential"].includes(strategyValue)
    )
      return usageError("--strategy must be uncertain, stratified, or sequential");
    const strategy = strategyValue as "uncertain" | "stratified" | "sequential" | undefined;
    const minutesValue = option(parsed, "minutes");
    if (parsed.flags.has("minutes")) return usageError("--minutes requires a value");
    const minutes = minutesValue === undefined ? 15 : Number(minutesValue);
    if (!Number.isFinite(minutes) || minutes <= 0)
      return usageError("--minutes must be a positive finite number");
    const resolved = await resolveRequestedSession(parsed, cwd);
    if ("exitCode" in resolved) return resolved;
    const labeller = option(parsed, "labeller");
    const interactive =
      options.labelPrompt === undefined
        ? interactiveLabelPrompt()
        : { choose: options.labelPrompt, close: () => undefined };
    try {
      const result = await labelSession({
        session: resolved.session,
        campaignRoot: campaignRootFor(resolved.session, resolved.config.campaignRoot.value),
        ...(strategy === undefined ? {} : { strategy }),
        limit: Math.max(1, Math.floor(minutes * 3)),
        ...(labeller === undefined ? {} : { labeller }),
        relabel: has(parsed, "relabel"),
        choose: interactive.choose,
        play: options.labelPlayer ?? platformLabelPlayer,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      return {
        stdout: `label: selected ${result.selected}, skipped ${result.skipped}\n${result.path}\n`,
        exitCode: 0,
      };
    } catch (error) {
      if (error instanceof LabelUsageError) return usageError(error.message);
      return {
        stdout: `label: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    } finally {
      interactive.close();
    }
  }
  if (first === "calibrate") {
    const parsed = parseArgs(rest);
    if (typeof parsed === "string") return usageError(parsed);
    const invalid = validateOptions(parsed, ["campaign"], []);
    if (invalid !== null || parsed.positionals.length > 0)
      return usageError(invalid ?? "calibrate does not accept positional arguments");
    if (parsed.flags.has("campaign")) return usageError("--campaign requires a value");
    const campaign = option(parsed, "campaign") ?? resolveConfig(cwd).campaignRoot.value;
    const labels = await readLabels(join(campaign, "labels", "all.jsonl"));
    try {
      const profiles = (
        await Promise.all(
          [
            ...new Set(
              labels
                .map((label) => label.player_id)
                .filter((player): player is string => player !== undefined && player !== null),
            ),
          ]
            .sort()
            .map((player) => readProfiles(join(campaign, "profiles"), player)),
        )
      ).flat();
      const partitions = profilePartitions(labels);
      await seedMissingProfiles(
        join(campaign, "profiles"),
        partitions.training.flatMap((label) =>
          label.player_id === undefined || label.player_id === null || label.embedding === undefined
            ? []
            : [
                {
                  player_id: label.player_id,
                  character_id: label.character_id,
                  embedding: label.embedding,
                  session_id: label.session_id ?? "unknown",
                },
              ],
        ),
      );
      const report = calibrate(labels, undefined, profiles);
      const persistedProfiles = (
        await Promise.all(
          [
            ...new Set(
              partitions.training
                .map((label) => label.player_id)
                .filter((player): player is string => player != null),
            ),
          ]
            .sort()
            .map((player) => readProfiles(join(campaign, "profiles"), player)),
        )
      ).flat();
      const persistedAccuracy = measureProfileAccuracy(partitions.held_out, persistedProfiles);
      if (
        persistedAccuracy.evaluated !== report.profile_accuracy_after.evaluated ||
        persistedAccuracy.accuracy !== report.profile_accuracy_after.accuracy
      )
        throw new Error("persisted profile bank does not match held-out calibration accuracy");
      const now = options.now ?? (() => new Date().toISOString());
      const path = await writeCalibration(join(campaign, "calibration"), report, now);
      await appendCalibrationDoc(join(cwd, "docs", "calibration.md"), report, now(), campaign);
      return {
        stdout: `calibrate: ${report.label_count} labels accuracy=${report.accuracy.toFixed(4)} profile=${(report.profile_accuracy_after.accuracy ?? 0).toFixed(4)}\n${path}\n`,
        exitCode: 0,
      };
    } catch (error) {
      return {
        stdout: `calibrate: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 2,
      };
    }
  }
  if (planned !== undefined) {
    return {
      stdout: `pipeline ${first} ${rest.join(" ")} is not implemented yet - it lands in ticket ${planned}.\n`,
      exitCode: 1,
    };
  }

  if (first === "session") {
    if (rest.includes("--help") || rest.includes("-h")) return { stdout: USAGE, exitCode: 0 };
    if (rest[0] !== "new") return usageError("use pipeline session new <title>");
    const parsed = parseArgs(rest.slice(1));
    if (typeof parsed === "string") return usageError(parsed);
    const invalid = validateOptions(parsed, ["date", "number"], []);
    if (invalid !== null) return usageError(invalid);
    return newSession(parsed, cwd);
  }
  if (first === "run" || first === "status" || first === "qa") {
    if (rest.includes("--help") || rest.includes("-h")) return { stdout: USAGE, exitCode: 0 };
    const parsed = parseArgs(rest);
    if (typeof parsed === "string") return usageError(parsed, rest.includes("--json"));
    const invalid = validateOptions(
      parsed,
      first === "run" ? ["session", "stage", "from"] : ["session"],
      first === "run" ? ["latest", "force", "json"] : ["latest", "json"],
    );
    if (invalid !== null) return usageError(invalid, has(parsed, "json"));
    for (const name of ["session", "stage", "from"] as const) {
      if (parsed.flags.has(name))
        return usageError(`--${name} requires a value`, has(parsed, "json"));
    }
    if (first === "run") return runPipeline(parsed, cwd, options);
    if (first === "status") return status(parsed, cwd);
    return qa(parsed, cwd);
  }
  return { stdout: `Unknown command: ${first}\n\n${USAGE}`, exitCode: 2 };
}
