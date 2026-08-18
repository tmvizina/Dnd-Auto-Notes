import { describe, expect, it } from "vitest";
import {
  classifyLexical,
  findQuoteSpans,
  LexicalValidationError,
  matchRollTotalEvidence,
  normalizeLexicalText,
  validateLexicon,
} from "./lexical.js";

describe("lexical normalization", () => {
  it("expands contractions, removes punctuation and maps spoken numbers", () => {
    expect(normalizeLexicalText("I'll roll nineteen — doesn't that hit?")).toBe(
      "i will roll 19 does not that hit",
    );
    expect(normalizeLexicalText("twenty one")).toBe("21");
  });
});

describe("weighted lexical markers", () => {
  it.each([
    ["dice and mechanics", "I have advantage and my AC is seventeen", "dice_mechanics"],
    ["table procedure", "whose turn is it? does that hit?", "table_procedure"],
    ["meta reference", "the DM said that last session", "meta_reference"],
    ["room", "I need pizza, back in a sec", "room"],
  ])("fires the %s class with explainable markers", (_label, text, className) => {
    const result = classifyLexical(text);
    expect(result.markers.some((marker) => marker.className === className)).toBe(true);
    expect(result.lex_ooc).toBeGreaterThan(0);
    expect(result.markers.every((marker) => marker.term.length > 0 && marker.weight > 0)).toBe(
      true,
    );
  });

  it.each([
    "The dragon watches from the tower.",
    "The old road bends beneath the moon.",
    "She raises her shield and waits.",
  ])("does not fire OOC markers for an in-world counterexample: %s", (text) => {
    expect(classifyLexical(text).lex_ooc).toBe(0);
  });

  it("distinguishes a real player first name from a character name", () => {
    const input = {
      players: [{ display_name: "Alice Smith" }],
      characters: ["Aveline"],
    };
    expect(classifyLexical("Alice, can you hear me?", input).markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ className: "real_player_name", polarity: "ooc" }),
      ]),
    );
    const character = classifyLexical("Aveline, take the bridge.", input);
    expect(character.markers).toEqual(
      expect.arrayContaining([expect.objectContaining({ className: "vocative", polarity: "ic" })]),
    );
    expect(character.markers.some((marker) => marker.className === "real_player_name")).toBe(false);
    expect(classifyLexical("Aveline is a brave ranger.", input).markers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ className: "vocative" })]),
    );
  });

  it("uses an explicit speaker id before the conservative display-name fallback", () => {
    const input = {
      players: [
        { id: "p1", display_name: "Alex One" },
        { id: "p2", display_name: "Alex Two" },
      ],
      speakerPlayerId: "p2",
      speakerDisplayName: "Alex Two",
    };
    expect(classifyLexical("Alex, your turn.", input).markers).toEqual(
      expect.arrayContaining([expect.objectContaining({ className: "real_player_name" })]),
    );
    expect(
      classifyLexical("Alex, your turn.", {
        players: input.players,
        speakerDisplayName: "Alex",
      }).markers.some((marker) => marker.className === "real_player_name"),
    ).toBe(false);
  });

  it("uses glossary and campaign lexicon terms without code changes", () => {
    const result = classifyLexical("The moonwell opens before us, aye.", {
      glossary: ["moonwell"],
      lexicon: {
        custom_ic: { polarity: "ic", weight: 0.8, terms: ["before us"] },
      },
    });
    expect(result.markers.map((marker) => marker.className)).toEqual(
      expect.arrayContaining(["glossary", "custom_ic", "register"]),
    );
    expect(result.lex_ic).toBeGreaterThan(0);
    expect(result.lex_ooc).toBe(0);
  });
});

describe("quoted narration and numeric roll evidence", () => {
  it("maps quoted speech to exact ASR word indexes and timestamps", () => {
    const words = [
      { t: "The", s: 1, e: 1.2 },
      { t: "guard", s: 1.2, e: 1.5 },
      { t: "says", s: 1.5, e: 1.7 },
      { t: '"Halt', s: 1.7, e: 1.9 },
      { t: 'now."', s: 1.9, e: 2.2 },
    ];
    expect(findQuoteSpans(words)).toEqual([
      { startWord: 3, endWord: 4, start_s: 1.7, end_s: 2.2, text: "Halt now." },
    ]);
    expect(classifyLexical("The guard says halt now", {}, words).quoteSpans[0]?.start_s).toBe(1.7);
    expect(findQuoteSpans([{ t: "\u201cHalt\u201d", s: 3, e: 3.4 }])).toEqual([
      { startWord: 0, endWord: 0, start_s: 3, end_s: 3.4, text: "Halt" },
    ]);
  });

  it("matches spoken roll totals only when exactly one roll is aligned", () => {
    const roll = [{ id: "r1", total: 19, t_audio_s: 4.2, t_uncertainty_s: 0.5 }];
    expect(matchRollTotalEvidence("nineteen", 4, 4.4, roll)).toEqual({
      matched: true,
      total: 19,
      rollId: "r1",
      reason: "matched_roll_total",
    });
    expect(matchRollTotalEvidence("nineteen", 8, 8.4, roll).reason).toBe("no_aligned_roll");
    expect(matchRollTotalEvidence("nineteen please", 4, 4.4, roll).reason).toBe("not_numeric_only");
    const result = classifyLexical(
      "nineteen",
      {},
      [],
      matchRollTotalEvidence("nineteen", 4, 4.4, roll),
    );
    expect(result.markers).toEqual(
      expect.arrayContaining([expect.objectContaining({ className: "roll_total" })]),
    );
  });
});

describe("custom lexicon validation", () => {
  it.each([
    null,
    [],
    { "": { weight: 1, terms: ["x"] } },
    { ooc_custom: [] },
    { ooc_custom: { weight: -1, terms: ["x"] } },
    { ooc_custom: { weight: Number.NaN, terms: ["x"] } },
    { ooc_custom: { weight: 1, terms: "x" } },
    { ooc_custom: { weight: 1, polarity: "maybe", terms: ["x"] } },
    { ooc_custom: { weight: 1, terms: ["   "] } },
  ])("rejects malformed lexicon %j with structured issues", (lexicon) => {
    expect(() => validateLexicon(lexicon)).toThrow(LexicalValidationError);
    expect(() => classifyLexical("x", { lexicon: lexicon as never })).toThrow(
      LexicalValidationError,
    );
  });
});
