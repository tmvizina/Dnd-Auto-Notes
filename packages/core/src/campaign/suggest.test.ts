import { describe, expect, it } from "vitest";
import type { Player } from "../contracts/campaign.js";
import { editDistance, normaliseName, similarity } from "./normalise.js";
import type { Registry } from "./registry.js";
import { SUGGEST_MIN_SCORE, buildRegistryStub, suggestFor, suggestMappings } from "./suggest.js";

function player(id: string, display: string, discord?: string, roll20?: string): Player {
  return {
    id,
    display_name: display,
    is_dm: false,
    discord:
      discord === undefined
        ? { craig_track_hints: [] }
        : { username: discord, craig_track_hints: [] },
    roll20: roll20 === undefined ? { player_ids: [] } : { account_name: roll20, player_ids: [] },
    characters: [],
  } as Player;
}

const registry: Registry = {
  root: "/campaign",
  campaign: { name: "C", system: "D&D 5e", timezone: "UTC", session_prefix: "s" },
  players: [
    player("pl_ash", "Ash", "ashcodes", "Ash B."),
    player("pl_bly", "Bly", "blybird", "Bly"),
    player("pl_cyd", "Cyd", "cyd_h", "Cyd H."),
    player("pl_dm", "Wren", "wren_dm", "Wren"),
  ],
  npcs: [],
  glossary: [],
  lexicon: null,
};

describe("normalisation", () => {
  it("folds case, accents, punctuation and discriminators", () => {
    expect(normaliseName("Ash B.")).toBe("ash b");
    expect(normaliseName("Séren#1234")).toBe("seren");
    expect(normaliseName("  cyd_h  ")).toBe("cyd h");
  });

  it("measures edit distance", () => {
    expect(editDistance("ash", "ash")).toBe(0);
    expect(editDistance("ash", "ashe")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
  });

  it("scores an exact normalised match as 1", () => {
    expect(similarity("Ash B.", "ash b")).toBe(1);
  });
});

describe("suggestFor", () => {
  it("ranks the right player first for a near-miss Roll20 account", () => {
    // A typo, not just different punctuation — "Ash B" normalises to exactly
    // "Ash B." and would match outright.
    const suggestion = suggestFor(registry, "Ashh B.", "roll20");
    expect(suggestion.candidates[0]?.player_id).toBe("pl_ash");
  });

  it("treats punctuation-only differences as an exact match, not a guess", () => {
    expect(suggestFor(registry, "Ash B", "roll20").exact).toBe("pl_ash");
  });

  it("ranks the right player first for a derived Discord username", () => {
    expect(suggestFor(registry, "ashcodes_", "discord").candidates[0]?.player_id).toBe("pl_ash");
    expect(suggestFor(registry, "blybird", "discord").candidates[0]?.player_id).toBe("pl_bly");
  });

  it("reports an exact match separately from scored candidates", () => {
    const suggestion = suggestFor(registry, "ashcodes", "discord");
    expect(suggestion.exact).toBe("pl_ash");
  });

  it("leaves `exact` null when nothing matches outright", () => {
    expect(suggestFor(registry, "Ashh B.", "roll20").exact).toBeNull();
  });

  it("offers nothing for a name unlike anyone, rather than a bad guess", () => {
    const suggestion = suggestFor(registry, "zzzqqq", "discord");
    expect(suggestion.exact).toBeNull();
    expect(suggestion.candidates).toEqual([]);
  });

  it("keeps every candidate above the noise floor and sorts by score", () => {
    const suggestion = suggestFor(registry, "Cyd H", "roll20");
    expect(suggestion.candidates.every((c) => c.score >= SUGGEST_MIN_SCORE)).toBe(true);
    const scores = suggestion.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("says which stored value produced the score", () => {
    const suggestion = suggestFor(registry, "Ashh B.", "roll20");
    expect(suggestion.candidates[0]?.matched_on).toBe("Ash B.");
  });

  it("suggests for a batch without applying anything", () => {
    const suggestions = suggestMappings(registry, [
      { observed: "Ashh B.", kind: "roll20" },
      { observed: "cyd_h", kind: "discord" },
    ]);
    expect(suggestions).toHaveLength(2);
    // The registry is untouched — suggestion never mutates.
    expect(registry.players[0]?.roll20.account_name).toBe("Ash B.");
  });
});

describe("buildRegistryStub", () => {
  it("emits a row for every observed Discord user", () => {
    const stub = buildRegistryStub({
      discordUsers: ["ashcodes", "blybird", "wren_dm"],
      roll20Accounts: [],
    });
    expect(stub.players.map((p) => p.discord.username)).toEqual(["ashcodes", "blybird", "wren_dm"]);
    expect(stub.players.every((p) => p.characters.length === 0)).toBe(true);
  });

  it("attaches a Roll20 account only on an exact normalised match", () => {
    const stub = buildRegistryStub({
      discordUsers: ["cyd_h"],
      roll20Accounts: ["Cyd H."],
    });
    expect(stub.players).toHaveLength(1);
    expect(stub.players[0]?.roll20.account_name).toBe("Cyd H.");
  });

  it("never binds a merely similar Roll20 account — it gets its own row", () => {
    const stub = buildRegistryStub({
      discordUsers: ["ashcodes"],
      roll20Accounts: ["Ash B."],
    });
    expect(stub.players).toHaveLength(2);
    expect(stub.players[0]?.roll20.account_name).toBeUndefined();
    expect(stub.players[1]?.roll20.account_name).toBe("Ash B.");
  });

  it("gives an unrecognisable Roll20 account its own row to be reconciled", () => {
    const stub = buildRegistryStub({
      discordUsers: ["ashcodes"],
      roll20Accounts: ["Quentin the Third"],
    });
    expect(stub.players).toHaveLength(2);
    expect(stub.players[1]?.roll20.account_name).toBe("Quentin the Third");
    expect(stub.players[1]?.discord.username).toBeUndefined();
  });

  it("produces ids that are stable and slug-safe", () => {
    const stub = buildRegistryStub({ discordUsers: ["Ash B."], roll20Accounts: [] });
    expect(stub.players[0]?.id).toBe("pl_ash_b");
  });
});

describe("similarity is safe to use as an exactness test", () => {
  it("scores 1 only when the names normalise to the same string", () => {
    expect(similarity("Cyd H.", "cyd_h")).toBe(1);
    // A shared token is evidence, not identity — this must stay below 1 or
    // callers using `=== 1` would bind two different people together.
    expect(similarity("Wren", "wren_dm")).toBeLessThan(1);
    expect(similarity("Ash", "ashcodes")).toBeLessThan(1);
  });
});
