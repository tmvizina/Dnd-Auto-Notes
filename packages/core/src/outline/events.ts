import type { Attribution, AttributionFile, PersonaMode } from "../contracts/attribution.js";
import type { Roll, Timeline, TurnOrderEvent } from "../contracts/timeline.js";
import type { Transcript } from "../contracts/utterances.js";

export type OutlineCharacterId = string;
type PlayerId = string;
type RollId = string;
type UtteranceId = string;
export type OutlineEventKind =
  | "session_start"
  | "session_end"
  | "speech"
  | "roll"
  | "chat"
  | "turnorder"
  | "combat_start"
  | "combat_end"
  | "gap";

export interface OutlineNameRegistry {
  readonly players?: ReadonlyArray<{
    readonly id: PlayerId;
    readonly display_name: string;
    readonly is_dm?: boolean;
    readonly characters?: ReadonlyArray<{ readonly id: OutlineCharacterId; readonly name: string }>;
  }>;
  readonly npcs?: ReadonlyArray<{ readonly id: OutlineCharacterId; readonly name: string }>;
}

export interface OutlineEvent {
  readonly id: string;
  readonly kind: OutlineEventKind;
  readonly t_start_s: number;
  readonly t_end_s: number;
  readonly source_refs: {
    readonly utterances: readonly UtteranceId[];
    readonly rolls: readonly RollId[];
  };
  readonly confidence: number;
  readonly speaker_player_id: PlayerId | null;
  readonly speaker_character_id: OutlineCharacterId | null;
  readonly speaker_display?: string;
  readonly character_display?: string;
  readonly is_dm: boolean;
  readonly text?: string;
  readonly mode?: PersonaMode;
  readonly rolls: readonly Roll[];
  readonly turnorder?: TurnOrderEvent;
}
/** Public name used by downstream stages and the persisted contract. */
export type SessionEvent = OutlineEvent;

export interface OutlineChat {
  readonly id: string;
  readonly t_start_s: number;
  readonly t_end_s?: number;
  readonly text: string;
  readonly confidence?: number;
  readonly source_refs?: {
    readonly utterances?: readonly UtteranceId[];
    readonly rolls?: readonly RollId[];
  };
}

export interface OutlineBuildInput {
  readonly transcript: Transcript;
  readonly attribution: AttributionFile;
  readonly timeline: Timeline;
  readonly registry?: OutlineNameRegistry;
  readonly duration_s?: number;
  readonly gap_threshold_s?: number;
  readonly chat?: readonly OutlineChat[];
}

export class OutlineEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutlineEventError";
  }
}

function finiteTime(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new OutlineEventError(`${label} must be finite and non-negative`);
  return value;
}

function stableTime(value: number): string {
  return Math.round(value * 1000).toString(36);
}

function sourceRefs(
  utterances: readonly UtteranceId[],
  rolls: readonly RollId[],
): OutlineEvent["source_refs"] {
  return { utterances: [...new Set(utterances)].sort(), rolls: [...new Set(rolls)].sort() };
}

function player(registry: OutlineNameRegistry | undefined, id: PlayerId | null) {
  return id === null ? undefined : registry?.players?.find((candidate) => candidate.id === id);
}

function character(registry: OutlineNameRegistry | undefined, id: OutlineCharacterId | null) {
  if (id === null) return undefined;
  for (const candidate of registry?.players ?? []) {
    const found = candidate.characters?.find((item) => item.id === id);
    if (found !== undefined) return found;
  }
  return registry?.npcs?.find((candidate) => candidate.id === id);
}

function confidence(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) throw new OutlineEventError("confidence must be finite");
  return Math.max(0, Math.min(1, value));
}

function attributed(attribution: AttributionFile, id: UtteranceId): Attribution | undefined {
  return attribution.attributions.find((item) => item.utterance_id === id);
}

function compareEvents(left: OutlineEvent, right: OutlineEvent): number {
  return (
    left.t_start_s - right.t_start_s ||
    left.t_end_s - right.t_end_s ||
    stableCompare(left.id, right.id)
  );
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertOrdered(events: readonly OutlineEvent[]): void {
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) throw new OutlineEventError(`duplicate event id ${event.id}`);
    if (!/^e[A-Za-z0-9_-]+$/u.test(event.id))
      throw new OutlineEventError(`invalid event id ${event.id}`);
    ids.add(event.id);
    if (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1)
      throw new OutlineEventError(`${event.id} has invalid confidence`);
    if (event.t_end_s < event.t_start_s)
      throw new OutlineEventError(`${event.id} ends before it starts`);
  }
  for (let index = 1; index < events.length; index += 1) {
    if (compareEvents(events[index - 1]!, events[index]!) >= 0)
      throw new OutlineEventError(`events are not strictly ordered at ${events[index]!.id}`);
  }
}

function validateRefs(
  events: readonly OutlineEvent[],
  transcript: Transcript,
  timeline: Timeline,
): void {
  const utterances = new Set(transcript.utterances.map((item) => item.id));
  const rolls = new Set(timeline.rolls.map((item) => item.id));
  for (const event of events) {
    for (const id of event.source_refs.utterances)
      if (!utterances.has(id))
        throw new OutlineEventError(`${event.id} references missing utterance ${id}`);
    for (const id of event.source_refs.rolls)
      if (!rolls.has(id)) throw new OutlineEventError(`${event.id} references missing roll ${id}`);
  }
}

/** Build the deterministic, single-clock event stream consumed by outline renderers. */
export function buildSessionEvents(input: OutlineBuildInput): readonly OutlineEvent[] {
  const utterances = [...input.transcript.utterances].sort(
    (a, b) => a.start_s - b.start_s || stableCompare(a.id, b.id),
  );
  const attribution = input.attribution;
  const anchors = new Map(input.timeline.anchors.map((anchor) => [anchor.roll_id, anchor]));
  const rollsById = new Map(input.timeline.rolls.map((roll) => [roll.id, roll]));
  if (anchors.size !== input.timeline.anchors.length)
    throw new OutlineEventError("a roll has more than one anchor");
  for (const anchor of input.timeline.anchors) {
    if (!rollsById.has(anchor.roll_id))
      throw new OutlineEventError(`anchor references missing roll ${anchor.roll_id}`);
    if (
      anchor.matched_utterance_id !== null &&
      !input.transcript.utterances.some((item) => item.id === anchor.matched_utterance_id)
    )
      throw new OutlineEventError(
        `anchor references missing utterance ${anchor.matched_utterance_id}`,
      );
  }
  const usedRolls = new Set<RollId>();
  const events: OutlineEvent[] = [];
  const duration =
    input.duration_s ??
    Math.max(
      0,
      ...utterances.map((item) => item.end_s),
      ...input.timeline.anchors.map((item) => item.t_audio_s),
    );
  const end = finiteTime(duration, "duration_s");
  const latestSource = Math.max(
    0,
    ...utterances.map((item) => item.end_s),
    ...input.timeline.anchors.map((item) => item.t_audio_s),
  );
  if (end < latestSource) throw new OutlineEventError("duration_s ends before a source event");
  events.push({
    id: "e_session_start",
    kind: "session_start",
    t_start_s: 0,
    t_end_s: 0,
    source_refs: sourceRefs([], []),
    confidence: 1,
    speaker_player_id: null,
    speaker_character_id: null,
    is_dm: false,
    rolls: [],
  });

  for (const utterance of utterances) {
    const item = attributed(attribution, utterance.id);
    const speaker = player(input.registry, utterance.player_id);
    const characterId = item?.character_id ?? null;
    const char = character(input.registry, characterId);
    const rollIds = input.timeline.anchors
      .filter((anchor) => anchor.matched_utterance_id === utterance.id)
      .map((anchor) => {
        usedRolls.add(anchor.roll_id);
        return anchor.roll_id;
      });
    const linkedRolls = rollIds.flatMap((id) => {
      const roll = rollsById.get(id);
      return roll === undefined ? [] : [roll];
    });
    events.push({
      id: `e_speech_${utterance.id}`,
      kind: "speech",
      t_start_s: finiteTime(utterance.start_s, `${utterance.id}.start_s`),
      t_end_s: finiteTime(utterance.end_s, `${utterance.id}.end_s`),
      source_refs: sourceRefs([utterance.id], rollIds),
      confidence: confidence(item?.confidence),
      speaker_player_id: utterance.player_id,
      speaker_character_id: characterId,
      ...(speaker === undefined ? {} : { speaker_display: speaker.display_name }),
      ...(char === undefined ? {} : { character_display: char.name }),
      is_dm: speaker?.is_dm ?? false,
      text: utterance.text,
      ...(item === undefined ? {} : { mode: item.mode }),
      rolls: linkedRolls,
    });
  }

  for (const roll of input.timeline.rolls) {
    if (usedRolls.has(roll.id)) continue;
    const anchor = anchors.get(roll.id);
    if (anchor === undefined) continue;
    events.push({
      id: `e_roll_${roll.id}`,
      kind: "roll",
      t_start_s: anchor.t_audio_s,
      t_end_s: anchor.t_audio_s,
      source_refs: sourceRefs([], [roll.id]),
      confidence: anchor.anchor === "matched" ? 1 : Math.max(0, 1 - anchor.t_uncertainty_s / 10),
      speaker_player_id: roll.player_id,
      speaker_character_id: null,
      is_dm: false,
      rolls: [roll],
    });
  }

  for (const turn of [...input.timeline.turnorder].sort(
    (a, b) => a.t_audio_s - b.t_audio_s || a.seq - b.seq,
  )) {
    const kind =
      turn.marker === "combat_started"
        ? "combat_start"
        : turn.marker === "combat_ended"
          ? "combat_end"
          : "turnorder";
    events.push({
      id: `e_${kind}_${String(turn.seq)}`,
      kind,
      t_start_s: turn.t_audio_s,
      t_end_s: turn.t_audio_s,
      source_refs: sourceRefs([], []),
      confidence: 1,
      speaker_player_id: null,
      speaker_character_id: null,
      is_dm: false,
      rolls: [],
      turnorder: turn,
    });
  }

  for (const chat of [...(input.chat ?? [])].sort(
    (a, b) => a.t_start_s - b.t_start_s || stableCompare(a.id, b.id),
  )) {
    const refs = sourceRefs(chat.source_refs?.utterances ?? [], chat.source_refs?.rolls ?? []);
    events.push({
      id: `e_chat_${chat.id}`,
      kind: "chat",
      t_start_s: finiteTime(chat.t_start_s, `${chat.id}.t_start_s`),
      t_end_s: finiteTime(chat.t_end_s ?? chat.t_start_s, `${chat.id}.t_end_s`),
      source_refs: refs,
      confidence: confidence(chat.confidence),
      speaker_player_id: null,
      speaker_character_id: null,
      is_dm: false,
      text: chat.text,
      rolls: [],
    });
  }

  const threshold = input.gap_threshold_s ?? 2;
  if (!Number.isFinite(threshold) || threshold < 0)
    throw new OutlineEventError("gap_threshold_s must be finite and non-negative");
  const spans = utterances
    .map((item) => [item.start_s, item.end_s] as const)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let gapIndex = 0;
  for (const [start, stop] of spans) {
    if (start - covered > threshold)
      events.push({
        id: `e_gap_${stableTime(covered)}_${stableTime(start)}_${String(gapIndex++)}`,
        kind: "gap",
        t_start_s: covered,
        t_end_s: start,
        source_refs: sourceRefs([], []),
        confidence: 1,
        speaker_player_id: null,
        speaker_character_id: null,
        is_dm: false,
        rolls: [],
      });
    covered = Math.max(covered, stop);
  }
  if (end - covered > threshold)
    events.push({
      id: `e_gap_${stableTime(covered)}_${stableTime(end)}_${String(gapIndex)}`,
      kind: "gap",
      t_start_s: covered,
      t_end_s: end,
      source_refs: sourceRefs([], []),
      confidence: 1,
      speaker_player_id: null,
      speaker_character_id: null,
      is_dm: false,
      rolls: [],
    });
  events.push({
    id: "e_session_end",
    kind: "session_end",
    t_start_s: end,
    t_end_s: end,
    source_refs: sourceRefs([], []),
    confidence: 1,
    speaker_player_id: null,
    speaker_character_id: null,
    is_dm: false,
    rolls: [],
  });
  const ordered = [...events].sort(compareEvents);
  assertOrdered(ordered);
  validateRefs(ordered, input.transcript, input.timeline);
  return ordered;
}

export class SessionEventTimeline {
  readonly events: readonly OutlineEvent[];
  constructor(events: readonly OutlineEvent[]) {
    this.events = [...events].sort(compareEvents);
  }
  eventsBetween(start: number, end: number): readonly OutlineEvent[] {
    finiteTime(start, "start");
    finiteTime(end, "end");
    if (end < start) throw new OutlineEventError("window end precedes start");
    return this.events.filter((event) => event.t_end_s >= start && event.t_start_s <= end);
  }
  eventsFor(characterId: OutlineCharacterId): readonly OutlineEvent[] {
    return this.events.filter((event) => event.speaker_character_id === characterId);
  }
  rollsInWindow(start: number, end: number): readonly OutlineEvent[] {
    return this.eventsBetween(start, end).filter(
      (event) => event.kind === "roll" || event.source_refs.rolls.length > 0,
    );
  }
}
