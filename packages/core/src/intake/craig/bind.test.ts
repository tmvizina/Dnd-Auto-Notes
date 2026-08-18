import { describe, expect, it } from "vitest";
import type { Registry } from "../../campaign/registry.js";
import type { Player } from "../../contracts/campaign.js";
import { bindTracks, candidatesFor, FUZZY_MIN_SCORE } from "./bind.js";
import type { BindingInput } from "./bind.js";
import { parseCraigName } from "./names.js";

function player(overrides: Partial<Player> & { id: string; display_name: string }): Player {
  return {
    is_dm: false,
    discord: { craig_track_hints: [] },
    roll20: { player_ids: [] },
    characters: [],
    ...overrides,
  };
}

function registryOf(players: Player[]): Registry {
  return {
    root: "/campaign",
    campaign: { name: "Thornwatch", system: "D&D 5e", timezone: "UTC", session_prefix: "s" },
    players,
    npcs: [],
    glossary: [],
    lexicon: null,
  };
}

function input(trackId: string, filename: string, participant?: BindingInput["participant"]) {
  return { trackId, name: parseCraigName(filename), participant: participant ?? null };
}

const ASH = player({
  id: "pl_ash",
  display_name: "Ash",
  discord: { user_id: "111111111111111111", username: "ashcodes", craig_track_hints: [] },
});
const BLY = player({
  id: "pl_bly",
  display_name: "Bly",
  discord: { username: "blybird", craig_track_hints: [] },
});
const CYD = player({
  id: "pl_cyd",
  display_name: "Cyd",
  discord: { username: "cyd_h", craig_track_hints: [] },
});

describe("bindTracks", () => {
  it("prefers the Discord user id over every name", () => {
    // The filename says blybird; the id says Ash. Ids do not change, so the id
    // wins — this is the case where a player renamed themselves mid-campaign.
    const registry = registryOf([ASH, BLY]);
    const [binding] = bindTracks(registry, [
      input("t1", "1-blybird.flac", {
        index: 1,
        username: "blybird",
        discriminator: null,
        userId: "111111111111111111",
      }),
    ]);

    expect(binding?.playerId).toBe("pl_ash");
    expect(binding?.match).toBe("discord_id");
  });

  it("matches an exact username", () => {
    const [binding] = bindTracks(registryOf([ASH, BLY]), [input("t2", "2-blybird.flac")]);
    expect(binding?.playerId).toBe("pl_bly");
    expect(binding?.match).toBe("username");
    expect(binding?.match).not.toBe("fuzzy");
  });

  it("does not split a username on an underscore", () => {
    const [binding] = bindTracks(registryOf([ASH, CYD]), [input("t3", "3-cyd_h.wav")]);
    expect(binding?.playerId).toBe("pl_cyd");
  });

  it("matches a craig_track_hint", () => {
    const registry = registryOf([
      player({
        id: "pl_dm",
        display_name: "Wren",
        discord: { craig_track_hints: ["wren_dm"] },
      }),
    ]);
    const [binding] = bindTracks(registry, [input("t4", "4-wren_dm.flac")]);
    expect(binding?.playerId).toBe("pl_dm");
    expect(binding?.match).toBe("username");
  });

  it("binds fuzzily only above the threshold, recording the score", () => {
    const registry = registryOf([
      player({
        id: "pl_ash",
        display_name: "Ash",
        discord: { username: "ashcodes", craig_track_hints: [] },
      }),
    ]);
    const [binding] = bindTracks(registry, [input("t1", "1-ashcode.flac")]);

    expect(binding?.playerId).toBe("pl_ash");
    expect(binding?.match).toBe("fuzzy");
    expect(binding?.score).toBeGreaterThanOrEqual(FUZZY_MIN_SCORE);
  });

  it("refuses to guess below the threshold and lists candidates", () => {
    const registry = registryOf([ASH, BLY, CYD]);
    const [binding] = bindTracks(registry, [input("t9", "9-someone_else.flac")]);

    expect(binding?.playerId).toBeNull();
    expect(binding?.match).toBe("unmatched");
    expect(binding?.reason).toMatch(/below|no registry player/);
  });

  it("refuses when two players answer to the same exact name", () => {
    // Identical evidence for two people is not a 51/49 decision; it is no
    // decision, and taking whichever one the array happened to hold first
    // would be invisible in the output.
    const registry = registryOf([
      player({ id: "pl_one", display_name: "Robin", discord: { craig_track_hints: [] } }),
      player({ id: "pl_two", display_name: "Robin", discord: { craig_track_hints: [] } }),
    ]);
    const [binding] = bindTracks(registry, [input("t1", "1-robín.flac")]);

    expect(binding?.playerId).toBeNull();
    expect(binding?.reason).toMatch(/2 players answer to "robín"/);
  });

  it("refuses when two fuzzy candidates are too close to separate", () => {
    const registry = registryOf([
      player({ id: "pl_one", display_name: "Robin A", discord: { craig_track_hints: [] } }),
      player({ id: "pl_two", display_name: "Robin B", discord: { craig_track_hints: [] } }),
    ]);
    const [binding] = bindTracks(registry, [input("t1", "1-robin.flac")]);

    expect(binding?.playerId).toBeNull();
    expect(binding?.reason).toMatch(/too close to separate/);
  });

  it("never binds one player to two tracks", () => {
    const registry = registryOf([ASH]);
    const bindings = bindTracks(registry, [
      input("t1", "1-ashcodes.flac"),
      input("t2", "2-ashcodes.flac"),
    ]);

    expect(bindings[0]?.playerId).toBe("pl_ash");
    expect(bindings[1]?.playerId).toBeNull();
    expect(bindings[1]?.reason).toMatch(/already bound to track t1/);
  });

  it("lets a strong match win a player a weaker one would have taken", () => {
    // t2's exact username must not lose the player to t1's fuzzy resemblance.
    const registry = registryOf([BLY]);
    const bindings = bindTracks(registry, [
      input("t1", "1-blybir.flac"),
      input("t2", "2-blybird.flac"),
    ]);

    expect(bindings[1]?.playerId).toBe("pl_bly");
    expect(bindings[1]?.match).toBe("username");
    expect(bindings[0]?.playerId).toBeNull();
  });

  it("returns bindings in the order it was given", () => {
    const bindings = bindTracks(registryOf([ASH, BLY, CYD]), [
      input("t3", "3-cyd_h.wav"),
      input("t1", "1-ashcodes.flac"),
      input("t2", "2-blybird.flac"),
    ]);
    expect(bindings.map((binding) => binding.trackId)).toEqual(["t3", "t1", "t2"]);
  });

  it("reports an empty registry without throwing", () => {
    const [binding] = bindTracks(registryOf([]), [input("t1", "1-ashcodes.flac")]);
    expect(binding?.playerId).toBeNull();
    expect(binding?.candidates).toEqual([]);
  });
});

describe("candidatesFor", () => {
  it("ranks the plausible players best first", () => {
    const candidates = candidatesFor(registryOf([ASH, BLY, CYD]), input("t1", "1-ash.flac"));
    expect(candidates[0]?.player_id).toBe("pl_ash");
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it("scores against the info.txt name as well as the filename", () => {
    const candidates = candidatesFor(
      registryOf([BLY]),
      input("t1", "1-track.flac", {
        index: 1,
        username: "blybird",
        discriminator: null,
        userId: null,
      }),
    );
    expect(candidates[0]?.player_id).toBe("pl_bly");
    expect(candidates[0]?.score).toBe(1);
  });
});
