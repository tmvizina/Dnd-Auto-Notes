import { describe, expect, it } from "vitest";
import { assignDmNpcs, classifyDmMode, proposeNewNpcs } from "./dmNpc.js";
const u = (id: string, t: number, text: string, extra = {}) => ({
  id,
  player_id: null,
  start_s: t,
  end_s: t + 1,
  text,
  ...extra,
});
describe("DM NPC attribution", () => {
  it("separates narration and NPC speech", () => {
    expect(classifyDmMode("The guard walks to the gate.")).toBe("narration");
    expect(classifyDmMode("I will open the gate.")).toBe("npc");
  });
  it("handles ASCII and curly quoted speech without treating descriptive text as speech", () => {
    expect(classifyDmMode('He says, "Stay back."')).toBe("npc");
    expect(classifyDmMode("He says, “Stay back.”")).toBe("npc");
    expect(classifyDmMode("The guard walks toward the gate.")).toBe("narration");
  });
  it("uses names in a decaying window and voice bank outside it", () => {
    const results = assignDmNpcs({
      utterances: [
        u("a", 0, "The guard, Brann, arrives."),
        u("b", 10, "I demand entry.", { mode: "in_character", voice_cluster: "v1" }),
        u("c", 100, "I demand entry.", { mode: "in_character", voice_cluster: "v1" }),
      ],
      profiles: [{ character_id: "Brann", voice_cluster: "v1", owner_type: "npc" }],
    });
    expect(results[1]?.character_id).toBe("Brann");
    expect(results[2]?.character_id).toBe("Brann");
  });
  it("uses adjacent name windows to disambiguate identical voice clusters", () => {
    const results = assignDmNpcs({
      utterances: [
        u("a", 0, "The guard Brann arrives."),
        u("b", 5, "I demand entry.", { mode: "in_character", voice_cluster: "same" }),
        u("c", 10, "The merchant Lysa arrives."),
        u("d", 15, "Pay me now.", { mode: "in_character", voice_cluster: "same" }),
      ],
      profiles: [
        { character_id: "Brann", voice_cluster: "same", owner_type: "npc" },
        { character_id: "Lysa", voice_cluster: "same", owner_type: "npc" },
      ],
    });
    expect(results[1]?.character_id).toBe("Brann");
    expect(results[3]?.character_id).toBe("Lysa");
  });
  it("never crosses DM/player ownership and flags unknown voices", () => {
    const results = assignDmNpcs({
      utterances: [
        u("p", 0, "I attack", { player_id: "player", mode: "in_character" }),
        u("d", 1, "I attack", { mode: "in_character" }),
      ],
    });
    expect(results[0]?.flags).toContain("not_dm");
    expect(results[1]?.flags).toContain("unknown_npc");
    expect(results[1]?.character_id).toBeNull();
  });
  it("requires explicit NPC ownership and truly adjacent direct address", () => {
    const results = assignDmNpcs({
      utterances: [
        u("p", 0, "Brann, look out!", { player_id: "player" }),
        u("d", 1, "I attack", { mode: "in_character", voice_cluster: "v" }),
        u("x", 2, "unrelated", { player_id: "player" }),
        u("e", 10, "I attack", { mode: "in_character", voice_cluster: "v" }),
      ],
      profiles: [{ character_id: "Brann", owner_type: "npc" }, { character_id: "PC" }],
    });
    expect(results[1]?.character_id).toBe("Brann");
    expect(results[1]?.candidates.some((candidate) => candidate.character_id === "PC")).toBe(false);
    expect(results[3]?.character_id).toBeNull();
  });
  it("returns recurring proposals without writing a registry", () => {
    const item = {
      utterance_id: "u",
      mode: "npc" as const,
      character_id: null,
      voice_cluster: "v1",
      candidates: [{ character_id: "Mysterious Voice", score: 1, reasons: ["name_window"] }],
      flags: ["unknown_npc"],
    };
    const proposals = proposeNewNpcs([item, { ...item, utterance_id: "v" }], []);
    expect(proposals[0]).toEqual(
      expect.objectContaining({
        character_id: "Mysterious Voice",
        voice_cluster: "v1",
        proposal: true,
      }),
    );
  });
  it("discovers a repeated unknown proper name with an empty registry", () => {
    const results = assignDmNpcs({
      utterances: [
        u("n", 0, "The wanderer Zorath enters."),
        u("a", 1, "I will help you.", { mode: "in_character", voice_cluster: "v" }),
        u("b", 2, "I will help again.", { mode: "in_character", voice_cluster: "v" }),
      ],
    });
    const proposals = proposeNewNpcs(results, []);
    expect(proposals[0]?.character_id).toBe("Zorath");
  });
});
