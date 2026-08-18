import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Features as FeaturesArtifact, Prosody } from "../contracts/features.js";
import type { Utterance } from "../contracts/utterances.js";
import { SidecarClient } from "../sidecar/client.js";
import type { RunJobOptions } from "../sidecar/client.js";
import { nodeIo } from "../session/io.js";
import type { FileIo } from "../session/io.js";
import { readArtifact, writeArtifact } from "../session/session.js";
import type { Session } from "../session/session.js";
import { runStage } from "../stage/runner.js";
import type { ProgressFn, StageResult } from "../stage/runner.js";

export const FEATURES_STAGE_VERSION = 1;
export const MIN_FEATURE_DURATION_S = 0.6;
export const DEFAULT_FAKE_DIMENSION = 16;
const PROSODY_FIELDS: readonly (keyof Prosody)[] = [
  "f0_mean",
  "f0_std",
  "f0_range",
  "rate_wps",
  "intensity_mean",
  "intensity_std",
  "spectral_tilt",
  "jitter_proxy",
  "pause_ratio",
];

export interface FeaturesSidecar {
  runJob<T>(
    kind: string,
    payload: unknown,
    options?: Pick<RunJobOptions, "onProgress">,
  ): Promise<T>;
}

export interface FeaturesStageOptions {
  readonly session: Session;
  readonly sidecar?: FeaturesSidecar;
  readonly sidecarClient?: FeaturesSidecar;
  readonly client?: FeaturesSidecar;
  readonly sidecarUrl?: string;
  readonly backend?: string;
  readonly model?: string;
  readonly minDurationS?: number;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly force?: boolean;
  readonly onProgress?: ProgressFn;
  readonly io?: FileIo;
}

export type FeaturesStageResult = StageResult<FeaturesArtifact>;

interface SidecarRow {
  readonly utterance_id?: unknown;
  readonly player_id?: unknown;
  readonly embedding?: unknown;
  readonly prosody?: unknown;
  readonly prosody_z?: unknown;
  readonly features?: unknown;
  readonly [key: string]: unknown;
}

interface SidecarResponse {
  readonly backend?: unknown;
  readonly dimension?: unknown;
  readonly rows: readonly SidecarRow[];
}

interface WorkingRow {
  readonly utterance_id: string;
  readonly player_id: string;
  readonly embedding: readonly number[] | null;
  readonly prosody: Prosody | null;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function response(value: unknown): SidecarResponse {
  const object = objectValue(value, "features");
  const rawRows = object["rows"];
  if (!Array.isArray(rawRows)) throw new TypeError("features response has no rows array");
  const rows = rawRows.map((row, index) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError(`features row ${String(index)} must be an object`);
    }
    return row as SidecarRow;
  });
  return {
    backend: object["backend"],
    dimension: object["dimension"],
    rows,
  };
}

function prosody(value: unknown, label: string): Prosody | null {
  if (value === null || value === undefined) return null;
  const object = objectValue(value, label);
  const output = {} as Record<keyof Prosody, number>;
  for (const field of PROSODY_FIELDS) output[field] = finite(object[field], `${label}.${field}`);
  return output;
}

function embedding(value: unknown, label: string): readonly number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError(`${label} must be a non-empty array`);
  return value.map((item, index) => finite(item, `${label}[${String(index)}]`));
}

function sidecarRows(result: SidecarResponse, utterances: readonly Utterance[]): WorkingRow[] {
  const byId = new Map<string, SidecarRow>();
  for (const row of result.rows) {
    const id = row["utterance_id"];
    if (typeof id !== "string" || id === "")
      throw new TypeError("features row has no utterance_id");
    if (byId.has(id)) throw new Error(`features response repeats utterance ${id}`);
    byId.set(id, row);
  }
  return utterances.map((utterance) => {
    if (utterance.player_id === null) {
      throw new Error(
        `utterance ${utterance.id} has no player_id; refusing to infer feature ownership`,
      );
    }
    const row = byId.get(utterance.id);
    if (row === undefined) throw new Error(`features response omitted utterance ${utterance.id}`);
    const nested = row["features"];
    const nestedObject =
      nested !== null && typeof nested === "object" && !Array.isArray(nested)
        ? (nested as Record<string, unknown>)
        : undefined;
    const rawEmbedding = row["embedding"] ?? nestedObject?.["embedding"];
    const rawProsody = row["prosody"] ?? nestedObject?.["prosody"];
    return {
      utterance_id: utterance.id,
      player_id: utterance.player_id,
      embedding: embedding(rawEmbedding, `${utterance.id}.embedding`),
      prosody: prosody(rawProsody, `${utterance.id}.prosody`),
    };
  });
}

function zscore(rows: readonly WorkingRow[]): Map<string, Prosody | null> {
  const values = new Map<string, Prosody[]>();
  for (const row of rows) {
    if (row.prosody === null) continue;
    values.set(row.player_id, [...(values.get(row.player_id) ?? []), row.prosody]);
  }
  const result = new Map<string, Prosody | null>();
  for (const row of rows) {
    if (row.prosody === null) {
      result.set(row.utterance_id, null);
      continue;
    }
    const baseline = values.get(row.player_id) ?? [];
    const output = {} as Record<keyof Prosody, number>;
    for (const field of PROSODY_FIELDS) {
      const numbers = baseline.map((item) => item[field]);
      const mean = numbers.reduce((total, value) => total + value, 0) / numbers.length;
      const variance =
        numbers.reduce((total, value) => total + (value - mean) ** 2, 0) / numbers.length;
      const standardDeviation = Math.sqrt(variance);
      output[field] =
        standardDeviation <= 1e-12 ? 0 : (row.prosody[field] - mean) / standardDeviation;
    }
    result.set(row.utterance_id, output);
  }
  return result;
}

function trackPath(session: Session, path: string): string {
  return join(session.paths.root, ...path.split(/[\\/]+/u));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function progressFor(
  progress: ProgressFn,
  trackIndex: number,
  trackCount: number,
): (fraction: number, message: string) => void {
  return (fraction, message) => {
    const overall = (trackIndex + Math.max(0, Math.min(1, fraction))) / Math.max(1, trackCount);
    progress(overall, message);
  };
}

async function writeBinaryAtomic(
  path: string,
  data: Uint8Array,
  io: FileIo = nodeIo,
): Promise<void> {
  const directory = dirname(path);
  await io.mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${path.split(/[\\/]/u).at(-1) ?? "features.bin"}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await io.writeFile(temporary, data);
    await io.rename(temporary, path);
  } catch (error) {
    await io.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Read one little-endian float32 vector from a features blob. */
export async function readFeatureEmbedding(
  path: string,
  offset: number,
  dimension: number,
): Promise<number[]> {
  const bytes = await readFile(path);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(dimension) || dimension <= 0) {
    throw new RangeError("offset and dimension must be positive integers");
  }
  const end = offset + dimension * 4;
  if (end > bytes.length) throw new RangeError("feature vector exceeds blob bounds");
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, dimension * 4);
  return Array.from({ length: dimension }, (_, index) => view.getFloat32(index * 4, true));
}

/** Run the features sidecar job for each track and persist JSON plus float32 blob. */
export async function runFeaturesStage(
  options: FeaturesStageOptions,
): Promise<FeaturesStageResult> {
  const sidecar =
    options.sidecar ??
    options.sidecarClient ??
    options.client ??
    new SidecarClient(options.sidecarUrl ?? "http://127.0.0.1:8477");
  const manifest = await readArtifact(options.session, "manifest");
  const transcript = await readArtifact(options.session, "transcript");
  const tracks = [...manifest.tracks].sort((left, right) =>
    compareStrings(left.track_id, right.track_id),
  );
  const utterancesByTrack = new Map<string, Utterance[]>();
  for (const utterance of transcript.utterances) {
    const list = utterancesByTrack.get(utterance.track_id) ?? [];
    list.push(utterance);
    utterancesByTrack.set(utterance.track_id, list);
  }
  const inputs = [
    options.session.paths.artifact("manifest"),
    options.session.paths.artifact("transcript"),
    ...manifest.tracks.map((track) => trackPath(options.session, track.path)),
  ];
  const params: Record<string, unknown> = {
    backend: options.backend ?? "auto",
    min_duration_s: options.minDurationS ?? MIN_FEATURE_DURATION_S,
    ...(options.params ?? {}),
  };
  if (options.model !== undefined) params["model"] = options.model;
  return runStage<FeaturesArtifact>(
    {
      session: options.session,
      stage: "features",
      version: FEATURES_STAGE_VERSION,
      output: "features",
      inputs,
      params,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.io === undefined ? {} : { io: options.io }),
    },
    async ({ progress }) => {
      const rowsById = new Map<string, WorkingRow>();
      let backend = options.backend ?? "fake";
      let dimension = DEFAULT_FAKE_DIMENSION;
      for (const [trackIndex, track] of tracks.entries()) {
        const utterances = utterancesByTrack.get(track.track_id) ?? [];
        if (utterances.length === 0) continue;
        const result = response(
          await sidecar.runJob(
            "features",
            {
              track_path: trackPath(options.session, track.path),
              utterances: utterances.map((utterance) => ({ ...utterance })),
              params,
            },
            { onProgress: progressFor(progress, trackIndex, tracks.length) },
          ),
        );
        if (typeof result.backend === "string") backend = result.backend;
        if (
          typeof result.dimension === "number" &&
          Number.isInteger(result.dimension) &&
          result.dimension > 0
        ) {
          dimension = result.dimension;
        }
        for (const row of sidecarRows(result, utterances)) rowsById.set(row.utterance_id, row);
      }
      const orderedRows = transcript.utterances.map((utterance) => {
        const row = rowsById.get(utterance.id);
        if (row === undefined)
          throw new Error(`features response omitted utterance ${utterance.id}`);
        return row;
      });
      const zscores = zscore(orderedRows);
      const vectors: number[] = [];
      const featureRows = orderedRows.map((row) => {
        if (row.embedding === null || row.prosody === null) {
          return {
            utterance_id: row.utterance_id,
            player_id: row.player_id,
            offset: null,
            prosody: null,
            prosody_z: null,
          };
        }
        if (row.embedding.length !== dimension) {
          throw new Error(`embedding dimension mismatch for ${row.utterance_id}`);
        }
        const norm = Math.sqrt(row.embedding.reduce((total, value) => total + value * value, 0));
        if (!Number.isFinite(norm) || norm <= 0)
          throw new Error(`zero embedding for ${row.utterance_id}`);
        const offset = vectors.length * 4;
        for (const value of row.embedding) vectors.push(value / norm);
        return {
          utterance_id: row.utterance_id,
          player_id: row.player_id,
          offset,
          prosody: row.prosody,
          prosody_z: zscores.get(row.utterance_id) ?? null,
        };
      });
      const binary = Buffer.alloc(vectors.length * 4);
      vectors.forEach((value, index) => binary.writeFloatLE(value, index * 4));
      const blobName = `features.${createHash("sha256").update(binary).digest("hex")}.bin`;
      const blobPath = join(dirname(options.session.paths.artifact("features")), blobName);
      const artifact: FeaturesArtifact = {
        embedding: { backend, dimension, normalised: true, blob: blobName },
        min_duration_s: options.minDurationS ?? MIN_FEATURE_DURATION_S,
        rows: featureRows,
      };
      await writeBinaryAtomic(blobPath, binary, options.io ?? nodeIo);
      await writeArtifact(options.session, "features", artifact, options.io);
      progress(1, "features complete");
      return artifact;
    },
  );
}

export const featuresStage = runFeaturesStage;
export const runFeatures = runFeaturesStage;
