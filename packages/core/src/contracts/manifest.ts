import { z } from "zod";
import {
  NonEmpty,
  PlayerId,
  QaEntry,
  RollId,
  Seconds,
  Sha256,
  SessionId,
  TrackId,
} from "./common.js";
import { RollKind } from "./timeline.js";

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

/** A die as captured by Roll20; a missing side count is parser evidence, not a guess. */
export const ManifestDie = z.object({
  sides: z.number().int().positive().nullable(),
  value: z.number().finite(),
  dropped: z.boolean(),
});

/**
 * Roll evidence copied into the intake manifest. `id` is a pipeline-local,
 * deterministic id; source identifiers and account fields remain nullable so
 * an incomplete capture is visible rather than silently repaired.
 */
export const ManifestRoll = z.object({
  id: RollId,
  seq: z.number().int().nonnegative(),
  who: z.string().nullable(),
  player_id: PlayerId.nullable(),
  formula: z.string(),
  dice: z.array(ManifestDie),
  modifiers: z.number().finite(),
  total: z.number().finite().nullable(),
  roll_kind: RollKind,
  advantage: z.enum(["none", "advantage", "disadvantage"]),
  raw_ref: NonEmpty,
  /** Optional fields retain parser details that older captures may not carry. */
  source_id: z.string().nullable().optional(),
  roll20_player_id: z.string().nullable().optional(),
  kind: RollKind.optional(),
  used: z.number().finite().nullable().optional(),
  used_result: z.number().finite().nullable().optional(),
  target: z.string().nullable().optional(),
  npc_mentions: z.array(z.string()).optional(),
});
export type ManifestRoll = z.infer<typeof ManifestRoll>;

export const Manifest = z.object({
  session_id: SessionId,
  recording: z.object({
    started_at: z.string().nullable(),
    duration_s: Seconds,
    source: z.literal("craig"),
    track_count: z.number().int().nonnegative(),
  }),
  tracks: z.array(Track),
  rolls: z.array(ManifestRoll).default([]),
  roll20: Roll20Source.nullable(),
  qa: z.array(QaEntry).default([]),
});
export type Manifest = z.infer<typeof Manifest>;
