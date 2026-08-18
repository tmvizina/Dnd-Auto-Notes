import { join } from "node:path";
import { loadRegistry } from "../campaign/registry.js";
import type { Events } from "../contracts/events.js";
import type { AttributionFile } from "../contracts/attribution.js";
import type { Timeline } from "../contracts/timeline.js";
import type { Transcript } from "../contracts/utterances.js";
import type { FileIo } from "../session/io.js";
import type { Session } from "../session/session.js";
import { readArtifact, writeArtifact } from "../session/session.js";
import { runStage } from "../stage/runner.js";
import type { ProgressFn, StageResult } from "../stage/runner.js";
import { buildSessionEvents, type OutlineEvent } from "../outline/events.js";

export const OUTLINE_STAGE_VERSION = 1;

export interface OutlineStageOptions {
  readonly session: Session;
  readonly campaignRoot: string;
  readonly duration_s?: number;
  readonly gap_threshold_s?: number;
  readonly force?: boolean;
  readonly onProgress?: ProgressFn;
  readonly io?: FileIo;
}

export interface OutlineArtifact extends Omit<Events, "events"> {
  readonly events: readonly OutlineEvent[];
}

export async function runOutlineStage(
  options: OutlineStageOptions,
): Promise<StageResult<OutlineArtifact>> {
  const transcript = (await readArtifact(options.session, "transcript")) as Transcript;
  const attribution = (await readArtifact(options.session, "attribution")) as AttributionFile;
  const timeline = (await readArtifact(options.session, "timeline")) as Timeline;
  const registry = await loadRegistry(options.campaignRoot);
  return runStage(
    {
      session: options.session,
      stage: "outline",
      version: OUTLINE_STAGE_VERSION,
      output: "events",
      inputs: [
        options.session.paths.artifact("transcript"),
        options.session.paths.artifact("attribution"),
        options.session.paths.artifact("timeline"),
        join(options.campaignRoot, "campaign.json"),
        join(options.campaignRoot, "players.json"),
        join(options.campaignRoot, "npcs.json"),
      ],
      params: {
        gap_threshold_s: options.gap_threshold_s ?? 2,
        duration_s: options.duration_s ?? null,
      },
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.io === undefined ? {} : { io: options.io }),
    },
    async ({ progress }) => {
      progress(0.2, "assembling outline events");
      const events = buildSessionEvents({
        transcript,
        attribution,
        timeline,
        registry,
        ...(options.duration_s === undefined ? {} : { duration_s: options.duration_s }),
        ...(options.gap_threshold_s === undefined
          ? {}
          : { gap_threshold_s: options.gap_threshold_s }),
      });
      const artifact: OutlineArtifact = { events, beats: [], open_threads: [] };
      await writeArtifact(options.session, "events", artifact, options.io);
      progress(1, "outline events complete");
      return artifact;
    },
  );
}

export const outlineStage = runOutlineStage;
