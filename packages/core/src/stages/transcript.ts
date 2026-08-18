import { join } from "node:path";
import type { QaEntry } from "../contracts/common.js";
import type { Track } from "../contracts/manifest.js";
import type { Transcript } from "../contracts/utterances.js";
import { SidecarClient } from "../sidecar/client.js";
import type { RunJobOptions } from "../sidecar/client.js";
import { readArtifact, writeArtifact } from "../session/session.js";
import type { FileIo } from "../session/io.js";
import type { Session } from "../session/session.js";
import { runStage } from "../stage/runner.js";
import type { ProgressFn, StageResult } from "../stage/runner.js";
import {
  mergeTranscripts,
  type AsrSegmentInput,
  type TrackTranscriptInput,
  type VadSegmentInput,
} from "../transcript/merge.js";

export const TRANSCRIPT_STAGE_VERSION = 3;

export interface TranscriptSidecar {
  runJob<T>(
    kind: string,
    payload: unknown,
    options?: Pick<RunJobOptions, "onProgress">,
  ): Promise<T>;
}

export interface TranscriptStageOptions {
  readonly session: Session;
  readonly sidecar?: TranscriptSidecar;
  /** Explicit alias for callers that distinguish the client from its URL. */
  readonly sidecarClient?: TranscriptSidecar;
  /** Alias accepted by callers that use the generic client naming. */
  readonly client?: TranscriptSidecar;
  readonly sidecarUrl?: string;
  readonly asrBackend?: string;
  readonly backend?: string;
  readonly model?: string;
  readonly vadParams?: Readonly<Record<string, unknown>>;
  readonly asrParams?: Readonly<Record<string, unknown>>;
  readonly force?: boolean;
  readonly onProgress?: ProgressFn;
  readonly onQa?: (entry: QaEntry) => void;
  readonly io?: FileIo;
}

export type TranscriptStageResult = StageResult<Transcript> & {
  readonly qa: readonly QaEntry[];
};

interface VADResponse {
  readonly segments: readonly VadSegmentInput[];
}

interface ASRResponse {
  readonly segments: readonly AsrSegmentInput[];
  readonly backend?: string;
  readonly model?: string;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function responseSegments(
  value: unknown,
  label: string,
): readonly (VadSegmentInput | AsrSegmentInput)[] {
  const raw = objectValue(value, label)["segments"];
  if (!Array.isArray(raw)) throw new TypeError(`${label} response has no segments array`);
  return raw.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`${label} segment ${String(index)} must be an object`);
    }
    return item as VadSegmentInput | AsrSegmentInput;
  });
}

function vadResponse(value: unknown): VADResponse {
  return { segments: responseSegments(value, "VAD") as readonly VadSegmentInput[] };
}

function asrResponse(value: unknown): ASRResponse {
  const object = objectValue(value, "ASR");
  const backend = typeof object["backend"] === "string" ? object["backend"] : undefined;
  const model = typeof object["model"] === "string" ? object["model"] : undefined;
  return {
    segments: responseSegments(value, "ASR") as readonly AsrSegmentInput[],
    ...(backend === undefined ? {} : { backend }),
    ...(model === undefined ? {} : { model }),
  };
}

function trackPath(session: Session, track: Track): string {
  // Intake paths are session-relative and use forward slashes. Splitting both
  // separators also keeps a hand-written Windows fixture portable.
  return join(session.paths.root, ...track.path.split(/[\\/]+/u));
}

function compareTrackIds(left: Track, right: Track): number {
  return left.track_id < right.track_id ? -1 : left.track_id > right.track_id ? 1 : 0;
}

function progressFor(
  progress: ProgressFn,
  base: number,
  span: number,
  trackIndex: number,
  trackCount: number,
  phase: string,
): (fraction: number, message: string) => void {
  return (fraction, message) => {
    const bounded = Math.max(0, Math.min(1, fraction));
    const overall = (trackIndex + base + span * bounded) / Math.max(1, trackCount);
    progress(overall, `${phase}: ${message}`);
  };
}

async function processTrack(
  sidecar: TranscriptSidecar,
  session: Session,
  track: Track,
  trackIndex: number,
  trackCount: number,
  options: TranscriptStageOptions,
  progress: ProgressFn,
): Promise<TrackTranscriptInput> {
  const path = trackPath(session, track);
  const vad = vadResponse(
    await sidecar.runJob(
      "vad",
      {
        track_path: path,
        params: options.vadParams ?? {},
      },
      {
        onProgress: progressFor(
          progress,
          0.0,
          0.4,
          trackIndex,
          trackCount,
          `${track.track_id} VAD`,
        ),
      },
    ),
  );
  const asr = asrResponse(
    await sidecar.runJob(
      "transcribe",
      {
        track_path: path,
        segments: vad.segments,
        backend: options.asrBackend ?? options.backend ?? "auto",
        model: options.model ?? null,
        params: options.asrParams ?? {},
      },
      {
        onProgress: progressFor(
          progress,
          0.4,
          0.6,
          trackIndex,
          trackCount,
          `${track.track_id} ASR`,
        ),
      },
    ),
  );
  return {
    track_id: track.track_id,
    player_id: track.player_id,
    vad_segments: vad.segments,
    asr_segments: asr.segments,
    ...(asr.backend === undefined ? {} : { backend: asr.backend }),
    ...(asr.model === undefined ? {} : { model: asr.model }),
  };
}

/** Run VAD and ASR for every intake track, then persist one merged transcript. */
export async function runTranscriptStage(
  options: TranscriptStageOptions,
): Promise<TranscriptStageResult> {
  const sidecar =
    options.sidecar ??
    options.sidecarClient ??
    options.client ??
    new SidecarClient(options.sidecarUrl ?? "http://127.0.0.1:8477");
  const manifest = await readArtifact(options.session, "manifest");
  const inputPath = options.session.paths.artifact("manifest");
  const params = {
    asr_backend: options.asrBackend ?? options.backend ?? "auto",
    model: options.model ?? null,
    vad_params: options.vadParams ?? {},
    asr_params: options.asrParams ?? {},
  };
  let qa: readonly QaEntry[] = [];
  const result = await runStage<Transcript>(
    {
      session: options.session,
      stage: "transcript",
      version: TRANSCRIPT_STAGE_VERSION,
      output: "transcript",
      inputs: [inputPath],
      params,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.io === undefined ? {} : { io: options.io }),
    },
    async ({ progress }) => {
      const tracks = [...manifest.tracks].sort(compareTrackIds);
      const trackResults: TrackTranscriptInput[] = [];
      for (const [index, track] of tracks.entries()) {
        trackResults.push(
          await processTrack(
            sidecar,
            options.session,
            track,
            index,
            tracks.length,
            options,
            progress,
          ),
        );
      }
      progress(0.95, "merging cross-track transcript");
      const merged = mergeTranscripts(trackResults);
      qa = merged.qa;
      for (const entry of merged.qa) options.onQa?.(entry);
      await writeArtifact(options.session, "transcript", merged.transcript, options.io);
      progress(1, "transcript complete");
      return merged.transcript;
    },
  );
  return { ...result, qa };
}

export const transcriptStage = runTranscriptStage;
export const runTranscript = runTranscriptStage;
