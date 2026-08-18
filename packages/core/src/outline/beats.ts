import type { Beat } from "../contracts/events.js";
import { SessionEventTimeline } from "./events.js";
import type { OutlineEvent } from "./events.js";

export const BEAT_GAP_S = 8;
export const MIN_BEAT_DURATION_S = 30;

export type BeatKind = Beat["kind"];

export interface BeatSegmentationConfig {
  readonly gap_s?: number;
  readonly min_duration_s?: number;
  readonly window_events?: number;
  readonly weights?: Readonly<Partial<Record<BoundarySignalKind, number>>>;
}

export type BoundarySignalKind =
  | "silence_gap"
  | "turnorder_transition"
  | "roll_density"
  | "speaker_set"
  | "npc_set"
  | "glossary_mention"
  | "dm_scene_open";

export interface BoundarySignal {
  readonly kind: BoundarySignalKind;
  readonly score: number;
  readonly evidence: string;
}

export interface BoundaryCandidate {
  readonly event_index: number;
  readonly t_audio_s: number;
  readonly score: number;
  readonly signals: readonly BoundarySignal[];
}

export interface BeatRollCounts {
  readonly attack: number;
  readonly damage: number;
  readonly save: number;
  readonly check: number;
  readonly initiative: number;
  readonly death_save: number;
  readonly other: number;
}

export interface SegmentedBeat extends Beat {
  readonly event_ids: string[];
  readonly roll_counts: BeatRollCounts;
  readonly in_character_speech_ratio: number;
  readonly dominant_characters: string[];
  readonly boundary_signals: BoundarySignal[];
}

export interface BeatTruthLabel {
  readonly kind: BeatKind;
  readonly start_s: number;
  readonly end_s: number;
}

export interface BeatTruth {
  readonly beats: readonly BeatTruthLabel[];
}

export interface BeatMetrics {
  readonly predicted_count: number;
  readonly truth_count?: number;
  readonly count_error_fraction?: number;
  readonly classification_accuracy?: number;
  readonly boundary_accuracy?: number;
  readonly count_within_20_percent?: boolean;
}

export interface BeatSegmentationInput {
  readonly events: readonly OutlineEvent[];
  readonly glossary?: readonly string[];
  readonly npc_ids?: readonly string[];
  readonly config?: BeatSegmentationConfig;
  readonly truth?: BeatTruth;
}

export interface BeatSegmentationResult {
  readonly beats: readonly SegmentedBeat[];
  readonly boundaries: readonly BoundaryCandidate[];
  readonly metrics: BeatMetrics;
}

export class BeatSegmentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeatSegmentationError";
  }
}

const DEFAULT_WEIGHTS: Readonly<Record<BoundarySignalKind, number>> = {
  silence_gap: 5,
  turnorder_transition: 8,
  roll_density: 3,
  speaker_set: 3,
  npc_set: 3,
  glossary_mention: 2,
  dm_scene_open: 4,
};

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new BeatSegmentationError(`${label} must be finite and non-negative`);
  return value;
}

function duration(event: OutlineEvent): number {
  return Math.max(0, event.t_end_s - event.t_start_s);
}

function text(event: OutlineEvent): string {
  return event.text?.trim() ?? "";
}

function setFor(
  events: readonly OutlineEvent[],
  selector: (event: OutlineEvent) => string | null,
): Set<string> {
  return new Set(events.map(selector).filter((value): value is string => value !== null));
}

function jaccardDistance(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return 1 - intersection / union.size;
}

function signal(
  kind: BoundarySignalKind,
  rawScore: number,
  evidence: string,
  weights: Readonly<Record<BoundarySignalKind, number>>,
): BoundarySignal | null {
  if (rawScore <= 0) return null;
  return { kind, score: rawScore * weights[kind], evidence };
}

function rollCount(events: readonly OutlineEvent[]): number {
  return events.reduce((total, event) => total + event.rolls.length, 0);
}

/** A cumulative sum makes a sustained density step beat a single noisy window. */
function rollDensityCusum(left: readonly OutlineEvent[], right: readonly OutlineEvent[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const baseline = rollCount(left) / left.length;
  let cumulative = 0;
  let peak = 0;
  for (const event of right) {
    cumulative = Math.max(0, cumulative + Math.abs(event.rolls.length - baseline) - 0.1);
    peak = Math.max(peak, cumulative);
  }
  return Math.min(1, peak / Math.max(1, right.length));
}

function boundarySignals(
  events: readonly OutlineEvent[],
  index: number,
  glossary: readonly string[],
  npcIds: ReadonlySet<string>,
  config: Required<Pick<BeatSegmentationConfig, "gap_s" | "window_events">> & {
    readonly weights: Readonly<Record<BoundarySignalKind, number>>;
  },
): readonly BoundarySignal[] {
  const current = events[index];
  if (current === undefined) return [];
  const previous = events[index - 1];
  const left = events.slice(Math.max(0, index - config.window_events), index);
  const right = events.slice(index, index + config.window_events);
  const signals: BoundarySignal[] = [];
  const add = (kind: BoundarySignalKind, rawScore: number, evidence: string): void => {
    const item = signal(kind, rawScore, evidence, config.weights);
    if (item !== null) signals.push(item);
  };
  if (previous?.kind === "gap" && duration(previous) >= config.gap_s)
    add(
      "silence_gap",
      Math.min(2, duration(previous) / config.gap_s),
      `silence gap ${duration(previous).toFixed(2)}s`,
    );
  if (current.kind === "combat_start" || current.kind === "combat_end")
    add("turnorder_transition", 1, `${current.kind} transition`);
  const beforeRolls = rollCount(left);
  const afterRolls = rollCount(right);
  const densityChange = rollDensityCusum(left, right);
  add(
    "roll_density",
    Math.min(1, densityChange),
    `roll-density CUSUM ${densityChange.toFixed(3)} (${beforeRolls}/${left.length || 1} to ${afterRolls}/${right.length || 1})`,
  );
  const speakerDistance = jaccardDistance(
    setFor(left, (event) => event.speaker_player_id),
    setFor(right, (event) => event.speaker_player_id),
  );
  add("speaker_set", speakerDistance, `speaker-set Jaccard distance ${speakerDistance.toFixed(3)}`);
  const npcDistance = jaccardDistance(
    setFor(left, (event) =>
      event.speaker_character_id !== null && npcIds.has(event.speaker_character_id)
        ? event.speaker_character_id
        : null,
    ),
    setFor(right, (event) =>
      event.speaker_character_id !== null && npcIds.has(event.speaker_character_id)
        ? event.speaker_character_id
        : null,
    ),
  );
  add("npc_set", npcDistance, `NPC-set Jaccard distance ${npcDistance.toFixed(3)}`);
  const currentText = text(current).toLocaleLowerCase();
  const priorText = left.map(text).join(" ").toLocaleLowerCase();
  const newTerm = glossary.find(
    (term) =>
      currentText.includes(term.toLocaleLowerCase()) &&
      !priorText.includes(term.toLocaleLowerCase()),
  );
  if (newTerm !== undefined) add("glossary_mention", 1, `first glossary mention: ${newTerm}`);
  if (
    current.is_dm &&
    current.mode === "narration" &&
    previous?.kind === "gap" &&
    duration(previous) >= config.gap_s
  )
    add("dm_scene_open", 1, "long DM narration follows silence");
  return signals.sort((a, b) => stableCompare(a.kind, b.kind));
}

export function scoreBeatBoundaries(input: BeatSegmentationInput): readonly BoundaryCandidate[] {
  const events = [...input.events].sort(
    (a, b) => a.t_start_s - b.t_start_s || stableCompare(a.id, b.id),
  );
  const config = input.config ?? {};
  const gapS = config.gap_s ?? BEAT_GAP_S;
  const windowEvents = config.window_events ?? 4;
  if (windowEvents < 1 || !Number.isInteger(windowEvents))
    throw new BeatSegmentationError("window_events must be a positive integer");
  finite(gapS, "gap_s");
  const weights = { ...DEFAULT_WEIGHTS, ...(config.weights ?? {}) };
  const npcIds = new Set(input.npc_ids ?? []);
  return events
    .slice(1)
    .map((event, offset) => {
      const index = offset + 1;
      const signals = boundarySignals(events, index, input.glossary ?? [], npcIds, {
        gap_s: gapS,
        window_events: windowEvents,
        weights,
      });
      return {
        event_index: index,
        t_audio_s: event.t_start_s,
        score: signals.reduce((total, item) => total + item.score, 0),
        signals,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.event_index - b.event_index);
}

function peakPick(
  events: readonly OutlineEvent[],
  candidates: readonly BoundaryCandidate[],
  minimum: number,
): readonly number[] {
  const selected: number[] = [0, events.length];
  const timeAt = (index: number) =>
    index === events.length ? (events.at(-1)?.t_end_s ?? 0) : (events[index]?.t_start_s ?? 0);
  for (const candidate of candidates) {
    if (
      timeAt(candidate.event_index) - timeAt(0) < minimum ||
      timeAt(events.length) - timeAt(candidate.event_index) < minimum
    )
      continue;
    if (selected.some((index) => Math.abs(timeAt(index) - candidate.t_audio_s) < minimum)) continue;
    selected.push(candidate.event_index);
  }
  selected.sort((a, b) => a - b);
  return selected;
}

function classify(events: readonly OutlineEvent[]): BeatKind {
  const speech = events.filter((event) => event.kind === "speech");
  const textValue = events.map(text).join(" ").toLocaleLowerCase();
  if (
    events.some(
      (event) =>
        event.kind === "combat_start" || event.kind === "combat_end" || event.kind === "turnorder",
    ) ||
    events.some((event) =>
      event.rolls.some((roll) =>
        ["attack", "damage", "initiative", "save", "death_save"].includes(roll.kind),
      ),
    )
  )
    return "combat";
  if (
    speech.some((event) => event.mode === "out_of_character" || event.mode === "non_speech") ||
    /\b(rules?|break|recap|previously|character sheet)\b/u.test(textValue)
  )
    return /\b(recap|previously)\b/u.test(textValue) ? "recap" : "table";
  if (/\b(plan|planning|strategy|prepare|preparing)\b/u.test(textValue)) return "planning";
  if (
    speech.length > 1 &&
    new Set(
      speech.map((event) => event.speaker_character_id).filter((id): id is string => id !== null),
    ).size > 1
  )
    return "social";
  return "exploration";
}

function rollCounts(events: readonly OutlineEvent[]): BeatRollCounts {
  const result = {
    attack: 0,
    damage: 0,
    save: 0,
    check: 0,
    initiative: 0,
    death_save: 0,
    other: 0,
  };
  for (const roll of events.flatMap((event) => event.rolls)) result[roll.kind] += 1;
  return result;
}

function titleFor(
  kind: BeatKind,
  events: readonly OutlineEvent[],
  glossary: readonly string[],
  ordinal: number,
): string {
  const haystack = events.map(text).join(" ").toLocaleLowerCase();
  const place = glossary.find((term) => haystack.includes(term.toLocaleLowerCase()));
  const names = [
    ...new Set(
      events
        .map((event) => event.character_display)
        .filter((name): name is string => name !== undefined && name.length > 0),
    ),
  ].sort(stableCompare);
  const subject = place ?? names.slice(0, 2).join(" + ");
  return subject.length > 0 ? `${kind}: ${subject}` : `${kind}: segment ${ordinal}`;
}

function truthMetrics(beats: readonly SegmentedBeat[], truth: BeatTruth | undefined): BeatMetrics {
  if (truth === undefined) return { predicted_count: beats.length };
  const countError = Math.abs(beats.length - truth.beats.length) / Math.max(1, truth.beats.length);
  let classificationMatches = 0;
  let boundaryMatches = 0;
  for (const [index, expected] of truth.beats.entries()) {
    const actual = beats[index];
    if (actual?.kind === expected.kind) classificationMatches += 1;
    if (
      actual !== undefined &&
      Math.abs(actual.start_s - expected.start_s) <= 1 &&
      Math.abs(actual.end_s - expected.end_s) <= 1
    )
      boundaryMatches += 1;
  }
  return {
    predicted_count: beats.length,
    truth_count: truth.beats.length,
    count_error_fraction: countError,
    count_within_20_percent: countError <= 0.2,
    classification_accuracy: classificationMatches / Math.max(1, truth.beats.length),
    boundary_accuracy: boundaryMatches / Math.max(1, truth.beats.length),
  };
}

export function segmentBeats(input: BeatSegmentationInput): BeatSegmentationResult {
  const events = new SessionEventTimeline(
    [...input.events].map((event) => ({ ...event, rolls: [...event.rolls] })),
  ).events;
  if (events.length === 0)
    return { beats: [], boundaries: [], metrics: truthMetrics([], input.truth) };
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.id)) throw new BeatSegmentationError(`duplicate event id ${event.id}`);
    eventIds.add(event.id);
  }
  const minimum = input.config?.min_duration_s ?? MIN_BEAT_DURATION_S;
  finite(minimum, "min_duration_s");
  const candidates = scoreBeatBoundaries({ ...input, events });
  const indexes = peakPick(events, candidates, minimum);
  const byIndex = new Map(candidates.map((candidate) => [candidate.event_index, candidate]));
  const beats: SegmentedBeat[] = [];
  const titleCounts = new Map<string, number>();
  for (let position = 0; position < indexes.length - 1; position += 1) {
    const startIndex = indexes[position]!;
    const endIndex = indexes[position + 1]!;
    const members = events.slice(startIndex, endIndex);
    if (members.length === 0) continue;
    const speech = members.filter((event) => event.kind === "speech");
    const speechDuration = speech.reduce((total, event) => total + duration(event), 0);
    const icDuration = speech
      .filter((event) => event.mode === "in_character")
      .reduce((total, event) => total + duration(event), 0);
    const characterCounts = new Map<string, number>();
    for (const event of speech)
      if (event.speaker_character_id !== null)
        characterCounts.set(
          event.speaker_character_id,
          (characterCounts.get(event.speaker_character_id) ?? 0) + duration(event),
        );
    const dominant = [...characterCounts.entries()]
      .sort((a, b) => b[1] - a[1] || stableCompare(a[0], b[0]))
      .map(([id]) => id);
    const candidate = byIndex.get(startIndex);
    const evidence = candidate?.signals ?? [
      {
        kind: "speaker_set",
        score: 0,
        evidence: startIndex === 0 ? "session start" : "segment start",
      },
    ];
    const participants = [...characterCounts.keys()].sort(stableCompare);
    const kind = classify(members);
    const titleBase = titleFor(kind, members, input.glossary ?? [], position + 1);
    const titleCount = (titleCounts.get(titleBase) ?? 0) + 1;
    titleCounts.set(titleBase, titleCount);
    beats.push({
      id: `b_${String(position + 1)}`,
      kind,
      start_s: members[0]!.t_start_s,
      end_s: members.at(-1)!.t_end_s,
      title: titleCount === 1 ? titleBase : `${titleBase} (${titleCount})`,
      participants,
      event_ids: members.map((event) => event.id),
      utterance_ids: members.flatMap((event) => [...event.source_refs.utterances]),
      roll_ids: members.flatMap((event) => [...event.source_refs.rolls]),
      checks: [],
      boundary_evidence: evidence.map((item) => item.evidence),
      roll_counts: rollCounts(members),
      in_character_speech_ratio: speechDuration === 0 ? 0 : icDuration / speechDuration,
      dominant_characters: dominant,
      boundary_signals: [...evidence],
    });
  }
  const seenUtterances = new Set<string>();
  const seenRolls = new Set<string>();
  for (const beat of beats) {
    for (const id of beat.utterance_ids) {
      if (seenUtterances.has(id))
        throw new BeatSegmentationError(`duplicate utterance reference ${id}`);
      seenUtterances.add(id);
    }
    for (const id of beat.roll_ids) {
      if (seenRolls.has(id)) throw new BeatSegmentationError(`duplicate roll reference ${id}`);
      seenRolls.add(id);
    }
  }
  const assignedEventIds = beats.flatMap((beat) => beat.event_ids);
  if (assignedEventIds.length !== events.length || new Set(assignedEventIds).size !== events.length)
    throw new BeatSegmentationError("events are not assigned to exactly one beat");
  return { beats, boundaries: candidates, metrics: truthMetrics(beats, input.truth) };
}

export const segmentBeatTimeline = segmentBeats;
