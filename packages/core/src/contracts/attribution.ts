import { z } from "zod";
import {
  CharacterId,
  Confidence,
  Flag,
  NpcId,
  Provenance,
  Seconds,
  UtteranceId,
} from "./common.js";
import { Prosody } from "./features.js";

/**
 * The decision this project exists to make: player or character, and which one.
 * Every attribution carries the evidence that produced it, because a confident
 * wrong label is worse than an admitted uncertainty — only one gets fixed.
 */

export const PersonaMode = z.enum([
  "in_character",
  "out_of_character",
  "narration",
  "uncertain",
  "non_speech",
]);
export type PersonaMode = z.infer<typeof PersonaMode>;

export const Evidence = z.object({
  voice_sim_table: z.number().optional(),
  voice_sim_character: z.number().optional(),
  voice_margin: z.number().optional(),
  prosody_z: Prosody.optional(),
  lex_ooc: z.number().optional(),
  lex_ic: z.number().optional(),
  roll_prox: z.boolean().optional(),
  chat_prox: z.boolean().optional(),
  addressee: z.enum(["dm", "character", "table", "unknown"]).optional(),
  duration_s: z.number().nonnegative().optional(),
  is_backchannel: z.boolean().optional(),
  overlap: z.boolean().optional(),
  profile_similarity: z.number().optional(),
  profile_margin: z.number().optional(),
  profile_match_count: z.number().int().nonnegative().optional(),
  score_ic: z.number().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * A quoted span inside a larger utterance — the DM narrating and then voicing
 * a line. The frame stays with the speaker; the quote is attributed separately.
 */
export const ChildAttribution = z.object({
  start_s: Seconds,
  end_s: Seconds,
  mode: PersonaMode,
  character_id: z.union([CharacterId, NpcId]).nullable(),
  confidence: Confidence,
});

export const Attribution = z.object({
  utterance_id: UtteranceId,
  mode: PersonaMode,
  character_id: z.union([CharacterId, NpcId]).nullable(),
  confidence: Confidence,
  evidence: Evidence.default({}),
  flags: z.array(Flag).default([]),
  children: z.array(ChildAttribution).default([]),
  source: Provenance.default("deterministic"),
  /** Set when a smoother or an adjudicator moved this off its computed value. */
  overridden_from: PersonaMode.nullable().default(null),
});
export type Attribution = z.infer<typeof Attribution>;

export const AttributionFile = z.object({
  attributions: z.array(Attribution),
  summary: z.object({
    in_character: z.number().int().nonnegative(),
    out_of_character: z.number().int().nonnegative(),
    narration: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(),
    unknown_character: z.number().int().nonnegative(),
  }),
  weights_version: z.string().optional(),
});
export type AttributionFile = z.infer<typeof AttributionFile>;
