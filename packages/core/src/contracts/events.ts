import { z } from "zod";
import {
  BeatId,
  CharacterId,
  Confidence,
  EventId,
  NonEmpty,
  NpcId,
  RollId,
  Seconds,
  UtteranceId,
} from "./common.js";
import { PersonaMode } from "./attribution.js";
import { Roll, TurnOrderEvent } from "./timeline.js";

/**
 * The single ordered stream the renderer and the app both read. Every event
 * points back at the utterances and rolls it was built from; the notes renderer
 * may state nothing that is not reachable from those references.
 */

const CharacterRef = z.union([CharacterId, NpcId]);

export const SessionEvent = z.object({
  id: EventId,
  kind: z.enum([
    "session_start",
    "session_end",
    "speech",
    "roll",
    "chat",
    "turnorder",
    "combat_start",
    "combat_end",
    "gap",
  ]),
  t_start_s: Seconds,
  t_end_s: Seconds,
  source_refs: z.object({
    utterances: z.array(UtteranceId).default([]),
    rolls: z.array(RollId).default([]),
  }),
  confidence: Confidence.default(1),
  speaker_player_id: z.string().nullable().default(null),
  speaker_character_id: CharacterRef.nullable().default(null),
  speaker_display: z.string().optional(),
  character_display: z.string().optional(),
  is_dm: z.boolean().default(false),
  text: z.string().optional(),
  mode: PersonaMode.optional(),
  /** Roll evidence is retained on the event even when its announcement is linked to speech. */
  rolls: z.array(Roll).default([]),
  turnorder: TurnOrderEvent.optional(),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const Turn = z.object({
  actor: CharacterRef.nullable(),
  roll_ids: z.array(RollId).default([]),
  narration_utterances: z.array(UtteranceId).default([]),
  damage_total: z.number().nullable().default(null),
});

export const Round = z.object({
  n: z.number().int().positive(),
  turns: z.array(Turn),
});

export const Encounter = z.object({
  rounds: z.array(Round),
  participants: z.array(CharacterRef).default([]),
  /** `inferred` when the turn-order tracker was absent and rolls stood in. */
  reconstruction: z.enum(["tracker", "inferred"]),
  notable_roll_ids: z.array(RollId).default([]),
});
export type Encounter = z.infer<typeof Encounter>;

export const Check = z.object({
  actor: CharacterRef.nullable(),
  skill: z.string(),
  total: z.number(),
  roll_id: RollId,
  stated_intent: z.string().nullable(),
  /** Only ever set when the adjudication was actually spoken. No invented DCs. */
  verdict: z.enum(["success", "failure", "unknown"]).default("unknown"),
});
export type Check = z.infer<typeof Check>;

export const Beat = z.object({
  id: BeatId,
  kind: z.enum(["combat", "social", "exploration", "planning", "table", "recap"]),
  start_s: Seconds,
  end_s: Seconds,
  title: NonEmpty,
  participants: z.array(CharacterRef).default([]),
  utterance_ids: z.array(UtteranceId).default([]),
  roll_ids: z.array(RollId).default([]),
  encounter: Encounter.optional(),
  checks: z.array(Check).default([]),
  /** Why the segmenter cut here — makes a wrong split explainable. */
  boundary_evidence: z.array(NonEmpty).default([]),
  event_ids: z.array(EventId).default([]),
  roll_counts: z
    .object({
      attack: z.number().int().nonnegative(),
      damage: z.number().int().nonnegative(),
      save: z.number().int().nonnegative(),
      check: z.number().int().nonnegative(),
      initiative: z.number().int().nonnegative(),
      death_save: z.number().int().nonnegative(),
      other: z.number().int().nonnegative(),
    })
    .default({ attack: 0, damage: 0, save: 0, check: 0, initiative: 0, death_save: 0, other: 0 }),
  in_character_speech_ratio: z.number().min(0).max(1).default(0),
  dominant_characters: z.array(CharacterRef).default([]),
  boundary_signals: z
    .array(z.object({ kind: z.string(), score: z.number(), evidence: z.string() }))
    .default([]),
  summary_deterministic: z.string().optional(),
  summary_llm: z.string().optional(),
});
export type Beat = z.infer<typeof Beat>;

export const Events = z.object({
  events: z.array(SessionEvent),
  beats: z.array(Beat),
  open_threads: z.array(z.object({ text: NonEmpty, source: UtteranceId })).default([]),
});
export type Events = z.infer<typeof Events>;
