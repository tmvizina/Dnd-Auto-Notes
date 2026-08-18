import { z } from "zod";
import { NonEmpty, PlayerId, RollId, Seconds, UtteranceId } from "./common.js";

/** Roll20 events anchored onto the audio clock. */

export const RollKind = z.enum([
  "attack",
  "damage",
  "save",
  "check",
  "initiative",
  "death_save",
  "other",
]);

export const Die = z.object({
  sides: z.number().int().positive(),
  value: z.number().int(),
  dropped: z.boolean().default(false),
});

export const Roll = z.object({
  id: RollId,
  seq: z.number().int().nonnegative(),
  who: z.string(),
  player_id: PlayerId.nullable(),
  formula: z.string(),
  dice: z.array(Die).default([]),
  modifiers: z.number().default(0),
  total: z.number(),
  kind: RollKind,
  advantage: z.enum(["none", "advantage", "disadvantage"]).default("none"),
  raw_ref: z.string().optional(),
});
export type Roll = z.infer<typeof Roll>;

/**
 * How a roll got its time. Interpolated and extrapolated rolls carry a widening
 * uncertainty; `matched` means an utterance actually announced it.
 */
export const AnchorKind = z.enum(["matched", "interpolated", "extrapolated"]);

export const AnchoredRoll = z.object({
  roll_id: RollId,
  t_audio_s: Seconds,
  t_uncertainty_s: z.number().nonnegative(),
  anchor: AnchorKind,
  matched_utterance_id: UtteranceId.nullable(),
});
export type AnchoredRoll = z.infer<typeof AnchoredRoll>;

export const TurnOrderEntry = z.object({
  name: NonEmpty,
  value: z.number(),
  token_id: z.string().optional(),
});

export const TurnOrderEvent = z.object({
  seq: z.number().int().nonnegative(),
  t_audio_s: Seconds,
  entries: z.array(TurnOrderEntry),
  marker: z.enum(["combat_started", "combat_ended", "changed"]),
});
export type TurnOrderEvent = z.infer<typeof TurnOrderEvent>;

export const Timeline = z.object({
  rolls: z.array(Roll),
  anchors: z.array(AnchoredRoll),
  turnorder: z.array(TurnOrderEvent).default([]),
  quality: z.object({
    anchored_fraction: z.number().min(0).max(1),
    median_residual_s: z.number().nullable(),
    largest_unanchored_gap_s: z.number().nullable(),
    /** A systematic residual here means the two clocks genuinely disagree. */
    clock_drift_s: z.number().nullable(),
  }),
});
export type Timeline = z.infer<typeof Timeline>;
