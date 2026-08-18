import { z } from "zod";
import { PlayerId, Seconds, TrackId, UtteranceId } from "./common.js";

/** The merged, ordered speech timeline every later stage reasons over. */

export const Word = z.object({
  t: z.string(),
  s: Seconds,
  e: Seconds,
});
export type Word = z.infer<typeof Word>;

export const Utterance = z.object({
  id: UtteranceId,
  track_id: TrackId,
  player_id: PlayerId.nullable(),
  start_s: Seconds,
  end_s: Seconds,
  text: z.string(),
  words: z.array(Word).default([]),
  asr: z
    .object({
      backend: z.string(),
      model: z.string(),
      avg_logprob: z.number().optional(),
      no_speech_prob: z.number().optional(),
    })
    .optional(),
  /** Simultaneous speech on another track. Real, and never dropped. */
  overlap_ids: z.array(UtteranceId).default([]),
  /**
   * Set when this is the quieter copy of one voice landing on two tracks —
   * co-located players sharing a room. Silently doubling every line is one of
   * the more damaging failure modes, so it is marked rather than merged away.
   */
  bleed_of: UtteranceId.nullable().default(null),
  /** Pure acknowledgement ("yeah", "mhm") — suppressible without being lost. */
  is_backchannel: z.boolean().default(false),
});
export type Utterance = z.infer<typeof Utterance>;

export const Transcript = z.object({
  utterances: z.array(Utterance),
  counts: z
    .object({
      utterances: z.number().int().nonnegative(),
      speech_seconds_by_player: z.record(z.string(), z.number()).default({}),
    })
    .optional(),
});
export type Transcript = z.infer<typeof Transcript>;
