import { z } from "zod";
import { Sha256 } from "./common.js";

/**
 * Written beside every stage output. This is what makes a re-run cheap and a
 * resume possible: the hashes of what went in, and the version of the code that
 * produced what came out.
 */

export const StageStatus = z.enum(["ok", "error", "skipped"]);
export type StageStatus = z.infer<typeof StageStatus>;

export const StageMeta = z.object({
  stage: z.string(),
  version: z.number().int().positive(),
  status: StageStatus,
  /** Declared input path -> content digest at the time the stage ran. */
  inputs: z.record(z.string(), Sha256),
  params_hash: Sha256,
  started_at: z.string(),
  finished_at: z.string(),
  duration_s: z.number().nonnegative(),
  counts: z.record(z.string(), z.number()).default({}),
  sidecar: z.record(z.string(), z.string()).optional(),
  error: z.string().optional(),
});
export type StageMeta = z.infer<typeof StageMeta>;
