import type { Lexicon } from "../contracts/campaign.js";
import type { Word } from "../contracts/index.js";

export type LexicalPolarity = "ooc" | "ic";

export interface LexicalClassRule {
  readonly weight: number;
  readonly terms: readonly string[];
  readonly polarity?: LexicalPolarity;
}

export interface LexicalValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class LexicalValidationError extends Error {
  readonly code = "invalid_lexicon" as const;

  constructor(readonly issues: readonly LexicalValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "LexicalValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate campaign overrides before table expansion so malformed data fails as a stable error. */
export function validateLexicon(
  value: unknown,
): asserts value is Readonly<Record<string, LexicalClassRule>> {
  const issues: LexicalValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new LexicalValidationError([{ path: "lexicon", message: "must be an object" }]);
  }
  for (const [className, rawRule] of Object.entries(value)) {
    const classPath = `lexicon.${className}`;
    if (normalizeLexicalText(className) === "") {
      issues.push({ path: classPath, message: "class name must contain a word" });
    }
    if (!isRecord(rawRule)) {
      issues.push({ path: classPath, message: "class rule must be an object" });
      continue;
    }
    const weight = rawRule["weight"];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0)
      issues.push({ path: `${classPath}.weight`, message: "must be a finite non-negative number" });
    const polarity = rawRule["polarity"];
    if (polarity !== undefined && polarity !== "ooc" && polarity !== "ic")
      issues.push({ path: `${classPath}.polarity`, message: "must be ooc or ic" });
    const terms = rawRule["terms"];
    if (!Array.isArray(terms)) {
      issues.push({ path: `${classPath}.terms`, message: "must be an array" });
      continue;
    }
    for (const [index, term] of terms.entries()) {
      if (typeof term !== "string") {
        issues.push({ path: `${classPath}.terms[${String(index)}]`, message: "must be a string" });
      } else if (normalizeLexicalText(term) === "") {
        issues.push({
          path: `${classPath}.terms[${String(index)}]`,
          message: "must contain a word after normalization",
        });
      }
    }
  }
  if (issues.length > 0) throw new LexicalValidationError(issues);
}

export interface LexicalGlossaryInput {
  readonly glossary?: readonly string[];
  readonly lexicon?: Readonly<Record<string, LexicalClassRule>>;
  readonly players?: readonly {
    readonly display_name: string;
    readonly id?: string;
    readonly characters?: readonly {
      readonly name: string;
      readonly aliases?: readonly string[];
    }[];
  }[];
  readonly speakerPlayerId?: string;
  readonly speakerDisplayName?: string;
  readonly characters?: readonly string[];
  readonly npcs?: readonly (
    string | { readonly name: string; readonly aliases?: readonly string[] }
  )[];
}

export interface LexicalMarker {
  readonly className: string;
  readonly polarity: LexicalPolarity;
  readonly term: string;
  readonly weight: number;
  readonly startToken: number;
  readonly endToken: number;
}

export interface QuoteSpan {
  readonly startWord: number;
  readonly endWord: number;
  readonly start_s: number;
  readonly end_s: number;
  readonly text: string;
}

export interface RollTotalEvidence {
  readonly matched: boolean;
  readonly total: number | null;
  readonly rollId: string | null;
  readonly reason: "matched_roll_total" | "not_numeric_only" | "no_aligned_roll" | "ambiguous_roll";
}

export interface LexicalResult {
  readonly normalizedText: string;
  readonly lex_ooc: number;
  readonly lex_ic: number;
  readonly oocDensity: number;
  readonly icDensity: number;
  readonly markers: readonly LexicalMarker[];
  readonly quoteSpans: readonly QuoteSpan[];
  readonly rollTotal: RollTotalEvidence;
}

const DEFAULT_RULES: Readonly<Record<string, LexicalClassRule>> = {
  dice_mechanics: {
    polarity: "ooc",
    weight: 1,
    terms: [
      "d20",
      "d 20",
      "natural twenty",
      "advantage",
      "disadvantage",
      "initiative",
      "ac",
      "armor class",
      "hit points",
      "saving throw",
      "crit",
      "critical hit",
      "modifier",
    ],
  },
  table_procedure: {
    polarity: "ooc",
    weight: 0.9,
    terms: [
      "my turn",
      "whose turn",
      "can i",
      "does that hit",
      "roll for",
      "i will go",
      "end my turn",
    ],
  },
  meta_reference: {
    polarity: "ooc",
    weight: 0.8,
    terms: ["the dm", "the module", "last session", "rules as written"],
  },
  room: {
    polarity: "ooc",
    weight: 0.75,
    terms: ["pizza", "back in a sec", "sorry mic", "sorry microphone"],
  },
  glossary: { polarity: "ic", weight: 0.45, terms: [] },
  proper_noun: { polarity: "ic", weight: 0.35, terms: [] },
  vocative: { polarity: "ic", weight: 0.3, terms: [] },
  second_person: { polarity: "ic", weight: 0.15, terms: ["you", "your", "yourself"] },
  register: { polarity: "ic", weight: 0.2, terms: ["aye", "thee", "thou", "milord", "milady"] },
};

const CONTRACTIONS: Readonly<Record<string, string>> = {
  "can't": "cannot",
  cannot: "cannot",
  "couldn't": "could not",
  "didn't": "did not",
  "doesn't": "does not",
  "don't": "do not",
  "i'd": "i would",
  "i'll": "i will",
  "i'm": "i am",
  "i've": "i have",
  "isn't": "is not",
  "it'll": "it will",
  "let's": "let us",
  "shouldn't": "should not",
  "that's": "that is",
  "they're": "they are",
  "wasn't": "was not",
  "we'll": "we will",
  "we're": "we are",
  "weren't": "were not",
  "won't": "will not",
  "wouldn't": "would not",
  "you're": "you are",
};

const SMALL_NUMBERS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function rawTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
}

function numberWords(tokens: readonly string[]): number | null {
  if (tokens.length === 1 && /^\d+$/u.test(tokens[0] ?? "")) return Number(tokens[0]);
  let current = 0;
  let saw = false;
  for (const token of tokens) {
    if (token === "and") continue;
    if (SMALL_NUMBERS[token] !== undefined) {
      current += SMALL_NUMBERS[token] ?? 0;
      saw = true;
    } else if (TENS[token] !== undefined) {
      current += TENS[token] ?? 0;
      saw = true;
    } else if (token === "hundred" && current > 0) {
      current *= 100;
      saw = true;
    } else return null;
  }
  return saw ? current : null;
}

/** Lowercase, expand common contractions, remove punctuation and normalize spoken numbers. */
export function normalizeLexicalText(text: string): string {
  const expanded = text
    .toLowerCase()
    .replace(/[\u2019']/gu, "'")
    .replace(/\b[\p{L}]+(?:'[\p{L}]+)\b/gu, (token) => CONTRACTIONS[token] ?? token);
  const tokens = rawTokens(expanded);
  const output: string[] = [];
  for (let index = 0; index < tokens.length;) {
    let matched: number | null = null;
    let width = 0;
    for (let end = Math.min(tokens.length, index + 3); end > index; end -= 1) {
      const candidate = numberWords(tokens.slice(index, end));
      if (candidate !== null) {
        matched = candidate;
        width = end - index;
        break;
      }
    }
    if (matched !== null) {
      output.push(String(matched));
      index += width;
    } else {
      output.push(tokens[index] ?? "");
      index += 1;
    }
  }
  return output.filter((token) => token !== "").join(" ");
}

/** British-spelling alias matching the campaign package's existing vocabulary. */
export const normaliseLexicalText = normalizeLexicalText;

function firstNames(input: LexicalGlossaryInput): string[] {
  const speakerName =
    input.speakerDisplayName === undefined
      ? undefined
      : normalizeLexicalText(input.speakerDisplayName).split(" ")[0];
  return (input.players ?? [])
    .filter((player) =>
      input.speakerPlayerId !== undefined
        ? player.id !== input.speakerPlayerId
        : speakerName === undefined ||
          normalizeLexicalText(player.display_name).split(" ")[0] !== speakerName,
    )
    .map((player) => normalizeLexicalText(player.display_name).split(" ")[0] ?? "")
    .filter((name) => name !== "");
}

function tokenTerms(term: string): string[] {
  return normalizeLexicalText(term).split(" ").filter(Boolean);
}

function classPolarity(name: string, rule: LexicalClassRule): LexicalPolarity {
  if (rule.polarity !== undefined) return rule.polarity;
  return /(?:^|[_-])ic(?:$|[_-])/iu.test(name) ? "ic" : "ooc";
}

function mergeRules(input: LexicalGlossaryInput): Record<string, LexicalClassRule> {
  const rules: Record<string, LexicalClassRule> = Object.fromEntries(
    Object.entries(DEFAULT_RULES).map(([name, rule]) => [
      name,
      { ...rule, terms: [...rule.terms] },
    ]),
  );
  const customLexicon = input.lexicon;
  if (customLexicon !== undefined) validateLexicon(customLexicon);
  for (const [name, rule] of Object.entries(customLexicon ?? {})) {
    const previous = rules[name];
    rules[name] = {
      weight: rule.weight,
      ...(rule.polarity === undefined ? {} : { polarity: rule.polarity }),
      terms: [...new Set([...(previous?.terms ?? []), ...rule.terms])],
    };
  }
  rules["glossary"] = {
    weight: rules["glossary"]?.weight ?? 0.45,
    polarity: "ic",
    terms: input.glossary ?? [],
  };
  const characterNames = [
    ...(input.characters ?? []),
    ...(input.players ?? []).flatMap((player) =>
      (player.characters ?? []).flatMap((character) => [
        character.name,
        ...(character.aliases ?? []),
      ]),
    ),
  ];
  const npcNames = (input.npcs ?? []).flatMap((npc) =>
    typeof npc === "string" ? [npc] : [npc.name, ...(npc.aliases ?? [])],
  );
  rules["proper_noun"] = {
    weight: rules["proper_noun"]?.weight ?? 0.35,
    polarity: "ic",
    terms: npcNames,
  };
  rules["vocative"] = {
    weight: rules["vocative"]?.weight ?? 0.3,
    polarity: "ic",
    terms: characterNames,
  };
  return rules;
}

function markerMatches(tokens: readonly string[], termTokens: readonly string[]): number[] {
  if (termTokens.length === 0) return [];
  const matches: number[] = [];
  for (let start = 0; start <= tokens.length - termTokens.length; start += 1) {
    if (termTokens.every((token, offset) => tokens[start + offset] === token)) matches.push(start);
  }
  return matches;
}

function appearsAsVocative(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[,!?;])\\s*${escaped}\\s*[,!?:]`, "iu").test(text);
}

/** Locate quote spans against the original ASR word indexes and timestamps. */
export function findQuoteSpans(words: readonly Word[]): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  let start: number | null = null;
  const addSpan = (firstIndex: number, lastIndex: number): void => {
    const first = words[firstIndex];
    const last = words[lastIndex];
    if (first === undefined || last === undefined) return;
    spans.push({
      startWord: firstIndex,
      endWord: lastIndex,
      start_s: first.s,
      end_s: last.e,
      text: words
        .slice(firstIndex, lastIndex + 1)
        .map((word) => word.t)
        .join(" ")
        .replace(/["\u201c\u201d]/gu, "")
        .trim(),
    });
  };
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index]?.t ?? "";
    const asciiQuotes = [...token.matchAll(/"/gu)].map((match) => match.index ?? -1);
    const asciiOpens = asciiQuotes.length > 1 || (asciiQuotes.length === 1 && asciiQuotes[0] === 0);
    const asciiCloses =
      asciiQuotes.length > 1 || (asciiQuotes.length === 1 && asciiQuotes[0] === token.length - 1);
    const opens = /\u201c/u.test(token) || asciiOpens;
    const closes = /\u201d/u.test(token) || asciiCloses;
    if (start === null && opens && closes) addSpan(index, index);
    else if (start === null && opens) start = index;
    else if (start !== null && closes) {
      addSpan(start, index);
      start = null;
    }
  }
  return spans;
}

export interface RollTotalInput {
  readonly id?: string;
  readonly total: number;
  readonly t_audio_s: number;
  readonly t_uncertainty_s?: number;
}

/** Match only an utterance containing one numeric value and exactly one aligned roll. */
export function matchRollTotalEvidence(
  text: string,
  utteranceStartS: number,
  utteranceEndS: number,
  rolls: readonly RollTotalInput[],
): RollTotalEvidence {
  const tokens = normalizeLexicalText(text).split(" ").filter(Boolean);
  const value = numberWords(tokens);
  if (value === null)
    return { matched: false, total: null, rollId: null, reason: "not_numeric_only" };
  const midpoint = (utteranceStartS + utteranceEndS) / 2;
  const matches = rolls.filter(
    (roll) =>
      roll.total === value && Math.abs(roll.t_audio_s - midpoint) <= (roll.t_uncertainty_s ?? 1.5),
  );
  if (matches.length === 1)
    return {
      matched: true,
      total: value,
      rollId: matches[0]?.id ?? null,
      reason: "matched_roll_total",
    };
  return {
    matched: false,
    total: value,
    rollId: null,
    reason: matches.length > 1 ? "ambiguous_roll" : "no_aligned_roll",
  };
}

export function classifyLexical(
  text: string,
  input: LexicalGlossaryInput = {},
  words: readonly Word[] = [],
  rollEvidence: RollTotalEvidence = {
    matched: false,
    total: null,
    rollId: null,
    reason: "not_numeric_only",
  },
): LexicalResult {
  const normalizedText = normalizeLexicalText(text);
  const tokens = normalizedText.split(" ").filter(Boolean);
  const rules = mergeRules(input);
  const markers: LexicalMarker[] = [];
  const seenMarkers = new Set<string>();
  for (const [className, rule] of Object.entries(rules)) {
    const polarity = classPolarity(className, rule);
    for (const term of rule.terms) {
      for (const startToken of markerMatches(tokens, tokenTerms(term))) {
        const normalizedTerm = normalizeLexicalText(term);
        if (className === "vocative" && !appearsAsVocative(text, normalizedTerm)) continue;
        const markerKey = `${className}\u0000${normalizedTerm}\u0000${String(startToken)}`;
        if (seenMarkers.has(markerKey)) continue;
        seenMarkers.add(markerKey);
        markers.push({
          className,
          polarity,
          term: normalizedTerm,
          weight: rule.weight,
          startToken,
          endToken: startToken + tokenTerms(term).length - 1,
        });
      }
    }
  }
  const names = firstNames(input);
  const characterTokens = new Set(
    rules["vocative"]?.terms.flatMap((term) => tokenTerms(term)) ?? [],
  );
  for (const name of names) {
    const nameTokensValue = tokenTerms(name);
    if (
      nameTokensValue.length === 0 ||
      nameTokensValue.every((token) => characterTokens.has(token))
    )
      continue;
    for (const startToken of markerMatches(tokens, nameTokensValue)) {
      const markerKey = `real_player_name\u0000${name}\u0000${String(startToken)}`;
      if (seenMarkers.has(markerKey)) continue;
      seenMarkers.add(markerKey);
      markers.push({
        className: "real_player_name",
        polarity: "ooc",
        term: name,
        weight: 1,
        startToken,
        endToken: startToken + nameTokensValue.length - 1,
      });
    }
  }
  if (rollEvidence.matched && rollEvidence.total !== null) {
    markers.push({
      className: "roll_total",
      polarity: "ooc",
      term: String(rollEvidence.total),
      weight: 1.25,
      startToken: 0,
      endToken: Math.max(0, tokens.length - 1),
    });
  }
  markers.sort(
    (left, right) =>
      left.startToken - right.startToken ||
      left.className.localeCompare(right.className) ||
      left.term.localeCompare(right.term),
  );
  const oocWeight = Math.max(
    0,
    markers
      .filter((marker) => marker.polarity === "ooc")
      .reduce((sum, marker) => sum + marker.weight, 0),
  );
  const icWeight = Math.max(
    0,
    markers
      .filter((marker) => marker.polarity === "ic")
      .reduce((sum, marker) => sum + marker.weight, 0),
  );
  const denominator = Math.max(1, oocWeight + icWeight);
  return {
    normalizedText,
    lex_ooc: oocWeight / denominator,
    lex_ic: icWeight / denominator,
    oocDensity: oocWeight / Math.max(1, tokens.length),
    icDensity: icWeight / Math.max(1, tokens.length),
    markers,
    quoteSpans: findQuoteSpans(words),
    rollTotal: rollEvidence,
  };
}

export const DEFAULT_LEXICON: Lexicon = {
  version: 1,
  classes: Object.fromEntries(
    Object.entries(DEFAULT_RULES).map(([name, rule]) => [
      name,
      { weight: rule.weight, terms: [...rule.terms] },
    ]),
  ),
};
