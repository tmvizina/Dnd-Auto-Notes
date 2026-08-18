import { describe, expect, it } from "vitest";
import { Events } from "../contracts/events.js";
import { buildSessionEvents, SessionEventTimeline } from "./events.js";
import type { OutlineBuildInput } from "./events.js";

function input() {
  const transcript = {
    utterances: [
      {
        id: "u_1",
        track_id: "t_1",
        player_id: "pl_1",
        start_s: 1,
        end_s: 2,
        text: "I attack.",
        words: [],
        overlap_ids: [],
        bleed_of: null,
        is_backchannel: false,
      },
      {
        id: "u_2",
        track_id: "t_1",
        player_id: "pl_1",
        start_s: 5,
        end_s: 6,
        text: "The room is quiet.",
        words: [],
        overlap_ids: [],
        bleed_of: null,
        is_backchannel: false,
      },
    ],
  } as const;
  const attribution = {
    attributions: [
      {
        utterance_id: "u_1",
        mode: "in_character",
        character_id: "ch_hero",
        confidence: 0.9,
        evidence: {},
        flags: [],
        children: [],
        source: "deterministic",
        overridden_from: null,
      },
      {
        utterance_id: "u_2",
        mode: "narration",
        character_id: null,
        confidence: 0.8,
        evidence: {},
        flags: [],
        children: [],
        source: "deterministic",
        overridden_from: null,
      },
    ],
    summary: {
      in_character: 1,
      out_of_character: 0,
      narration: 1,
      uncertain: 0,
      unknown_character: 0,
    },
  } as const;
  const timeline = {
    rolls: [
      {
        id: "r_1",
        seq: 1,
        who: "Hero",
        player_id: "pl_1",
        formula: "1d20",
        dice: [],
        modifiers: 0,
        total: 18,
        kind: "attack",
        advantage: "none",
      },
      {
        id: "r_2",
        seq: 2,
        who: "Hero",
        player_id: "pl_1",
        formula: "1d20",
        dice: [],
        modifiers: 0,
        total: 12,
        kind: "check",
        advantage: "none",
      },
    ],
    anchors: [
      {
        roll_id: "r_1",
        t_audio_s: 1.5,
        t_uncertainty_s: 0.1,
        anchor: "matched",
        matched_utterance_id: "u_1",
      },
      {
        roll_id: "r_2",
        t_audio_s: 3.5,
        t_uncertainty_s: 0.5,
        anchor: "interpolated",
        matched_utterance_id: null,
      },
    ],
    turnorder: [
      { seq: 1, t_audio_s: 2.5, entries: [{ name: "Hero", value: 18 }], marker: "combat_started" },
    ],
    quality: {
      anchored_fraction: 0.5,
      median_residual_s: 0,
      largest_unanchored_gap_s: 2,
      clock_drift_s: 0,
    },
  } as const;
  return {
    transcript,
    attribution,
    timeline,
    duration_s: 8,
    gap_threshold_s: 0.5,
    registry: {
      players: [
        {
          id: "pl_1",
          display_name: "Alice",
          is_dm: false,
          characters: [{ id: "ch_hero", name: "Hero" }],
        },
      ],
    },
  } as unknown as OutlineBuildInput;
}

describe("outline event model", () => {
  it("is deterministic, strictly ordered, schema-valid, and preserves linked roll evidence", () => {
    const first = buildSessionEvents(input());
    const second = buildSessionEvents(input());
    expect(first).toEqual(second);
    expect(new Set(first.map((event) => event.id)).size).toBe(first.length);
    expect(
      first.every(
        (event, index) => index === 0 || first[index - 1]!.id.localeCompare(event.id) !== 0,
      ),
    ).toBe(true);
    expect(Events.parse({ events: first, beats: [], open_threads: [] }).events).toHaveLength(
      first.length,
    );
    const speech = first.find((event) => event.id === "e_speech_u_1")!;
    expect(speech.source_refs.rolls).toEqual(["r_1"]);
    expect(speech.rolls.map((roll) => roll.id)).toEqual(["r_1"]);
    expect(first.filter((event) => event.source_refs.rolls.includes("r_1"))).toHaveLength(1);
    expect(
      first.some((event) => event.kind === "gap" && event.t_start_s === 2 && event.t_end_s === 5),
    ).toBe(true);
    expect(speech.speaker_display).toBe("Alice");
    expect(speech.character_display).toBe("Hero");
  });

  it("provides deterministic traversal windows, character filtering, and roll lookup", () => {
    const timeline = new SessionEventTimeline(buildSessionEvents(input()));
    expect(timeline.eventsFor("ch_hero").map((event) => event.id)).toEqual(["e_speech_u_1"]);
    expect(timeline.eventsBetween(1, 2).some((event) => event.id === "e_speech_u_1")).toBe(true);
    expect(timeline.rollsInWindow(1, 2).map((event) => event.id)).toEqual(["e_speech_u_1"]);
    expect(timeline.rollsInWindow(3, 4).map((event) => event.id)).toEqual(["e_roll_r_2"]);
  });
});
