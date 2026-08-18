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

/** Bumped when an on-disk artifact shape changes in a way stages must notice. */
export const CORE_VERSION = "0.1.0";
