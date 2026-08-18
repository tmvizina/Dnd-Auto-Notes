import type { z } from "zod";
import { AttributionFile } from "./attribution.js";
import { Events } from "./events.js";
import { Features } from "./features.js";
import { Manifest } from "./manifest.js";
import { QaReport } from "./qa.js";
import { Timeline } from "./timeline.js";
import { Transcript } from "./utterances.js";

/**
 * Every artifact path in one frozen place. No stage builds one by
 * concatenation: a typo in a path is a silently empty re-run, which is the
 * hardest kind of bug to notice in a pipeline that is allowed to skip work.
 */
export const ARTIFACTS = Object.freeze({
  manifest: "work/01-intake/manifest.json",
  intakeQa: "work/01-intake/qa.json",
  transcript: "work/02-transcript/utterances.json",
  features: "work/03-features/features.json",
  featuresBlob: "work/03-features/features.bin",
  timeline: "work/04-align/timeline.json",
  attribution: "work/05-persona/attribution.json",
  events: "work/06-outline/events.json",
  notesQa: "work/07-notes/qa.json",
  notes: "session.md",
  session: "session.json",
} as const);

export type ArtifactName = keyof typeof ARTIFACTS;

/** The stage-meta file always sits beside its artifact. */
export const STAGE_META_FILENAME = "_stage.json";

/** Validated artifacts only — `notes` is Markdown and `featuresBlob` is binary. */
export const ARTIFACT_SCHEMAS = Object.freeze({
  manifest: Manifest,
  intakeQa: QaReport,
  transcript: Transcript,
  features: Features,
  attribution: AttributionFile,
  timeline: Timeline,
  events: Events,
  notesQa: QaReport,
} as const);

export type ValidatedArtifactName = keyof typeof ARTIFACT_SCHEMAS;

export type ArtifactOf<K extends ValidatedArtifactName> = z.infer<(typeof ARTIFACT_SCHEMAS)[K]>;

export function isValidatedArtifact(name: string): name is ValidatedArtifactName {
  return Object.prototype.hasOwnProperty.call(ARTIFACT_SCHEMAS, name);
}
