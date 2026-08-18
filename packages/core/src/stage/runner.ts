import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { StageMeta } from "../contracts/stageMeta.js";
import type { ArtifactName } from "../contracts/artifacts.js";
import type { Session } from "../session/session.js";
import type { FileIo } from "../session/io.js";
import { writeJsonAtomic } from "../session/io.js";
import { hashFileIfPresent, hashParams } from "./hash.js";

export type ProgressFn = (fraction: number, message: string) => void;

export interface StageContext {
  readonly session: Session;
  readonly progress: ProgressFn;
}

export interface RunStageOptions {
  session: Session;
  /** Stage name, matching its StageRegistry key. */
  stage: string;
  /** Bump when the stage's output shape or algorithm changes. */
  version: number;
  /** The artifact this stage produces; its `_stage.json` sits beside it. */
  output: ArtifactName;
  /** Absolute paths whose contents decide whether a re-run is needed. */
  inputs: readonly string[];
  params?: unknown;
  force?: boolean;
  onProgress?: ProgressFn;
  io?: FileIo;
}

export interface StageResult<T> {
  readonly stage: string;
  readonly skipped: boolean;
  readonly meta: StageMeta;
  /** Undefined on a skip — the artifact on disk is already correct. */
  readonly value: T | undefined;
}

async function readExistingMeta(path: string): Promise<StageMeta | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = StageMeta.safeParse(JSON.parse(await readFile(path, "utf8")) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    // Unreadable meta means "we don't know", which means re-run. Never fatal.
    return null;
  }
}

function sameInputs(previous: StageMeta, current: Record<string, string>): boolean {
  const previousKeys = Object.keys(previous.inputs).sort();
  const currentKeys = Object.keys(current).sort();
  if (previousKeys.length !== currentKeys.length) return false;
  return previousKeys.every(
    (key, i) => key === currentKeys[i] && previous.inputs[key] === current[key],
  );
}

/**
 * Runs a stage unless nothing it depends on has changed.
 *
 * Skipping is an optimisation, never a refusal: `force` always re-runs, and a
 * missing or unreadable `_stage.json` means re-run rather than error. A stage
 * that throws leaves the previous artifact exactly where it was and records the
 * failure, so a broken run never destroys a good result.
 */
export async function runStage<T>(
  options: RunStageOptions,
  fn: (context: StageContext) => Promise<T>,
): Promise<StageResult<T>> {
  const { session, stage, version, output, inputs, params, force = false, io } = options;
  const progress: ProgressFn = options.onProgress ?? (() => undefined);

  const metaPath = session.paths.stageMeta(output);
  const artifactPath = session.paths.artifact(output);

  const inputHashes: Record<string, string> = {};
  for (const input of inputs) {
    const digest = await hashFileIfPresent(input);
    // A declared-but-absent input is recorded as such: its later appearance
    // must count as a change.
    inputHashes[relative(session.paths.root, input).replaceAll("\\", "/")] =
      digest ?? "0".repeat(64);
  }
  const paramsHash = hashParams(params ?? {});

  const previous = await readExistingMeta(metaPath);
  const reusable =
    !force &&
    previous !== null &&
    previous.status === "ok" &&
    previous.version === version &&
    previous.params_hash === paramsHash &&
    sameInputs(previous, inputHashes) &&
    existsSync(artifactPath);

  if (reusable && previous !== null) {
    return { stage, skipped: true, meta: previous, value: undefined };
  }

  const startedAt = new Date();
  try {
    const value = await fn({ session, progress });
    const finishedAt = new Date();
    const meta: StageMeta = {
      stage,
      version,
      status: "ok",
      inputs: inputHashes,
      params_hash: paramsHash,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_s: (finishedAt.getTime() - startedAt.getTime()) / 1000,
      counts: {},
    };
    // Meta is written last: if it exists and says ok, the artifact beside it is
    // complete. The reverse order would let a crash advertise a partial result.
    await writeJsonAtomic(metaPath, meta, io);
    return { stage, skipped: false, meta, value };
  } catch (error) {
    const finishedAt = new Date();
    const meta: StageMeta = {
      stage,
      version,
      status: "error",
      inputs: inputHashes,
      params_hash: paramsHash,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_s: (finishedAt.getTime() - startedAt.getTime()) / 1000,
      counts: {},
      error: error instanceof Error ? error.message : String(error),
    };
    await writeJsonAtomic(metaPath, meta, io).catch(() => undefined);
    throw error;
  }
}
