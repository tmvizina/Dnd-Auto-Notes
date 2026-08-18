import { join } from "node:path";
import { ARTIFACTS, STAGE_META_FILENAME } from "../contracts/artifacts.js";
import type { ArtifactName } from "../contracts/artifacts.js";

export interface SessionPaths {
  readonly root: string;
  readonly id: string;
  artifact(name: ArtifactName): string;
  /** The `_stage.json` beside a stage's output artifact. */
  stageMeta(name: ArtifactName): string;
  input(...segments: string[]): string;
  media(...segments: string[]): string;
}

export function sessionPaths(root: string, id: string): SessionPaths {
  return {
    root,
    id,
    artifact: (name) => join(root, ARTIFACTS[name]),
    stageMeta: (name) => join(root, ARTIFACTS[name], "..", STAGE_META_FILENAME),
    input: (...segments) => join(root, "input", ...segments),
    media: (...segments) => join(root, "media", ...segments),
  };
}
