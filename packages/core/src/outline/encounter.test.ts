import { describe, expect, it } from "vitest";
import { Beat, Encounter } from "../contracts/events.js";
import type { Roll } from "../contracts/timeline.js";
import type { OutlineEvent } from "./events.js";
import { reconstructEncounter } from "./encounter.js";

function roll(
  id: string,
  who: string,
  kind: "attack" | "damage" | "initiative",
  total: number,
  advantage: "none" | "advantage" | "disadvantage" = "none",
  targeted = true,
): Roll {
  return {
    id,
    seq: Number(id.slice(1)),
    who,
    player_id: null,
    formula: "1d20",
    dice: [{ sides: 20, value: kind === "attack" ? 20 : 8, dropped: false }],
    modifiers: 0,
    total,
    kind,
    advantage,
    ...(kind === "damage" && targeted ? { raw_ref: "target=target_dummy" } : {}),
  };
}

function event(
  id: string,
  time: number,
  character: string | null,
  rolls: readonly ReturnType<typeof roll>[],
  text?: string,
): OutlineEvent {
  return {
    id,
    kind: rolls.length > 0 ? "roll" : "speech",
    t_start_s: time,
    t_end_s: time + 1,
    source_refs: {
      utterances: text === undefined ? [] : [`u_${id}`],
      rolls: rolls.map((item) => item.id),
    },
    confidence: 1,
    speaker_player_id: null,
    speaker_character_id: character,
    ...(character === null ? {} : { speaker_display: character }),
    is_dm: false,
    ...(text === undefined ? {} : { text }),
    rolls,
  };
}

function tracker(): OutlineEvent {
  return {
    id: "e_tracker",
    kind: "combat_start",
    t_start_s: 0,
    t_end_s: 0,
    source_refs: { utterances: [], rolls: [] },
    confidence: 1,
    speaker_player_id: null,
    speaker_character_id: null,
    is_dm: false,
    rolls: [],
    turnorder: {
      seq: 0,
      t_audio_s: 0,
      marker: "combat_started",
      entries: [
        { name: "A", value: 18 },
        { name: "B", value: 12 },
      ],
    },
  };
}

describe("combat encounter reconstruction", () => {
  it("cycles tracker turns into rounds, preserves advantage, and attaches narration", () => {
    const result = reconstructEncounter(
      [
        tracker(),
        event("e_a1", 1, "ch_a", [roll("r1", "A", "attack", 22, "advantage")]),
        event("e_b1", 2, "ch_b", [roll("r2", "B", "damage", 7)]),
        event("e_a2", 3, "ch_a", [roll("r3", "A", "damage", 5)]),
        event("e_speech", 3.2, "ch_a", [], "I move behind the pillar."),
      ],
      { actorByName: { A: "ch_a", B: "ch_b" } },
    );
    expect(result.reconstruction).toBe("tracker");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.turns[0]?.roll_evidence[0]?.advantage).toBe("advantage");
    expect(result.rounds[0]?.turns[0]?.roll_evidence[0]?.seq).toBe(1);
    expect(result.rounds[0]?.turns[0]?.roll_evidence[0]).toMatchObject({
      who: "A",
      player_id: null,
      formula: "1d20",
      modifiers: 0,
      dice: [{ sides: 20, value: 20, dropped: false }],
      target: null,
      critical: true,
    });
    expect(result.rounds[1]?.turns[0]?.narration_utterances).toEqual(["u_e_speech"]);
    expect(result.damage_by_actor).toEqual({ ch_a: 5, ch_b: 7 });
    expect(result.damage_by_target).toEqual({ target_dummy: 12 });
    expect(result.notable_roll_ids).toEqual(["r1"]);
  });

  it("uses an inferred initiative order without inventing outcomes", () => {
    const result = reconstructEncounter(
      [
        event("e_init", 0, "ch_a", [roll("r0", "A", "initiative", 18)]),
        event("e_a", 1, "ch_a", [roll("r1", "A", "attack", 10)]),
        event("e_b", 2, "ch_b", [roll("r2", "B", "damage", 4)]),
        event("e_a2", 3, "ch_a", [roll("r3", "A", "attack", 11)]),
        event("e_unknown", 4, null, [roll("r4", "Mystery", "attack", 9)]),
      ],
      { actorByName: { A: "ch_a", B: "ch_b" } },
    );
    expect(result.reconstruction).toBe("inferred");
    expect(result.rounds).toHaveLength(2);
    expect(result.unassigned_rolls).toEqual([
      { roll_id: "r4", reason: "actor could not be resolved" },
    ]);
    expect(result.summary.total_damage).toBe(4);
    expect(result.reconstruction_evidence).toHaveLength(2);
    expect(result).not.toHaveProperty("hp");
    expect(result).not.toHaveProperty("dead");
  });

  it("is contract-parseable with explicit unassigned reasons and every roll accounted for", () => {
    const result = reconstructEncounter(
      [
        event("e_a", 1, "ch_a", [roll("r1", "A", "attack", 10)]),
        event("e_unknown", 2, null, [roll("r2", "Mystery", "damage", 3)]),
      ],
      { actorByName: { A: "ch_a" } },
    );
    expect(Encounter.parse(result).unassigned_rolls).toHaveLength(1);
    const beat = Beat.parse({
      id: "b_1",
      kind: "combat",
      start_s: 0,
      end_s: 5,
      title: "combat: test",
      encounter: result,
    });
    // r1 is a natural 20, which is exactly what "notable" means here.
    expect(beat.encounter?.summary.notable_count).toBe(1);
  });

  it("reconstructs trackerless input with no initiative cluster rather than refusing", () => {
    // Plenty of tables never touch the tracker and call initiative out loud.
    // The acceptance list asks for an inferred reconstruction with every roll
    // accounted for, so dropping the beat is not an available answer.
    const result = reconstructEncounter(
      [event("e_a", 1, "ch_a", [roll("r1", "A", "attack", 10)])],
      {
        actorByName: { A: "ch_a" },
      },
    );
    expect(result.reconstruction).toBe("inferred");
    expect(result.rounds.flatMap((round) => round.turns).flatMap((turn) => turn.roll_ids)).toEqual([
      "r1",
    ]);
    expect(result.unassigned_rolls).toEqual([]);
  });

  it("retains untargeted damage evidence without inventing totals", () => {
    const result = reconstructEncounter(
      [
        tracker(),
        event("e_damage", 1, "ch_a", [roll("r_damage", "A", "damage", 9, "none", false)]),
      ],
      { actorByName: { A: "ch_a" } },
    );
    expect(result.damage_by_actor).toEqual({});
    expect(result.damage_by_target).toEqual({});
    expect(result.rounds[0]?.turns[0]?.roll_evidence[0]?.kind).toBe("damage");
  });

  it("tracks insertion, removal, and delay snapshots without false global-index wraps", () => {
    const snapshot = (id: string, time: number, names: readonly string[]): OutlineEvent => ({
      id,
      kind: "turnorder",
      t_start_s: time,
      t_end_s: time,
      source_refs: { utterances: [], rolls: [] },
      confidence: 1,
      speaker_player_id: null,
      speaker_character_id: null,
      is_dm: false,
      rolls: [],
      turnorder: {
        seq: Math.round(time * 10),
        t_audio_s: time,
        marker: "changed",
        entries: names.map((name, index) => ({ name, value: 20 - index })),
      },
    });
    const result = reconstructEncounter(
      [
        snapshot("s0", 0, ["A", "B"]),
        event("a1", 1, "ch_a", [roll("r1", "A", "attack", 10)]),
        snapshot("insert", 1.5, ["A", "B", "C"]),
        event("b1", 2, "ch_b", [roll("r2", "B", "attack", 10)]),
        event("c1", 3, "ch_c", [roll("r3", "C", "attack", 10)]),
        snapshot("remove", 3.5, ["A", "B"]),
        event("a2", 4, "ch_a", [roll("r4", "A", "attack", 10)]),
        snapshot("delay", 4.5, ["B", "A"]),
        event("b2", 5, "ch_b", [roll("r5", "B", "attack", 10)]),
        event("a3", 6, "ch_a", [roll("r6", "A", "attack", 10)]),
      ],
      { actorByName: { A: "ch_a", B: "ch_b", C: "ch_c" } },
    );
    expect(result.rounds.length).toBeGreaterThanOrEqual(2);
    expect(result.rounds.map((round) => round.turns.flatMap((turn) => turn.roll_ids))).toEqual([
      ["r1", "r2", "r3"],
      ["r4", "r5"],
      ["r6"],
    ]);
  });

  it("excludes the first roll after trackerless density collapse", () => {
    const result = reconstructEncounter(
      [
        event("init", 0, "ch_a", [roll("ri", "A", "initiative", 18)]),
        event("combat", 1, "ch_a", [roll("ra", "A", "attack", 10)]),
        event("after", 30, "ch_b", [roll("rb", "B", "attack", 10)]),
      ],
      { actorByName: { A: "ch_a", B: "ch_b" } },
    );
    expect(result.rounds.flatMap((round) => round.turns).flatMap((turn) => turn.roll_ids)).toEqual([
      "ri",
      "ra",
    ]);
    expect(result.reconstruction_evidence[1]).toContain("1.00s");
  });

  it("does not wrap on an out-of-order partial traversal", () => {
    const order: OutlineEvent = {
      ...tracker(),
      turnorder: {
        ...tracker().turnorder!,
        entries: [
          { name: "A", value: 18 },
          { name: "B", value: 12 },
          { name: "C", value: 8 },
        ],
      },
    };
    const result = reconstructEncounter(
      [
        order,
        event("a", 1, "ch_a", [roll("ra", "A", "attack", 10)]),
        event("c", 2, "ch_c", [roll("rc", "C", "attack", 10)]),
        event("b", 3, "ch_b", [roll("rb", "B", "attack", 10)]),
        event("a2", 4, "ch_a", [roll("ra2", "A", "attack", 10)]),
      ],
      { actorByName: { A: "ch_a", B: "ch_b", C: "ch_c" } },
    );
    expect(result.rounds.map((round) => round.turns.flatMap((turn) => turn.roll_ids))).toEqual([
      ["ra", "rc", "rb"],
      ["ra2"],
    ]);
  });
});
