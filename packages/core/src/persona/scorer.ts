import { createRequire } from "node:module";
import type {
  Attribution,
  AttributionFile,
  Evidence,
  PersonaMode,
} from "../contracts/attribution.js";
import type { Prosody } from "../contracts/features.js";
type CharacterRef = string;
type PlayerRef = string;
type UtteranceRef = string;

export interface PersonaScorerConfig {
  readonly version: string;
  readonly stage_version: number;
  readonly weights: Readonly<Record<string, number>>;
  readonly thresholds: Readonly<{
    readonly lo: number;
    readonly hi: number;
    readonly match_min_margin: number;
    readonly min_similarity: number;
    readonly min_duration_s: number;
    readonly smoothing_max_confidence: number;
  }>;
}

export interface PersonaProfile {
  readonly character_id: CharacterRef | null;
  readonly similarity: number;
}

export interface PersonaScoringInput {
  readonly utterance_id: UtteranceRef;
  readonly player_id: PlayerRef | null;
  readonly start_s: number;
  readonly end_s: number;
  readonly text: string;
  readonly voice_sim_table?: number;
  readonly voice_sim_character?: number;
  readonly voice_margin?: number;
  readonly prosody_z?: Prosody;
  readonly lex_ooc?: number;
  readonly lex_ic?: number;
  readonly roll_prox?: boolean;
  readonly chat_prox?: boolean;
  readonly addressee?: "dm" | "character" | "table" | "unknown";
  readonly is_backchannel?: boolean;
  readonly overlap?: boolean;
  readonly profiles?: readonly PersonaProfile[];
  readonly active_character_ids?: readonly CharacterRef[];
  readonly quoteSpans?: readonly { start_s: number; end_s: number }[];
}

export interface PersonaAccuracy {
  readonly in_character: {
    readonly correct: number;
    readonly total: number;
    readonly accuracy: number;
  };
  readonly out_of_character: {
    readonly correct: number;
    readonly total: number;
    readonly accuracy: number;
  };
}

export interface PersonaScoreResult {
  readonly file: AttributionFile;
  readonly accuracy?: PersonaAccuracy;
}

export class PersonaConfigError extends Error {
  readonly code = "invalid_persona_config" as const;
  constructor(readonly issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "PersonaConfigError";
  }
}

export function validatePersonaConfig(value: unknown): PersonaScorerConfig {
  const issues: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonaConfigError(["config must be an object"]);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["version"] !== "string" || raw["version"] === "")
    issues.push("version must be non-empty");
  if (
    typeof raw["stage_version"] !== "number" ||
    !Number.isInteger(raw["stage_version"]) ||
    raw["stage_version"] < 1
  )
    issues.push("stage_version must be a positive integer");
  const weights = raw["weights"];
  if (weights === null || typeof weights !== "object" || Array.isArray(weights))
    issues.push("weights must be an object");
  else
    for (const [key, weight] of Object.entries(weights))
      if (typeof weight !== "number" || !Number.isFinite(weight))
        issues.push(`weights.${key} must be finite`);
  const thresholds = raw["thresholds"];
  if (thresholds === null || typeof thresholds !== "object" || Array.isArray(thresholds))
    issues.push("thresholds must be an object");
  else {
    const t = thresholds as Record<string, unknown>;
    for (const key of [
      "lo",
      "hi",
      "match_min_margin",
      "min_similarity",
      "min_duration_s",
      "smoothing_max_confidence",
    ])
      if (typeof t[key] !== "number" || !Number.isFinite(t[key]))
        issues.push(`thresholds.${key} must be finite`);
    if (
      typeof t["lo"] === "number" &&
      typeof t["hi"] === "number" &&
      !(t["lo"] >= 0 && t["lo"] < t["hi"] && t["hi"] <= 1)
    )
      issues.push("thresholds require 0 <= lo < hi <= 1");
    if (typeof t["match_min_margin"] === "number" && t["match_min_margin"] < 0)
      issues.push("thresholds.match_min_margin must be non-negative");
    if (
      typeof t["min_similarity"] === "number" &&
      (t["min_similarity"] < -1 || t["min_similarity"] > 1)
    )
      issues.push("thresholds.min_similarity must be between -1 and 1");
    if (typeof t["min_duration_s"] === "number" && t["min_duration_s"] < 0)
      issues.push("thresholds.min_duration_s must be non-negative");
    if (
      typeof t["smoothing_max_confidence"] === "number" &&
      (t["smoothing_max_confidence"] < 0 || t["smoothing_max_confidence"] > 1)
    )
      issues.push("thresholds.smoothing_max_confidence must be between 0 and 1");
  }
  if (issues.length > 0) throw new PersonaConfigError(issues);
  return value as PersonaScorerConfig;
}

const require = createRequire(import.meta.url);
export function loadConfig(): PersonaScorerConfig {
  return validatePersonaConfig(require("./scorer.config.json"));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-60, Math.min(60, value))));
}

function finite(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function evidenceFor(input: PersonaScoringInput, score: number): Evidence {
  const profiles = input.profiles ?? [];
  const characterScores = profiles
    .filter((profile) => profile.character_id !== null)
    .map((profile) => profile.similarity)
    .sort((a, b) => b - a);
  const bestCharacter = characterScores[0];
  const secondCharacter = characterScores[1];
  return {
    ...(input.voice_sim_table === undefined ? {} : { voice_sim_table: input.voice_sim_table }),
    ...(input.voice_sim_character === undefined
      ? {}
      : { voice_sim_character: input.voice_sim_character }),
    ...(input.voice_margin === undefined ? {} : { voice_margin: input.voice_margin }),
    ...(input.prosody_z === undefined ? {} : { prosody_z: input.prosody_z }),
    ...(input.lex_ooc === undefined ? {} : { lex_ooc: input.lex_ooc }),
    ...(input.lex_ic === undefined ? {} : { lex_ic: input.lex_ic }),
    ...(input.roll_prox === undefined ? {} : { roll_prox: input.roll_prox }),
    ...(input.chat_prox === undefined ? {} : { chat_prox: input.chat_prox }),
    ...(input.addressee === undefined ? {} : { addressee: input.addressee }),
    duration_s: Math.max(0, input.end_s - input.start_s),
    ...(input.is_backchannel === undefined ? {} : { is_backchannel: input.is_backchannel }),
    ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
    ...(bestCharacter === undefined ? {} : { profile_similarity: bestCharacter }),
    ...(bestCharacter === undefined || secondCharacter === undefined
      ? {}
      : { profile_margin: bestCharacter - secondCharacter }),
    profile_match_count: profiles.length,
    score_ic: score,
  };
}

function scoreInput(input: PersonaScoringInput, config: PersonaScorerConfig): number {
  const w = config.weights;
  let value = finite(w["bias"]);
  value += finite(w["voice_sim_table"]) * finite(input.voice_sim_table);
  value += finite(w["voice_sim_character"]) * finite(input.voice_sim_character);
  value += finite(w["voice_margin"]) * finite(input.voice_margin);
  if (input.prosody_z !== undefined) {
    for (const field of [
      "f0_mean",
      "f0_std",
      "f0_range",
      "rate_wps",
      "intensity_mean",
      "intensity_std",
      "spectral_tilt",
      "jitter_proxy",
      "pause_ratio",
    ] as const) {
      value += finite(w[`prosody_${field}`]) * input.prosody_z[field];
    }
  }
  value += finite(w["lex_ooc"]) * finite(input.lex_ooc);
  value += finite(w["lex_ic"]) * finite(input.lex_ic);
  value += finite(w["roll_prox"]) * (input.roll_prox ? 1 : 0);
  value += finite(w["chat_prox"]) * (input.chat_prox ? 1 : 0);
  value += finite(w["duration"]) * Math.min(20, Math.max(0, input.end_s - input.start_s));
  value += finite(w["backchannel"]) * (input.is_backchannel ? 1 : 0);
  value += finite(w["overlap"]) * (input.overlap ? 1 : 0);
  if (input.addressee === "character") value += finite(w["addressee_character"]);
  if (input.addressee === "dm") value += finite(w["addressee_dm"]);
  return sigmoid(value);
}

function nearestCharacter(
  input: PersonaScoringInput,
  config: PersonaScorerConfig,
): CharacterRef | null {
  const active = new Set(input.active_character_ids ?? []);
  const candidates = (input.profiles ?? [])
    .filter(
      (profile) =>
        profile.character_id !== null &&
        active.has(profile.character_id) &&
        profile.similarity >= config.thresholds.min_similarity,
    )
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        String(left.character_id).localeCompare(String(right.character_id)),
    );
  const best = candidates[0];
  const second = candidates[1];
  if (
    best === undefined ||
    (second !== undefined &&
      best.similarity - second.similarity < config.thresholds.match_min_margin)
  )
    return null;
  return best.character_id;
}

function reasonFor(input: PersonaScoringInput, score: number, config: PersonaScorerConfig): string {
  if (input.end_s - input.start_s < config.thresholds.min_duration_s) return "too_short";
  if ((input.profiles ?? []).length === 0) return "no_profile_match";
  if (input.voice_margin !== undefined && input.voice_margin < config.thresholds.match_min_margin)
    return "voice_margin_low";
  if (finite(input.lex_ooc) > finite(input.lex_ic)) return "lex_conflict";
  if (input.overlap) return "overlapped";
  return score >= config.thresholds.hi || score <= config.thresholds.lo
    ? "score_band"
    : "insufficient_evidence";
}

function one(input: PersonaScoringInput, config: PersonaScorerConfig): Attribution {
  const score = scoreInput(input, config);
  const duration = input.end_s - input.start_s;
  let mode: PersonaMode =
    score >= config.thresholds.hi
      ? "in_character"
      : score <= config.thresholds.lo
        ? "out_of_character"
        : "uncertain";
  const flags: Attribution["flags"] = [];
  let character_id: CharacterRef | null = null;
  if ((input.profiles ?? []).length === 0) {
    mode = "uncertain";
    flags.push({
      code: "no_profile_match",
      reason: "the profile bank has no usable character profile",
    });
  }
  const hasQuotes = (input.quoteSpans ?? []).length > 0;
  const childCharacter = hasQuotes ? nearestCharacter(input, config) : null;
  if (hasQuotes) {
    mode = "narration";
    character_id = null;
  }
  if (duration < config.thresholds.min_duration_s) {
    mode = "uncertain";
    flags.push({ code: "too_short", reason: "utterance is shorter than the scorer minimum" });
  }
  if (mode === "uncertain")
    flags.push({
      code: reasonFor(input, score, config),
      reason: "scorer could not make a banded decision",
    });
  if (mode === "in_character") {
    character_id = nearestCharacter(input, config);
    if (character_id === null) {
      flags.push({
        code: "character_unknown",
        reason: "no active profile exceeded the match margin",
      });
    }
  }
  const confidence = Math.abs(score - 0.5) * 2;
  return {
    utterance_id: input.utterance_id,
    mode,
    character_id,
    confidence,
    evidence: evidenceFor(input, score),
    flags,
    children: (input.quoteSpans ?? []).map((quote) => ({
      start_s: quote.start_s,
      end_s: quote.end_s,
      mode: "in_character" as const,
      character_id: childCharacter,
      confidence,
    })),
    source: "deterministic",
    overridden_from: null,
  };
}

function smooth(attributions: Attribution[], config: PersonaScorerConfig): void {
  for (let index = 1; index + 1 < attributions.length; index += 1) {
    const previous = attributions[index - 1];
    const current = attributions[index];
    const next = attributions[index + 1];
    if (previous === undefined || current === undefined || next === undefined) continue;
    if (
      previous.mode !== next.mode ||
      current.mode === previous.mode ||
      current.mode === "narration" ||
      current.children.length > 0 ||
      current.flags.some((flag) => flag.code === "no_profile_match") ||
      current.evidence.score_ic === undefined ||
      current.evidence.score_ic < config.thresholds.lo ||
      current.evidence.score_ic > config.thresholds.hi ||
      current.confidence > config.thresholds.smoothing_max_confidence
    )
      continue;
    current.overridden_from = current.mode;
    current.mode = previous.mode;
    current.character_id = previous.character_id;
    current.flags = [
      ...current.flags,
      { code: "smoothing_applied", reason: "weak isolated mode corrected to matching neighbours" },
    ];
  }
}

export function scorePersona(
  inputs: readonly PersonaScoringInput[],
  config: PersonaScorerConfig,
  truth?: Readonly<Record<string, "in_character" | "out_of_character">>,
): PersonaScoreResult {
  config = validatePersonaConfig(config);
  const attributions = inputs.map((input) => one(input, config));
  smooth(attributions, config);
  const summary = {
    in_character: 0,
    out_of_character: 0,
    narration: 0,
    uncertain: 0,
    unknown_character: 0,
  };
  for (const attribution of attributions) {
    if (attribution.mode in summary) summary[attribution.mode as keyof typeof summary] += 1;
    if (attribution.mode === "in_character" && attribution.character_id === null)
      summary.unknown_character += 1;
  }
  if (truth === undefined)
    return { file: { attributions, summary, weights_version: config.version } };
  const totals = {
    in_character: { correct: 0, total: 0, accuracy: 0 },
    out_of_character: { correct: 0, total: 0, accuracy: 0 },
  };
  for (const attribution of attributions) {
    const expected = truth[attribution.utterance_id];
    if (expected === undefined) continue;
    const bucket = totals[expected];
    bucket.total += 1;
    if (attribution.mode === expected) bucket.correct += 1;
  }
  totals.in_character.accuracy =
    totals.in_character.total === 0 ? 0 : totals.in_character.correct / totals.in_character.total;
  totals.out_of_character.accuracy =
    totals.out_of_character.total === 0
      ? 0
      : totals.out_of_character.correct / totals.out_of_character.total;
  return { file: { attributions, summary, weights_version: config.version }, accuracy: totals };
}
