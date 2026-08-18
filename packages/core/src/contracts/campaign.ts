import { z } from "zod";
import { CharacterId, Confidence, NonEmpty, NpcId, PlayerId, Sha256 } from "./common.js";

/**
 * Campaign state outlives any one session. This is where the three namespaces
 * meet — Discord users (audio tracks), Roll20 accounts (rolls), and characters
 * (what the notes are about). Everything downstream assumes it is correct.
 */

export const Character = z.object({
  id: CharacterId,
  name: NonEmpty,
  aliases: z.array(NonEmpty).default([]),
  /** Session number the character joined / left. Attribution respects both. */
  active_from: z.string().optional(),
  active_to: z.string().optional(),
});
export type Character = z.infer<typeof Character>;

export const Player = z.object({
  id: PlayerId,
  display_name: NonEmpty,
  is_dm: z.boolean().default(false),
  discord: z
    .object({
      user_id: z.string().optional(),
      username: z.string().optional(),
      /** Extra substrings to match against Craig track filenames. */
      craig_track_hints: z.array(NonEmpty).default([]),
    })
    .default({ craig_track_hints: [] }),
  roll20: z
    .object({
      account_name: z.string().optional(),
      player_ids: z.array(NonEmpty).default([]),
    })
    .default({ player_ids: [] }),
  characters: z.array(Character).default([]),
});
export type Player = z.infer<typeof Player>;

export const PlayersFile = z.object({ players: z.array(Player) });
export type PlayersFile = z.infer<typeof PlayersFile>;

export const Npc = z.object({
  id: NpcId,
  name: NonEmpty,
  aliases: z.array(NonEmpty).default([]),
  /** The DM who voices them; open-ended and added mid-session. */
  voiced_by: PlayerId.optional(),
  first_seen_session: z.string().optional(),
  notes: z.string().optional(),
});
export type Npc = z.infer<typeof Npc>;

export const NpcsFile = z.object({ npcs: z.array(Npc) });
export type NpcsFile = z.infer<typeof NpcsFile>;

export const Campaign = z.object({
  name: NonEmpty,
  system: z.string().default("D&D 5e"),
  timezone: z.string().default("UTC"),
  session_prefix: z.string().default("s"),
});
export type Campaign = z.infer<typeof Campaign>;

/** Weighted markers for the lexical rule engine (P2-06). */
export const Lexicon = z.object({
  version: z.number().int().positive().default(1),
  classes: z.record(
    NonEmpty,
    z.object({
      weight: z.number(),
      terms: z.array(NonEmpty),
    }),
  ),
});
export type Lexicon = z.infer<typeof Lexicon>;

/**
 * A persistent voice centroid. This is the mechanism by which accuracy improves
 * across sessions: corrections in the review UI fold back into these.
 */
export const VoiceProfile = z.object({
  profile_id: NonEmpty,
  player_id: PlayerId,
  /** Null for the player's own table voice. */
  character_id: z.union([CharacterId, NpcId]).nullable(),
  kind: z.enum(["table", "character", "npc"]),
  dimension: z.number().int().positive(),
  centroid: z.array(z.number()),
  /** Spread of contributing embeddings; the margin test uses it. */
  radius: z.number().nonnegative().default(0),
  utterance_count: z.number().int().nonnegative(),
  sessions: z.array(NonEmpty).default([]),
  updated_at: z.string(),
  version: z.number().int().positive().default(1),
});
export type VoiceProfile = z.infer<typeof VoiceProfile>;

/** Append-only human labels, the ground truth calibration fits against. */
export const Label = z.object({
  utterance_id: NonEmpty,
  mode: z.enum(["in_character", "out_of_character", "narration", "non_speech", "unresolvable"]),
  character_id: z.union([CharacterId, NpcId]).nullable(),
  labeller: NonEmpty,
  at: z.string(),
  confidence: Confidence.optional(),
  source_sha256: Sha256.optional(),
});
export type Label = z.infer<typeof Label>;
