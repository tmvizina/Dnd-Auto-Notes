import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Player } from "../contracts/campaign.js";
import {
  CAMPAIGN_FILES,
  RegistryError,
  allCharacters,
  byCharacterId,
  byDiscordUser,
  byRoll20Account,
  charactersActiveAt,
  dungeonMaster,
  loadRegistry,
  parseGlossary,
  saveRegistry,
  validateRegistry,
  withNpc,
} from "./registry.js";
import type { Registry } from "./registry.js";

let root: string;

function player(overrides: Partial<Player> & { id: string }): Player {
  return {
    display_name: overrides.id,
    is_dm: false,
    discord: { username: overrides.id, craig_track_hints: [] },
    roll20: { player_ids: [] },
    characters: [],
    ...overrides,
  } as Player;
}

function registry(players: Player[], npcs: Registry["npcs"] = []): Registry {
  return {
    root,
    campaign: { name: "C", system: "D&D 5e", timezone: "UTC", session_prefix: "s" },
    players,
    npcs,
    glossary: [],
    lexicon: null,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dnd-campaign-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("registry round-trip", () => {
  it("saves and reloads without losing a field", async () => {
    const original = registry(
      [
        player({
          id: "pl_ash",
          display_name: "Ash",
          discord: { username: "ashcodes", user_id: "204", craig_track_hints: ["ash"] },
          roll20: { account_name: "Ash B.", player_ids: ["-N9x"] },
          characters: [
            { id: "ch_seren", name: "Seren Thaldane", aliases: ["Seren"], active_from: "s01" },
          ],
        }),
      ],
      [{ id: "npc_innkeep", name: "Halda", aliases: ["the innkeeper"], voiced_by: "pl_dm" }],
    );

    await saveRegistry(original);
    const reloaded = await loadRegistry(root);

    expect(reloaded.players).toEqual(original.players);
    expect(reloaded.npcs).toEqual(original.npcs);
    expect(reloaded.campaign).toEqual(original.campaign);
  });

  it("reads glossary terms from markdown list items only", () => {
    expect(parseGlossary("# Glossary\n\nSome prose.\n\n- Thornwatch\n* the Ford\n\n")).toEqual([
      "Thornwatch",
      "the Ford",
    ]);
  });
});

describe("validation", () => {
  it("rejects a duplicate character id", () => {
    const problems = validateRegistry(
      registry([
        player({ id: "pl_a", characters: [{ id: "ch_x", name: "X", aliases: [] }] }),
        player({ id: "pl_b", characters: [{ id: "ch_x", name: "X again", aliases: [] }] }),
      ]),
    );
    expect(problems).toContain("duplicate character id ch_x");
  });

  it("rejects a player with no identity to match on", () => {
    const orphan = {
      id: "pl_ghost",
      display_name: "Ghost",
      is_dm: false,
      discord: { craig_track_hints: [] },
      roll20: { player_ids: [] },
      characters: [],
    } as Player;
    expect(validateRegistry(registry([orphan]))).toContain(
      "player pl_ghost has no Discord or Roll20 identity to match on",
    );
  });

  it("rejects an id used as both a character and an NPC", () => {
    const problems = validateRegistry(
      registry(
        [player({ id: "pl_a", characters: [{ id: "ch_x", name: "X", aliases: [] }] })],
        [{ id: "ch_x", name: "X", aliases: [] }],
      ),
    );
    expect(problems.some((p) => p.includes("both a character and an NPC"))).toBe(true);
  });

  it("refuses to load a structurally broken registry", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, CAMPAIGN_FILES.players),
      JSON.stringify({
        players: [
          {
            id: "pl_a",
            display_name: "A",
            discord: { username: "a" },
            characters: [{ id: "ch_x", name: "X" }],
          },
          {
            id: "pl_b",
            display_name: "B",
            discord: { username: "b" },
            characters: [{ id: "ch_x", name: "X" }],
          },
        ],
      }),
    );
    await expect(loadRegistry(root)).rejects.toBeInstanceOf(RegistryError);
  });

  it("reports a malformed players.json rather than returning junk", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, CAMPAIGN_FILES.players), "{ nope");
    await expect(loadRegistry(root)).rejects.toThrow(/not valid JSON/);
  });
});

describe("lookups", () => {
  const people = () => [
    player({
      id: "pl_ash",
      display_name: "Ash",
      discord: { username: "ashcodes", user_id: "204", craig_track_hints: ["ash-b"] },
      roll20: { account_name: "Ash B.", player_ids: ["-N9x"] },
      characters: [{ id: "ch_seren", name: "Seren", aliases: [] }],
    }),
    player({ id: "pl_dm", display_name: "Wren", is_dm: true }),
  ];

  it("finds a player by discord id, username or track hint", () => {
    const r = registry(people());
    expect(byDiscordUser(r, "204")?.id).toBe("pl_ash");
    expect(byDiscordUser(r, "ashcodes")?.id).toBe("pl_ash");
    expect(byDiscordUser(r, "ASH-B")?.id).toBe("pl_ash");
    expect(byDiscordUser(r, "nobody")).toBeUndefined();
  });

  it("ignores a Discord discriminator when matching", () => {
    const r = registry(people());
    expect(byDiscordUser(r, "ashcodes#1234")?.id).toBe("pl_ash");
  });

  it("finds a player by roll20 account name or player id", () => {
    const r = registry(people());
    expect(byRoll20Account(r, "Ash B.")?.id).toBe("pl_ash");
    expect(byRoll20Account(r, "ash b")?.id).toBe("pl_ash");
    expect(byRoll20Account(r, "-N9x")?.id).toBe("pl_ash");
  });

  it("finds a character and its player, and the DM", () => {
    const r = registry(people());
    expect(byCharacterId(r, "ch_seren")?.player.id).toBe("pl_ash");
    expect(byCharacterId(r, "ch_nope")).toBeUndefined();
    expect(dungeonMaster(r)?.id).toBe("pl_dm");
    expect(allCharacters(r)).toHaveLength(1);
  });
});

describe("charactersActiveAt", () => {
  const r = () =>
    registry([
      player({
        id: "pl_a",
        characters: [
          { id: "ch_always", name: "Always", aliases: [] },
          { id: "ch_late", name: "Late", aliases: [], active_from: "s05" },
          { id: "ch_dead", name: "Dead", aliases: [], active_to: "s03" },
          { id: "ch_window", name: "Window", aliases: [], active_from: "s02", active_to: "s04" },
        ],
      }),
    ]);

  it("includes a character with no bounds at any session", () => {
    expect(charactersActiveAt(r(), 1).map((c) => c.id)).toContain("ch_always");
  });

  it("excludes a character retired before the session", () => {
    expect(charactersActiveAt(r(), 4).map((c) => c.id)).not.toContain("ch_dead");
    expect(charactersActiveAt(r(), 3).map((c) => c.id)).toContain("ch_dead");
  });

  it("excludes a character who has not joined yet", () => {
    expect(charactersActiveAt(r(), 4).map((c) => c.id)).not.toContain("ch_late");
    expect(charactersActiveAt(r(), 5).map((c) => c.id)).toContain("ch_late");
  });

  it("respects both bounds together", () => {
    expect(charactersActiveAt(r(), 1).map((c) => c.id)).not.toContain("ch_window");
    expect(charactersActiveAt(r(), 3).map((c) => c.id)).toContain("ch_window");
    expect(charactersActiveAt(r(), 5).map((c) => c.id)).not.toContain("ch_window");
  });
});

describe("withNpc", () => {
  it("appends a newly discovered NPC", () => {
    const next = withNpc(registry([]), { id: "npc_new", name: "New", aliases: [] });
    expect(next.npcs.map((n) => n.id)).toEqual(["npc_new"]);
  });

  it("never overwrites an existing NPC", () => {
    const base = registry([], [{ id: "npc_a", name: "Original", aliases: [] }]);
    const next = withNpc(base, { id: "npc_a", name: "Replacement", aliases: [] });
    expect(next.npcs[0]?.name).toBe("Original");
    expect(next).toBe(base);
  });
});
