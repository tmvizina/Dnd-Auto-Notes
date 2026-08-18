import { z } from "zod";
import { NonEmpty, PlayerId, QaEntry, Seconds, Sha256, SessionId, TrackId } from "./common.js";

/** Output of the intake stage: what we have, whose it is, and whether it lines up. */

export const Track = z.object({
  track_id: TrackId,
  path: NonEmpty,
  /** Null when intake could not bind the track to a player — never a guess. */
  player_id: PlayerId.nullable(),
  /** How the binding was made, so a fuzzy match is visible in review. */
  match: z.enum(["discord_id", "username", "fuzzy", "manual", "unmatched"]),
  match_score: z.number().min(0).max(1).optional(),
  sha256: Sha256,
  duration_s: Seconds,
  sample_rate: z.number().int().positive(),
  channels: z.number().int().positive(),
  codec: z.string().optional(),
  /** Cheap energy-based estimate; a near-zero value means an absent participant. */
  speech_ratio: z.number().min(0).max(1),
  /** False when this track's duration disagrees with the others. */
  aligned: z.boolean(),
});
export type Track = z.infer<typeof Track>;

/**
 * How Roll20 timestamps were obtained. Alignment behaves differently for each,
 * and the QA report says which one is in play.
 */
export const TimeBasis = z.enum(["wallclock", "messageid", "order_only"]);
export type TimeBasis = z.infer<typeof TimeBasis>;

export const Roll20Source = z.object({
  path: NonEmpty,
  sha256: Sha256,
  message_count: z.number().int().nonnegative(),
  roll_count: z.number().int().nonnegative(),
  capture_mode: z.enum(["live", "post_hoc", "archive"]),
  time_basis: TimeBasis,
  /** Seconds to add to a Roll20 wall-clock to reach recording-relative time. */
  clock_offset_s: z.number().optional(),
});

export const Manifest = z.object({
  session_id: SessionId,
  recording: z.object({
    started_at: z.string().nullable(),
    duration_s: Seconds,
    source: z.literal("craig"),
    track_count: z.number().int().nonnegative(),
  }),
  tracks: z.array(Track),
  roll20: Roll20Source.nullable(),
  qa: z.array(QaEntry).default([]),
});
export type Manifest = z.infer<typeof Manifest>;
