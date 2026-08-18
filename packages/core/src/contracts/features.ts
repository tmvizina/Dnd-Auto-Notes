import { z } from "zod";
import { PlayerId, UtteranceId } from "./common.js";

/**
 * Per-utterance acoustics. Embeddings live in a sibling binary blob — tens of
 * thousands of float arrays in JSON is neither small nor fast — and this file
 * is the index into it.
 */

export const Prosody = z.object({
  f0_mean: z.number(),
  f0_std: z.number(),
  f0_range: z.number(),
  rate_wps: z.number(),
  intensity_mean: z.number(),
  intensity_std: z.number(),
  spectral_tilt: z.number(),
  pause_ratio: z.number(),
});
export type Prosody = z.infer<typeof Prosody>;

export const FeatureRow = z.object({
  utterance_id: UtteranceId,
  player_id: PlayerId,
  /** Byte offset into features.bin; null when the utterance was too short. */
  offset: z.number().int().nonnegative().nullable(),
  prosody: Prosody.nullable(),
  /** Prosody z-scored against this player's own baseline, not a global one. */
  prosody_z: Prosody.nullable(),
});
export type FeatureRow = z.infer<typeof FeatureRow>;

export const Features = z.object({
  embedding: z.object({
    backend: z.string(),
    dimension: z.number().int().positive(),
    /** L2-normalised, so cosine similarity is a dot product. */
    normalised: z.literal(true),
    blob: z.string(),
  }),
  min_duration_s: z.number().positive(),
  rows: z.array(FeatureRow),
});
export type Features = z.infer<typeof Features>;
