import { z } from "zod";

/**
 * Primitives every artifact shares. Defined once so a timestamp means the same
 * thing in the manifest as it does in the QA report.
 */

export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase sha256 hex digest");

export const IsoTimestamp = z.string().datetime({ offset: true });

/** Seconds from the start of the recording. Never negative, always finite. */
export const Seconds = z.number().finite().nonnegative();

export const NonEmpty = z.string().min(1);

/** Ids are prefixed so a stray one is identifiable on sight in a log. */
const prefixed = (prefix: string, label: string) =>
  z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`), `expected a ${label} id (${prefix}…)`);

export const SessionId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "session ids are kebab-case");
export const PlayerId = prefixed("pl_", "player");
export const CharacterId = prefixed("ch_", "character");
export const NpcId = prefixed("npc_", "NPC");
export const TrackId = prefixed("t", "track");
export const UtteranceId = prefixed("u", "utterance");
export const RollId = prefixed("r", "roll");
export const BeatId = prefixed("b", "beat");
export const EventId = prefixed("e", "event");

/**
 * A machine-readable problem. Every stage reports through this shape so the CLI
 * and the desktop app can group and act on them without special-casing.
 */
export const QaSeverity = z.enum(["error", "warning", "info"]);
export const QaEntry = z.object({
  code: NonEmpty,
  severity: QaSeverity,
  message: NonEmpty,
  subject: z.string().optional(),
  /** What to actually do about it — a file and a field, not "check your config". */
  hint: z.string().optional(),
});
export type QaEntry = z.infer<typeof QaEntry>;

/**
 * Attached wherever the pipeline declines to decide. The code is what the
 * review UI groups by and the adjudicator prompts against.
 */
export const Flag = z.object({
  code: NonEmpty,
  reason: NonEmpty,
  evidence: z.record(z.string(), z.unknown()).optional(),
});
export type Flag = z.infer<typeof Flag>;

/** Confidence is always 0..1 so thresholds mean one thing across the codebase. */
export const Confidence = z.number().min(0).max(1);

/** Where a derived value came from, so an LLM's edit is never mistaken for evidence. */
export const Provenance = z.enum(["deterministic", "llm", "audio-llm", "human"]);
