import { describe, expect, it } from "vitest";
import type { Roll } from "../contracts/timeline.js";
import type { OutlineEvent } from "./events.js";
import { reconstructChecks } from "./checks.js";

function roll(id: string, total: number, raw = "skill=persuasion"): Roll {
  return {
    id,
    seq: Number(id.slice(1)),
    who: "Hero",
    player_id: "p1",
    formula: "1d20+3",
    dice: [{ sides: 20, value: 15, dropped: false }],
    modifiers: 3,
    total,
    kind: "check",
    advantage: "none",
    raw_ref: raw,
  };
}

function speech(
  id: string,
  time: number,
  text: string,
  character: string | null,
  isDm = false,
): OutlineEvent {
  return {
    id,
    kind: "speech",
    t_start_s: time,
    t_end_s: time + 1,
    source_refs: { utterances: [`u_${id}`], rolls: [] },
    confidence: 1,
    speaker_player_id: isDm ? null : "p1",
    speaker_character_id: character,
    speaker_display: character ?? "DM",
    is_dm: isDm,
    text,
    rolls: [],
  };
}

function checkEvent(id: string, time: number, total: number): OutlineEvent {
  return {
    id,
    kind: "roll",
    t_start_s: time,
    t_end_s: time + 0.1,
    source_refs: { utterances: [], rolls: [`r${id.slice(1)}`] },
    confidence: 1,
    speaker_player_id: "p1",
    speaker_character_id: "ch_hero",
    speaker_display: "Hero",
    is_dm: false,
    rolls: [roll(`r${id.slice(1)}`, total)],
  };
}

describe("social check reconstruction", () => {
  it("pairs intent and explicit adjudication without fabricating a DC", () => {
    const result = reconstructChecks([
      speech("intent", 1, "I try to persuade the guard to let us pass.", "ch_hero"),
      checkEvent("c1", 3, 18),
      speech("dm", 4, "You succeed; the guard steps aside.", null, true),
    ]);
    expect(result.checks[0]).toMatchObject({
      check: {
        actor: "ch_hero",
        skill: "persuasion",
        total: 18,
        stated_intent: "I try to persuade the guard to let us pass.",
        verdict: "success",
      },
      intent_source: "u_intent",
      adjudication_source: "u_dm",
    });
    expect(JSON.stringify(result)).not.toContain("dc");
  });

  it("leaves verdict unknown when no adjudication is spoken", () => {
    const result = reconstructChecks([
      speech("intent", 1, "I search for a hidden door.", "ch_hero"),
      checkEvent("c1", 3, 12),
    ]);
    expect(result.checks[0]?.check.verdict).toBe("unknown");
  });

  it("groups repeated attempts and extracts social structure and threads", () => {
    const result = reconstructChecks(
      [
        speech("one", 1, "We will return by the new moon and discuss the relic.", "ch_hero"),
        checkEvent("c1", 3, 9),
        speech("two", 20, "I try again to persuade the guard about the relic.", "ch_hero"),
        checkEvent("c2", 22, 14),
        speech("refusal", 23, "The guard refuses the deal.", "npc_guard", true),
      ],
      { glossary: ["relic"], npc_ids: ["npc_guard"] },
    );
    expect(result.checks.map((item) => item.group_id)).toEqual(["check-0001", "check-0001"]);
    expect(result.checks.map((item) => item.attempt_index)).toEqual([1, 2]);
    expect(result.participants).toEqual(["ch_hero"]);
    expect(result.npcs).toEqual(["npc_guard"]);
    expect(result.topic).toBe("relic");
    expect(result.outcome).toBe("refusal");
    expect(result.threads).toEqual([
      {
        kind: "promise",
        text: "We will return by the new moon and discuss the relic",
        source: "u_one",
      },
    ]);
  });

  it("recognizes DM prompts as intent and keeps unrelated checks separate", () => {
    const result = reconstructChecks([
      speech("prompt", 1, "Make an insight check about the merchant.", null, true),
      checkEvent("c1", 3, 16),
      checkEvent("c2", 200, 11),
    ]);
    expect(result.checks[0]?.check.stated_intent).toBe("Make an insight check about the merchant.");
    expect(result.checks[1]?.group_id).toBe("check-0002");
  });

  it("does not treat a silence gap as an explicit scene transition", () => {
    const gap: OutlineEvent = {
      id: "gap_1",
      kind: "gap",
      t_start_s: 20,
      t_end_s: 30,
      source_refs: { utterances: [], rolls: [] },
      confidence: 1,
      speaker_player_id: null,
      speaker_character_id: null,
      is_dm: false,
      rolls: [],
    };
    const result = reconstructChecks([
      speech("intent", 1, "I investigate the room.", "ch_hero"),
      checkEvent("c1", 3, 12),
      gap,
    ]);
    expect(result.outcome).toBe("unknown");
  });
});
