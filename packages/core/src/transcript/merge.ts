import type { QaEntry } from "../contracts/common.js";
import type { Transcript, Utterance, Word } from "../contracts/utterances.js";

/** Speech windows returned by the VAD sidecar. */
export interface VadSegmentInput {
  readonly start_s?: unknown;
  readonly end_s?: unknown;
  readonly mean_rms?: unknown;
  readonly [key: string]: unknown;
}

/** A backend-normalised ASR segment. Unknown fields are ignored deliberately. */
export interface AsrSegmentInput {
  readonly start_s?: unknown;
  readonly end_s?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly text?: unknown;
  readonly words?: unknown;
  readonly avg_logprob?: unknown;
  readonly no_speech_prob?: unknown;
  readonly [key: string]: unknown;
}

/** One track's VAD and ASR results before cross-track merging. */
export interface TrackTranscriptInput {
  readonly track_id: string;
  readonly player_id: string | null;
  readonly vad_segments: readonly VadSegmentInput[];
  readonly asr_segments: readonly AsrSegmentInput[];
  readonly backend?: string;
  readonly model?: string;
}

export interface MergeTranscriptOptions {
  /** Minimum cross-track interval intersection that counts as overlap. */
  readonly overlap_min_s?: number;
  /** Maximum start-time distance for a possible mic-bleed pair. */
  readonly bleed_window_s?: number;
  /** Minimum normalised text similarity for a possible mic-bleed pair. */
  readonly bleed_similarity?: number;
  /** Word gap that starts a new addressable sentence span. */
  readonly sentence_gap_min_s?: number;
  /** Maximum duration for an acknowledgement to be a backchannel. */
  readonly backchannel_max_s?: number;
}

export interface MergeTranscriptResult {
  readonly transcript: Transcript;
  readonly qa: readonly QaEntry[];
}

export const OVERLAP_MIN_S = 0.2;
export const BLEED_WINDOW_S = 0.75;
export const BLEED_TEXT_SIMILARITY = 0.85;
export const SENTENCE_GAP_MIN_S = 0.75;
export const BACKCHANNEL_MAX_S = 1.5;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface CanonicalWord {
  readonly t: string;
  readonly s: number;
  readonly e: number;
}

interface WorkingUtterance {
  readonly track_id: string;
  readonly player_id: string | null;
  readonly start_s: number;
  readonly end_s: number;
  readonly text: string;
  readonly words: readonly CanonicalWord[];
  readonly asr: Utterance["asr"];
  readonly energy: number;
  readonly source_index: number;
}

interface IdentifiedUtterance extends WorkingUtterance {
  readonly id: string;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function wordsFrom(value: unknown): CanonicalWord[] {
  if (!Array.isArray(value)) return [];
  const words: CanonicalWord[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const word = textValue(raw["t"] ?? raw["word"] ?? raw["text"]);
    const start = raw["s"] ?? raw["start"];
    const end = raw["e"] ?? raw["end"];
    if (word === "" || typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) continue;
    words.push({ t: word, s: rounded(start), e: rounded(end) });
  }
  return words.sort(
    (left, right) => left.s - right.s || left.e - right.e || compareStrings(left.t, right.t),
  );
}

function asrMetadata(input: TrackTranscriptInput, segment: AsrSegmentInput): Utterance["asr"] {
  const backend = typeof input.backend === "string" ? input.backend : "";
  const model = typeof input.model === "string" ? input.model : "";
  if (backend === "" || model === "") return undefined;

  const rawAverage = segment.avg_logprob;
  const rawNoSpeech = segment.no_speech_prob;
  const average =
    typeof rawAverage === "number" && Number.isFinite(rawAverage) ? rawAverage : undefined;
  const noSpeech =
    typeof rawNoSpeech === "number" && Number.isFinite(rawNoSpeech) ? rawNoSpeech : undefined;
  return {
    backend,
    model,
    ...(average === undefined ? {} : { avg_logprob: rounded(average) }),
    ...(noSpeech === undefined ? {} : { no_speech_prob: rounded(noSpeech) }),
  };
}

function vadValues(
  input: VadSegmentInput,
  trackId: string,
  index: number,
): {
  readonly start_s: number;
  readonly end_s: number;
  readonly mean_rms: number;
} {
  const start = finite(input.start_s, `VAD ${trackId}[${String(index)}].start_s`);
  const end = finite(input.end_s, `VAD ${trackId}[${String(index)}].end_s`);
  if (start < 0 || end <= start) {
    throw new Error(`VAD ${trackId}[${String(index)}] has an invalid interval`);
  }
  const energy =
    typeof input.mean_rms === "number" && Number.isFinite(input.mean_rms)
      ? Math.max(0, input.mean_rms)
      : 0;
  return { start_s: start, end_s: end, mean_rms: energy };
}

function asrValues(
  input: AsrSegmentInput,
  trackId: string,
  index: number,
): {
  readonly start_s: number;
  readonly end_s: number;
  readonly text: string;
  readonly words: CanonicalWord[];
} {
  const startRaw = input.start_s ?? input.start;
  const endRaw = input.end_s ?? input.end;
  const start = finite(startRaw, `ASR ${trackId}[${String(index)}].start_s`);
  const end = finite(endRaw, `ASR ${trackId}[${String(index)}].end_s`);
  if (start < 0 || end <= start) {
    throw new Error(`ASR ${trackId}[${String(index)}] has an invalid interval`);
  }
  return {
    start_s: start,
    end_s: end,
    text: textValue(input.text),
    words: wordsFrom(input.words),
  };
}

function energyFor(
  start: number,
  end: number,
  vad: readonly { readonly start_s: number; readonly end_s: number; readonly mean_rms: number }[],
): number {
  let bestOverlap = 0;
  let bestEnergy = 0;
  for (const window of vad) {
    const overlap = Math.min(end, window.end_s) - Math.max(start, window.start_s);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestEnergy = window.mean_rms;
    }
  }
  return bestEnergy;
}

function splitAtWordGaps(source: WorkingUtterance, gapThreshold: number): WorkingUtterance[] {
  if (source.words.length < 2) return [source];

  const groups: CanonicalWord[][] = [[]];
  for (const word of source.words) {
    const current = groups.at(-1);
    if (current === undefined) throw new Error("word grouping lost its current group");
    const previous = current.at(-1);
    if (previous !== undefined && word.s - previous.e > gapThreshold) groups.push([]);
    groups.at(-1)?.push(word);
  }
  if (groups.length === 1) return [source];

  return groups.map((words, index) => {
    const first = words[0];
    const last = words.at(-1);
    if (first === undefined || last === undefined) throw new Error("empty sentence group");
    const firstSpan = index === 0 ? source.start_s : first.s;
    const lastSpan = index === groups.length - 1 ? source.end_s : last.e;
    const pieceText = words.map((word) => word.t).join(" ");
    return {
      ...source,
      start_s: rounded(Math.max(source.start_s, firstSpan)),
      end_s: rounded(Math.min(source.end_s, lastSpan)),
      text: pieceText === "" ? source.text : pieceText,
      words,
    };
  });
}

function normaliseForComparison(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function editSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left === "" || right === "") return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min((previous[j - 1] ?? 0) + 1, above + 1, diagonal + cost);
      diagonal = above;
    }
  }
  const distance = previous[right.length] ?? Math.max(left.length, right.length);
  return 1 - distance / Math.max(left.length, right.length);
}

function textSimilarity(left: string, right: string): number {
  const normalLeft = normaliseForComparison(left);
  const normalRight = normaliseForComparison(right);
  if (normalLeft === "" || normalRight === "") return 0;
  if (normalLeft === normalRight) return 1;
  const leftWords = new Set(normalLeft.split(" "));
  const rightWords = new Set(normalRight.split(" "));
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  const union = new Set([...leftWords, ...rightWords]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  return Math.max(jaccard, editSimilarity(normalLeft, normalRight));
}

function isBackchannel(text: string, duration: number, maxDuration: number): boolean {
  if (duration > maxDuration) return false;
  const normal = normaliseForComparison(text);
  return /^(?:yeah|yea|yes|yep|yup|mhm|mm hm|uh huh|uhhuh|okay|ok|right|sure|no|nope|hmm|hm|mm|got it|gotcha|all right|alright)$/u.test(
    normal,
  );
}

function primaryIsLeft(left: IdentifiedUtterance, right: IdentifiedUtterance): boolean {
  if (Math.abs(left.energy - right.energy) > 1e-12) return left.energy > right.energy;
  return (
    compareStrings(left.track_id, right.track_id) < 0 ||
    (left.track_id === right.track_id && left.source_index < right.source_index)
  );
}

function pairKey(left: IdentifiedUtterance, right: IdentifiedUtterance): string {
  return [left.track_id, right.track_id].sort(compareStrings).join(",");
}

function buildBleedGroups(
  utterances: readonly IdentifiedUtterance[],
  windowSeconds: number,
  similarityThreshold: number,
): { readonly bleedOf: Map<string, string>; readonly qa: QaEntry[] } {
  const adjacency = new Map<string, Set<string>>();
  const edges: Array<readonly [IdentifiedUtterance, IdentifiedUtterance]> = [];
  const qa = new Map<string, QaEntry>();
  for (let leftIndex = 0; leftIndex < utterances.length; leftIndex += 1) {
    const left = utterances[leftIndex];
    if (left === undefined || normaliseForComparison(left.text) === "") continue;
    for (let rightIndex = leftIndex + 1; rightIndex < utterances.length; rightIndex += 1) {
      const right = utterances[rightIndex];
      if (right === undefined || left.track_id === right.track_id) continue;
      if (Math.abs(left.start_s - right.start_s) > windowSeconds) continue;
      if (textSimilarity(left.text, right.text) < similarityThreshold) continue;
      edges.push([left, right]);
      const leftPeers = adjacency.get(left.id) ?? new Set<string>();
      const rightPeers = adjacency.get(right.id) ?? new Set<string>();
      leftPeers.add(right.id);
      rightPeers.add(left.id);
      adjacency.set(left.id, leftPeers);
      adjacency.set(right.id, rightPeers);
      const primary = primaryIsLeft(left, right) ? left : right;
      const pair = pairKey(left, right);
      qa.set(pair, {
        code: "MIC_BLEED",
        severity: "warning",
        message: `near-duplicate speech detected across tracks ${pair}; ${primary.track_id} is the primary copy`,
        subject: pair,
        hint: `inspect the microphone placement for tracks ${pair}; keep only the louder source when reviewing audio`,
      });
    }
  }

  const byId = new Map(utterances.map((utterance) => [utterance.id, utterance]));
  const bleedOf = new Map<string, string>();
  const visited = new Set<string>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const component: IdentifiedUtterance[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      const utterance = byId.get(current);
      if (utterance !== undefined) component.push(utterance);
      for (const peer of adjacency.get(current) ?? []) {
        if (!visited.has(peer)) {
          visited.add(peer);
          queue.push(peer);
        }
      }
    }
    const primary = component.reduce((best, candidate) =>
      primaryIsLeft(best, candidate) ? best : candidate,
    );
    for (const candidate of component) {
      if (candidate.id !== primary.id) bleedOf.set(candidate.id, primary.id);
    }
  }

  // Keep this assertion close to the graph construction: an edge must always
  // have produced a QA pair, even when a three-track component is collapsed.
  for (const [left, right] of edges) {
    if (!qa.has(pairKey(left, right))) throw new Error("mic-bleed edge lost its QA entry");
  }
  return {
    bleedOf,
    qa: [...qa.values()].sort((left, right) =>
      compareStrings(left.subject ?? "", right.subject ?? ""),
    ),
  };
}

function buildWorkingUtterances(input: TrackTranscriptInput): {
  readonly utterances: WorkingUtterance[];
  readonly speechSeconds: number;
} {
  const vad = input.vad_segments.map((segment, index) => vadValues(segment, input.track_id, index));
  const speechSeconds = vad.reduce((total, segment) => total + segment.end_s - segment.start_s, 0);
  const utterances: WorkingUtterance[] = [];
  input.asr_segments.forEach((segment, index) => {
    const values = asrValues(segment, input.track_id, index);
    utterances.push({
      track_id: input.track_id,
      player_id: input.player_id,
      start_s: rounded(values.start_s),
      end_s: rounded(values.end_s),
      text: values.text,
      words: values.words,
      asr: asrMetadata(input, segment),
      energy: energyFor(values.start_s, values.end_s, vad),
      source_index: index,
    });
  });
  return { utterances, speechSeconds };
}

function asUtterance(
  source: IdentifiedUtterance,
  overlapIds: readonly string[],
  bleedOf: string | null,
  backchannelMax: number,
): Utterance {
  return {
    id: source.id,
    track_id: source.track_id,
    player_id: source.player_id,
    start_s: rounded(source.start_s),
    end_s: rounded(source.end_s),
    text: source.text,
    words: source.words.map((word): Word => ({
      t: word.t,
      s: rounded(word.s),
      e: rounded(word.e),
    })),
    ...(source.asr === undefined ? {} : { asr: source.asr }),
    overlap_ids: [...overlapIds].sort(compareStrings),
    bleed_of: bleedOf,
    is_backchannel: isBackchannel(source.text, source.end_s - source.start_s, backchannelMax),
  };
}

/** Merge all per-track VAD/ASR results into the canonical transcript artifact. */
export function mergeTranscripts(
  inputs: readonly TrackTranscriptInput[],
  options: MergeTranscriptOptions = {},
): MergeTranscriptResult {
  const overlapMinimum = options.overlap_min_s ?? OVERLAP_MIN_S;
  const bleedWindow = options.bleed_window_s ?? BLEED_WINDOW_S;
  const bleedSimilarity = options.bleed_similarity ?? BLEED_TEXT_SIMILARITY;
  const sentenceGap = options.sentence_gap_min_s ?? SENTENCE_GAP_MIN_S;
  const backchannelMaximum = options.backchannel_max_s ?? BACKCHANNEL_MAX_S;
  for (const [name, value] of [
    ["overlap_min_s", overlapMinimum],
    ["bleed_window_s", bleedWindow],
    ["bleed_similarity", bleedSimilarity],
    ["sentence_gap_min_s", sentenceGap],
    ["backchannel_max_s", backchannelMaximum],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  }
  if (bleedSimilarity > 1) throw new RangeError("bleed_similarity must be at most one");

  const speechSeconds = new Map<string, number>();
  const expanded: WorkingUtterance[] = [];
  for (const input of [...inputs].sort((left, right) =>
    compareStrings(left.track_id, right.track_id),
  )) {
    if (!speechSeconds.has(input.player_id ?? "")) speechSeconds.set(input.player_id ?? "", 0);
    const built = buildWorkingUtterances(input);
    if (input.player_id !== null) {
      speechSeconds.set(
        input.player_id,
        (speechSeconds.get(input.player_id) ?? 0) + built.speechSeconds,
      );
    }
    for (const utterance of built.utterances)
      expanded.push(...splitAtWordGaps(utterance, sentenceGap));
  }

  expanded.sort(
    (left, right) =>
      left.start_s - right.start_s ||
      compareStrings(left.track_id, right.track_id) ||
      left.end_s - right.end_s ||
      compareStrings(left.text, right.text) ||
      left.source_index - right.source_index,
  );
  const identified: IdentifiedUtterance[] = expanded.map((utterance, index) => ({
    ...utterance,
    id: `u${String(index + 1).padStart(6, "0")}`,
  }));

  const overlaps = new Map<string, Set<string>>();
  for (let leftIndex = 0; leftIndex < identified.length; leftIndex += 1) {
    const left = identified[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < identified.length; rightIndex += 1) {
      const right = identified[rightIndex];
      if (right === undefined || left.track_id === right.track_id) continue;
      const intersection =
        Math.min(left.end_s, right.end_s) - Math.max(left.start_s, right.start_s);
      if (intersection <= overlapMinimum) continue;
      const leftIds = overlaps.get(left.id) ?? new Set<string>();
      const rightIds = overlaps.get(right.id) ?? new Set<string>();
      leftIds.add(right.id);
      rightIds.add(left.id);
      overlaps.set(left.id, leftIds);
      overlaps.set(right.id, rightIds);
    }
  }

  const bleed = buildBleedGroups(identified, bleedWindow, bleedSimilarity);
  const utterances = identified.map((utterance) =>
    asUtterance(
      utterance,
      [...(overlaps.get(utterance.id) ?? new Set<string>())],
      bleed.bleedOf.get(utterance.id) ?? null,
      backchannelMaximum,
    ),
  );
  const speechSecondsByPlayer: Record<string, number> = {};
  for (const playerId of [...speechSeconds.keys()].filter((id) => id !== "").sort()) {
    speechSecondsByPlayer[playerId] = rounded(speechSeconds.get(playerId) ?? 0);
  }
  return {
    transcript: {
      utterances,
      counts: { utterances: utterances.length, speech_seconds_by_player: speechSecondsByPlayer },
    },
    qa: bleed.qa,
  };
}

/** Singular alias for callers that process one merged session at a time. */
export const mergeTranscript = mergeTranscripts;

/** Descriptive alias used by timeline-oriented callers. */
export const mergeTimeline = mergeTranscripts;
