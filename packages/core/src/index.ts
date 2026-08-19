export { findRepoRoot } from "./paths.js";
export * from "./contracts/index.js";
export * from "./campaign/index.js";
export * from "./session/index.js";
export * from "./stage/index.js";
export * from "./db/index.js";
export * from "./sidecar/index.js";
export * from "./intake/craig/index.js";
export * from "./intake/roll20/index.js";
export * from "./qa/index.js";
export * from "./stages/intake.js";
export { buildSessionEvents, OutlineEventError, SessionEventTimeline } from "./outline/events.js";
export type {
  OutlineBuildInput,
  OutlineChat,
  OutlineEvent,
  OutlineEventKind,
  OutlineNameRegistry,
  SessionEvent as OutlineSessionEvent,
} from "./outline/events.js";
export * from "./stages/outline.js";
export { buildEncounter, reconstructEncounter } from "./outline/encounter.js";
export type { EncounterOptions } from "./outline/encounter.js";
export * from "./persona/calibrate.js";
export { readFeatureEmbedding } from "./stages/features.js";
export {
  readProfiles,
  revertProfile,
  seedMissingProfiles,
  updateProfile,
} from "./persona/profileBank.js";

/** Bumped when an on-disk artifact shape changes in a way stages must notice. */
export const CORE_VERSION = "0.1.0";
