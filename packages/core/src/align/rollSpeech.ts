import type { TimeBasis } from "../contracts/manifest.js";
import type { AnchoredRoll, Roll } from "../contracts/timeline.js";
import type { Utterance } from "../contracts/utterances.js";
import { normalizeLexicalText } from "../persona/lexical.js";

export interface AlignRoll extends Roll {
  readonly expected_time_s?: number | null;
}

export interface AlignOptions {
  readonly timeBasis?: TimeBasis;
  readonly threshold?: number;
  readonly rollGapPenalty?: number;
  readonly utteranceGapPenalty?: number;
}

export interface AlignmentQuality {
  readonly anchored_fraction: number;
  readonly median_residual_s: number | null;
  readonly largest_unanchored_gap_s: number | null;
  readonly clock_drift_s: number | null;
}

export interface SequenceFitPoint {
  readonly seq: number;
  readonly t_audio_s: number;
  readonly roll_id: string;
  readonly utterance_id: string;
}

export interface SequenceFit {
  readonly points: readonly SequenceFitPoint[];
  readonly residual_scale_s: number;
  readonly fallback_s_per_seq: number;
}

export interface RollAlignmentResult {
  readonly anchors: readonly AnchoredRoll[];
  readonly quality: AlignmentQuality;
  readonly fit: SequenceFit;
}

interface Candidate {
  readonly roll: AlignRoll;
  readonly utterance: Utterance;
  readonly score: number;
}

interface ProjectedSequence {
  readonly t_audio_s: number;
  readonly t_uncertainty_s: number;
  readonly anchor: "interpolated" | "extrapolated";
}

const DEFAULT_THRESHOLD = 8;
const TEMPORAL_TOLERANCE_S = 60;

const CUES: Readonly<Record<Roll["kind"], readonly string[]>> = {
  attack: ["attack", "hit", "armor class"],
  damage: ["damage"],
  save: ["save", "saving throw"],
  check: ["check", "ability"],
  initiative: ["initiative"],
  death_save: ["death save", "death saving throw"],
  other: [],
};

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function utteranceNumbers(text: string): Set<number> {
  const normalized = normalizeLexicalText(text);
  const values = normalized
    .split(" ")
    .filter((token) => /^-?\d+(?:\.\d+)?$/u.test(token))
    .map(Number)
    .filter(Number.isFinite);
  return new Set(values);
}

function utteranceMidpoint(utterance: Utterance): number {
  return (utterance.start_s + utterance.end_s) / 2;
}

/** Explainable candidate score used by the global monotonic aligner. */
export function scoreRollUtterance(
  roll: AlignRoll,
  utterance: Utterance,
  timeBasis: TimeBasis = "order_only",
): number {
  const values = utteranceNumbers(utterance.text);
  const totalAgreement = values.has(roll.total);
  const dieAgreement = roll.dice.some((die) => !die.dropped && values.has(die.value));
  let score = totalAgreement ? 10 : dieAgreement ? 8 : 0;
  if (roll.player_id !== null && utterance.player_id === roll.player_id) score += 3;
  const normalized = normalizeLexicalText(utterance.text);
  if (CUES[roll.kind].some((cue) => normalized.includes(cue))) score += 1;
  if (
    timeBasis !== "order_only" &&
    roll.expected_time_s !== null &&
    roll.expected_time_s !== undefined
  ) {
    const distance = Math.abs(utteranceMidpoint(utterance) - roll.expected_time_s);
    score += Math.max(0, 2 * (1 - distance / TEMPORAL_TOLERANCE_S));
  }
  return score;
}

function globallyMatch(
  rolls: readonly AlignRoll[],
  utterances: readonly Utterance[],
  options: AlignOptions,
): Candidate[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const rollGap = -(options.rollGapPenalty ?? 1);
  const utteranceGap = -(options.utteranceGapPenalty ?? 0.05);
  const rows = rolls.length + 1;
  const columns = utterances.length + 1;
  const scores = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  const moves = Array.from({ length: rows }, () =>
    Array<"match" | "roll_gap" | "utterance_gap">(columns).fill("roll_gap"),
  );
  for (let row = 1; row < rows; row += 1) scores[row]![0] = scores[row - 1]![0]! + rollGap;
  for (let column = 1; column < columns; column += 1) {
    scores[0]![column] = scores[0]![column - 1]! + utteranceGap;
    moves[0]![column] = "utterance_gap";
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const candidateScore = scoreRollUtterance(
        rolls[row - 1]!,
        utterances[column - 1]!,
        options.timeBasis,
      );
      const choices = [
        {
          move: "match" as const,
          score:
            candidateScore >= threshold
              ? scores[row - 1]![column - 1]! + candidateScore
              : Number.NEGATIVE_INFINITY,
          priority: 2,
        },
        {
          move: "roll_gap" as const,
          score: scores[row - 1]![column]! + rollGap,
          priority: 1,
        },
        {
          move: "utterance_gap" as const,
          score: scores[row]![column - 1]! + utteranceGap,
          priority: 0,
        },
      ].sort((left, right) => right.score - left.score || right.priority - left.priority);
      scores[row]![column] = choices[0]!.score;
      moves[row]![column] = choices[0]!.move;
    }
  }

  const matches: Candidate[] = [];
  let row = rolls.length;
  let column = utterances.length;
  while (row > 0 || column > 0) {
    const move = moves[row]![column]!;
    if (row > 0 && column > 0 && move === "match") {
      const roll = rolls[row - 1]!;
      const utterance = utterances[column - 1]!;
      matches.unshift({
        roll,
        utterance,
        score: scoreRollUtterance(roll, utterance, options.timeBasis),
      });
      row -= 1;
      column -= 1;
    } else if (row > 0 && (column === 0 || move === "roll_gap")) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return matches;
}

function robustFitPoints(matches: readonly Candidate[]): SequenceFit {
  const points = matches.map((match) => ({
    seq: match.roll.seq,
    t_audio_s: utteranceMidpoint(match.utterance),
    roll_id: match.roll.id,
    utterance_id: match.utterance.id,
  }));
  if (points.length < 3) {
    const fallback =
      points.length === 2
        ? Math.max(
            0,
            (points[1]!.t_audio_s - points[0]!.t_audio_s) / (points[1]!.seq - points[0]!.seq),
          )
        : 1;
    return { points, residual_scale_s: 0.25, fallback_s_per_seq: fallback || 1 };
  }

  // Campaign pacing is intentionally nonlinear, so reject only isolated
  // interior spikes against the line through their immediate neighbours.
  const localDeviations = points.slice(1, -1).map((point, index) => {
    const before = points[index]!;
    const after = points[index + 2]!;
    const fraction = (point.seq - before.seq) / (after.seq - before.seq);
    const expected = before.t_audio_s + fraction * (after.t_audio_s - before.t_audio_s);
    return Math.abs(point.t_audio_s - expected);
  });
  const cutoff = Math.max(20, median(localDeviations) ?? 0);
  const inliers = points.filter(
    (_point, index) =>
      index === 0 || index === points.length - 1 || (localDeviations[index - 1] ?? 0) <= cutoff,
  );
  const retained = inliers.length >= 2 ? inliers : points;
  const slopes = retained.slice(1).map((point, index) => {
    const before = retained[index]!;
    return (point.t_audio_s - before.t_audio_s) / (point.seq - before.seq);
  });
  const slope = Math.max(0, median(slopes) ?? 1);
  return {
    points: retained,
    residual_scale_s: Math.max(0.25, median(localDeviations) ?? 0.25),
    fallback_s_per_seq: slope || 1,
  };
}

/** Project any Roll20 sequence position through the robust piecewise-linear fit. */
export function projectSequence(
  seq: number,
  fit: SequenceFit,
  expectedTimeS?: number | null,
): ProjectedSequence {
  const points = fit.points;
  if (points.length === 0) {
    return {
      t_audio_s: Math.max(0, expectedTimeS ?? seq * fit.fallback_s_per_seq),
      t_uncertainty_s: fit.residual_scale_s + 10,
      anchor: "extrapolated",
    };
  }
  const before = [...points].reverse().find((point) => point.seq < seq);
  const after = points.find((point) => point.seq > seq);
  if (before !== undefined && after !== undefined) {
    const fraction = (seq - before.seq) / (after.seq - before.seq);
    const nearestDistance = Math.min(seq - before.seq, after.seq - seq);
    return {
      t_audio_s: before.t_audio_s + fraction * (after.t_audio_s - before.t_audio_s),
      t_uncertainty_s: fit.residual_scale_s + 0.5 + nearestDistance * 0.5,
      anchor: "interpolated",
    };
  }
  const nearest = before ?? after ?? points[0]!;
  const direction = seq - nearest.seq;
  const localSlope = (() => {
    if (points.length < 2) return fit.fallback_s_per_seq;
    const left = before === undefined ? points[0]! : points.at(-2)!;
    const right = before === undefined ? points[1]! : points.at(-1)!;
    return Math.max(0, (right.t_audio_s - left.t_audio_s) / (right.seq - left.seq));
  })();
  return {
    t_audio_s: Math.max(0, nearest.t_audio_s + direction * localSlope),
    t_uncertainty_s: fit.residual_scale_s + 1 + Math.abs(direction),
    anchor: "extrapolated",
  };
}

function largestUnanchoredGap(anchors: readonly AnchoredRoll[]): number | null {
  let largest: number | null = null;
  let index = 0;
  while (index < anchors.length) {
    if (anchors[index]!.anchor === "matched") {
      index += 1;
      continue;
    }
    const first = index;
    while (index + 1 < anchors.length && anchors[index + 1]!.anchor !== "matched") index += 1;
    const last = index;
    const left = anchors[first - 1]?.t_audio_s ?? anchors[first]!.t_audio_s;
    const right = anchors[last + 1]?.t_audio_s ?? anchors[last]!.t_audio_s;
    const gap = Math.max(0, right - left);
    largest = largest === null ? gap : Math.max(largest, gap);
    index += 1;
  }
  return largest;
}

/** Align rolls to speech without ever violating Roll20 or audio monotonicity. */
export function alignRolls(
  rolls: readonly AlignRoll[],
  utterances: readonly Utterance[],
  options: AlignOptions = {},
): RollAlignmentResult {
  const orderedRolls = [...rolls].sort(
    (left, right) => left.seq - right.seq || left.id.localeCompare(right.id),
  );
  const orderedUtterances = [...utterances].sort(
    (left, right) => left.start_s - right.start_s || left.id.localeCompare(right.id),
  );
  const matches = globallyMatch(orderedRolls, orderedUtterances, options);
  const fit = robustFitPoints(matches);
  const retainedIds = new Set(fit.points.map((point) => point.roll_id));
  const matchByRoll = new Map(
    matches
      .filter((match) => retainedIds.has(match.roll.id))
      .map((match) => [match.roll.id, match]),
  );
  const expectedResiduals: number[] = [];
  let previousTime = 0;
  const anchors = orderedRolls.map((roll): AnchoredRoll => {
    const match = matchByRoll.get(roll.id);
    let result: AnchoredRoll;
    if (match !== undefined) {
      const time = utteranceMidpoint(match.utterance);
      if (roll.expected_time_s !== null && roll.expected_time_s !== undefined) {
        expectedResiduals.push(time - roll.expected_time_s);
      }
      result = {
        roll_id: roll.id,
        t_audio_s: time,
        t_uncertainty_s: fit.residual_scale_s,
        anchor: "matched",
        matched_utterance_id: match.utterance.id,
      };
    } else {
      const projected = projectSequence(roll.seq, fit, roll.expected_time_s);
      result = {
        roll_id: roll.id,
        t_audio_s: projected.t_audio_s,
        t_uncertainty_s: projected.t_uncertainty_s,
        anchor: projected.anchor,
        matched_utterance_id: null,
      };
    }
    previousTime = Math.max(previousTime, result.t_audio_s);
    return { ...result, t_audio_s: previousTime };
  });
  const fitResiduals = fit.points.map((point) => {
    const others = fit.points.filter((candidate) => candidate.roll_id !== point.roll_id);
    if (others.length === 0) return 0;
    const projected = projectSequence(point.seq, { ...fit, points: others });
    return Math.abs(point.t_audio_s - projected.t_audio_s);
  });
  return {
    anchors,
    fit,
    quality: {
      anchored_fraction: orderedRolls.length === 0 ? 0 : fit.points.length / orderedRolls.length,
      median_residual_s: median(expectedResiduals.map(Math.abs)) ?? median(fitResiduals) ?? null,
      largest_unanchored_gap_s: largestUnanchoredGap(anchors),
      clock_drift_s: options.timeBasis === "wallclock" ? (median(expectedResiduals) ?? null) : null,
    },
  };
}
