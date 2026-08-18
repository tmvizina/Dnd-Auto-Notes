import { describe, expect, it } from "vitest";
import { Events } from "../contracts/events.js";
import type { OutlineEvent } from "./events.js";
import { BEAT_GAP_S, MIN_BEAT_DURATION_S, scoreBeatBoundaries, segmentBeats } from "./beats.js";

function event(
  id: string,
  kind: OutlineEvent["kind"],
  start: number,
  end: number,
  extra: Partial<OutlineEvent> = {},
): OutlineEvent {
  return {
    id,
    kind,
    t_start_s: start,
    t_end_s: end,
    source_refs: { utterances: [], rolls: [] },
    confidence: 1,
    speaker_player_id: null,
    speaker_character_id: null,
    is_dm: false,
    rolls: [],
    ...extra,
  };
}

function fixture(): readonly OutlineEvent[] {
  return [
    event("e_session_start", "session_start", 0, 0),
    event("e_speech_1", "speech", 1, 3, {
      speaker_player_id: "pl_a",
      speaker_character_id: "ch_a",
      character_display: "Aster",
      mode: "in_character",
      text: "We enter the ruins.",
      source_refs: { utterances: ["u_1"], rolls: [] },
    }),
    event("e_gap_1", "gap", 3, 14),
    event("e_combat_start", "combat_start", 14, 14),
    event("e_speech_2", "speech", 15, 18, {
      speaker_player_id: "pl_b",
      speaker_character_id: "npc_guard",
      character_display: "Guard",
      mode: "in_character",
      text: "Halt!",
      source_refs: { utterances: ["u_2"], rolls: ["r_1"] },
      rolls: [
        {
          id: "r_1",
          seq: 1,
          who: "Guard",
          player_id: null,
          formula: "1d20",
          dice: [],
          modifiers: 0,
          total: 16,
          kind: "attack",
          advantage: "none",
        },
      ],
    }),
    event("e_combat_end", "combat_end", 20, 20),
    event("e_speech_3", "speech", 22, 25, {
      speaker_player_id: "pl_a",
      speaker_character_id: "ch_a",
      character_display: "Aster",
      mode: "out_of_character",
      text: "Can we check the rules?",
      source_refs: { utterances: ["u_3"], rolls: [] },
    }),
    event("e_session_end", "session_end", 30, 30),
  ];
}

describe("deterministic beat segmentation", () => {
  it("scores weighted deterministic boundary signals", () => {
    const candidates = scoreBeatBoundaries({
      events: fixture(),
      glossary: ["ruins"],
      npc_ids: ["npc_guard"],
      config: { gap_s: BEAT_GAP_S, window_events: 2 },
    });
    const kinds = new Set(
      candidates.flatMap((candidate) => candidate.signals.map((signal) => signal.kind)),
    );
    expect(kinds).toContain("silence_gap");
    expect(kinds).toContain("turnorder_transition");
    expect(candidates.every((candidate) => candidate.score > 0)).toBe(true);
    expect(candidates).toEqual(
      scoreBeatBoundaries({
        events: fixture(),
        glossary: ["ruins"],
        npc_ids: ["npc_guard"],
        config: { gap_s: BEAT_GAP_S, window_events: 2 },
      }),
    );
  });

  it("peak-picks without short fragments and partitions every event exactly once", () => {
    const result = segmentBeats({
      events: fixture(),
      glossary: ["ruins"],
      npc_ids: ["npc_guard"],
      config: { min_duration_s: 4, gap_s: 5, window_events: 2 },
    });
    expect(result.beats.length).toBeGreaterThan(1);
    expect(result.beats.every((beat) => beat.end_s - beat.start_s >= 4)).toBe(true);
    const assigned = result.beats.flatMap((beat) => [...beat.utterance_ids, ...beat.roll_ids]);
    expect(assigned.sort()).toEqual(["r_1", "u_1", "u_2", "u_3"].sort());
    expect(result.beats.flatMap((beat) => beat.event_ids).sort()).toEqual(
      fixture()
        .map((item) => item.id)
        .sort(),
    );
    expect(new Set(result.beats.map((beat) => beat.title)).size).toBe(result.beats.length);
    expect(
      result.beats.every((beat) => beat.title.length > 0 && beat.boundary_evidence.length > 0),
    ).toBe(true);
  });

  it("classifies, titles, and emits per-beat metrics", () => {
    const result = segmentBeats({
      events: fixture(),
      glossary: ["ruins"],
      npc_ids: ["npc_guard"],
      config: { min_duration_s: 1, gap_s: 5, window_events: 2 },
    });
    expect(result.beats.some((beat) => beat.kind === "combat")).toBe(true);
    expect(result.beats.some((beat) => beat.kind === "table")).toBe(true);
    expect(
      Events.parse({ events: fixture(), beats: result.beats, open_threads: [] }).beats,
    ).toHaveLength(result.beats.length);
    const combat = result.beats.find((beat) => beat.kind === "combat")!;
    expect(combat.roll_counts.attack).toBe(1);
    expect(combat.in_character_speech_ratio).toBe(1);
    expect(combat.dominant_characters).toContain("npc_guard");
    expect(combat.title).toContain("Guard");
    expect(combat.event_ids).toContain("e_combat_start");
    expect(combat.event_ids).toContain("e_combat_end");
    expect(combat.event_ids).toContain("e_speech_2");
  });

  it("does not emit a transition-only beat after combat ends", () => {
    const result = segmentBeats({
      events: fixture(),
      glossary: ["ruins"],
      npc_ids: ["npc_guard"],
      config: { min_duration_s: 1, gap_s: 5, window_events: 2 },
    });
    expect(
      result.beats.some(
        (beat) => beat.event_ids.length === 1 && beat.event_ids[0] === "e_combat_end",
      ),
    ).toBe(false);
  });

  it("compares fixture truth deterministically", () => {
    const result = segmentBeats({
      events: fixture(),
      glossary: ["ruins"],
      npc_ids: ["npc_guard"],
      config: { min_duration_s: MIN_BEAT_DURATION_S },
      truth: { beats: [{ kind: "combat", start_s: 0, end_s: 30 }] },
    });
    expect(result.metrics.predicted_count).toBe(1);
    expect(result.metrics.truth_count).toBe(1);
    expect(result.metrics.count_error_fraction).toBe(0);
    expect(result.metrics.count_within_20_percent).toBe(true);
    expect(result.metrics.classification_accuracy).toBe(1);
    expect(result.metrics.boundary_accuracy).toBe(1);
  });

  it("keeps classification accuracy independent from boundary matching", () => {
    const result = segmentBeats({
      events: fixture(),
      config: { min_duration_s: MIN_BEAT_DURATION_S },
      truth: { beats: [{ kind: "combat", start_s: 2, end_s: 28 }] },
    });
    expect(result.metrics.classification_accuracy).toBe(1);
    expect(result.metrics.boundary_accuracy).toBe(0);
  });

  it("rejects duplicate event and source references at runtime", () => {
    expect(() => segmentBeats({ events: [fixture()[0]!, fixture()[0]!] })).toThrow(
      "duplicate event id",
    );
    const duplicateRef = event("e_duplicate", "speech", 31, 32, {
      source_refs: { utterances: ["u_1"], rolls: [] },
    });
    expect(() => segmentBeats({ events: [...fixture(), duplicateRef] })).toThrow(
      "duplicate utterance reference",
    );
  });
});
