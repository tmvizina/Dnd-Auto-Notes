import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Roll } from "../contracts/timeline.js";
import type { Utterance } from "../contracts/utterances.js";
import { parseRoll20 } from "../intake/roll20/index.js";
import { readArtifact, resolveSession, writeArtifact } from "../session/session.js";
import { runIntakeStage } from "../stages/intake.js";
import { runAlignStage } from "../stages/align.js";
import { alignRolls, projectSequence, scoreRollUtterance, type AlignRoll } from "./rollSpeech.js";

function roll(
  id: string,
  seq: number,
  total: number,
  playerId = "p1",
  dice: Roll["dice"] = [],
): AlignRoll {
  return {
    id,
    seq,
    who: playerId,
    player_id: playerId,
    formula: String(total),
    dice,
    modifiers: 0,
    total,
    kind: "check",
    advantage: "none",
  };
}

function utterance(id: string, startS: number, text: string, playerId = "p1"): Utterance {
  return {
    id,
    track_id: `track-${playerId}`,
    player_id: playerId,
    start_s: startS,
    end_s: startS + 1,
    text,
    words: [],
    overlap_ids: [],
    bleed_of: null,
    is_backchannel: false,
  };
}

describe("roll/speech anchoring", () => {
  it("uses shared spoken-number normalization and non-dropped die faces", () => {
    const candidate = roll("r1", 1, 99, "p1", [
      { sides: 20, value: 21, dropped: false },
      { sides: 20, value: 4, dropped: true },
    ]);
    expect(scoreRollUtterance(candidate, utterance("u1", 1, "twenty-one on the die"))).toBe(11);
    expect(scoreRollUtterance(candidate, utterance("u2", 1, "four on the die"))).toBe(3);
  });

  it("uses a global monotonic DP when greedy matching would consume the only utterance", () => {
    const result = alignRolls(
      [roll("r1", 1, 10, "p1"), roll("r2", 2, 20, "p2")],
      [utterance("u1", 2, "ten or twenty", "p2")],
      { timeBasis: "order_only" },
    );
    expect(result.anchors.map((anchor) => anchor.matched_utterance_id)).toEqual([null, "u1"]);
  });

  it("applies a wide temporal prior without overpowering number evidence", () => {
    const candidate = { ...roll("r1", 1, 17), expected_time_s: 10 };
    const near = scoreRollUtterance(candidate, utterance("near", 10, "seventeen"), "wallclock");
    const far = scoreRollUtterance(candidate, utterance("far", 50, "seventeen"), "wallclock");
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(10);
  });

  it("rejects a robust-fit outlier and widens uncertainty away from anchors", () => {
    const result = alignRolls(
      [
        roll("r1", 1, 11),
        roll("r2", 2, 12),
        roll("r3", 3, 13),
        roll("r4", 4, 14),
        roll("r5", 5, 99),
        roll("r6", 6, 98),
        roll("r7", 7, 97),
        roll("r8", 8, 17),
      ],
      [
        utterance("u1", 9.5, "eleven"),
        utterance("u2", 19.5, "twelve"),
        utterance("outlier", 99.5, "thirteen"),
        utterance("u4", 100.5, "fourteen"),
        utterance("u8", 119.5, "seventeen"),
      ],
    );
    expect(result.anchors[2]).toMatchObject({ anchor: "interpolated", t_audio_s: 60.5 });
    expect(result.anchors[2]?.matched_utterance_id).toBeNull();
    expect(result.anchors[5]!.t_uncertainty_s).toBeGreaterThan(result.anchors[4]!.t_uncertainty_s);
    expect(
      result.anchors.every(
        (anchor, index) => index === 0 || anchor.t_audio_s >= result.anchors[index - 1]!.t_audio_s,
      ),
    ).toBe(true);
  });

  it("reports the full interval containing a multi-roll unanchored gap", () => {
    const result = alignRolls(
      [roll("r1", 1, 11), roll("r2", 2, 90), roll("r3", 3, 91), roll("r4", 4, 14)],
      [utterance("u1", 9.5, "eleven"), utterance("u4", 49.5, "fourteen")],
    );
    expect(result.quality.largest_unanchored_gap_s).toBe(40);
  });

  it("detects a systematic wallclock residual", () => {
    const result = alignRolls(
      [
        { ...roll("r1", 1, 17), expected_time_s: 0 },
        { ...roll("r2", 2, 18), expected_time_s: 10 },
      ],
      [utterance("u1", 29.5, "seventeen"), utterance("u2", 39.5, "eighteen")],
      { timeBasis: "wallclock" },
    );
    expect(result.quality.clock_drift_s).toBe(30);
    expect(result.quality.median_residual_s).toBe(30);
  });

  it("projects turn-order sequence positions through the same fit", () => {
    const result = alignRolls(
      [roll("r1", 10, 11), roll("r2", 30, 14)],
      [utterance("u1", 9.5, "eleven"), utterance("u2", 29.5, "fourteen")],
    );
    expect(projectSequence(20, result.fit)).toMatchObject({
      anchor: "interpolated",
      t_audio_s: 20,
    });
  });
});

interface TruthFixture {
  readonly utterances: readonly {
    readonly id: string;
    readonly player_id: string;
    readonly start_s: number;
    readonly end_s: number;
    readonly text: string;
  }[];
  readonly rolls: readonly {
    readonly id: string;
    readonly player_id: string;
    readonly total: number;
    readonly announced_by: string | null;
  }[];
  readonly turnorder: readonly unknown[];
}

describe("generated fixture alignment", () => {
  let root: string;
  let truth: TruthFixture;
  let fixtureRolls: AlignRoll[];
  let fixtureUtterances: Utterance[];

  beforeAll(() => {
    root = mkdtempSync(join(process.cwd(), ".p2-09-align-"));
    execFileSync(
      process.execPath,
      [join(process.cwd(), "tools", "generate-fixture.mjs"), "--out", root, "--seed", "209"],
      { stdio: "ignore" },
    );
    truth = JSON.parse(readFileSync(join(root, "truth.json"), "utf8")) as TruthFixture;
    const capture = JSON.parse(
      readFileSync(join(root, "input", "roll20", "roll20-capture.json"), "utf8"),
    ) as unknown;
    const parsed = parseRoll20(capture);
    fixtureRolls = truth.rolls.map((expected, index) => {
      const actual = parsed.rolls[index]!;
      return {
        id: expected.id,
        seq: actual.seq,
        who: actual.who ?? expected.player_id,
        player_id: expected.player_id,
        formula: actual.formula,
        dice: actual.dice.flatMap((die) =>
          die.sides === null ? [] : [{ sides: die.sides, value: die.value, dropped: die.dropped }],
        ),
        modifiers: actual.modifiers,
        total: expected.total,
        kind: actual.kind,
        advantage: actual.advantage,
      };
    });
    fixtureUtterances = truth.utterances.map((item) => ({
      id: item.id,
      track_id: `track-${item.player_id}`,
      player_id: item.player_id,
      start_s: item.start_s,
      end_s: item.end_s,
      text: item.text,
      words: [],
      overlap_ids: [],
      bleed_of: null,
      is_backchannel: false,
    }));
  });

  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("matches fixture roll announcements above the recorded order-only fraction", () => {
    const result = alignRolls(fixtureRolls, fixtureUtterances, { timeBasis: "order_only" });
    const expected = new Map(truth.rolls.map((item) => [item.id, item.announced_by]));
    expect(result.anchors.map((anchor) => anchor.matched_utterance_id)).toEqual(
      result.anchors.map((anchor) => expected.get(anchor.roll_id)),
    );
    expect(result.quality.anchored_fraction).toBeGreaterThanOrEqual(0.8);
  });

  it("persists quality and aligned turn-order events through the stage", async () => {
    const session = await resolveSession(root, root);
    if (session === null) throw new Error("generated fixture session did not resolve");
    await runIntakeStage({ session, force: true });
    await writeArtifact(session, "transcript", { utterances: fixtureUtterances });
    const result = await runAlignStage({ session, force: true });
    const timeline = await readArtifact(session, "timeline");
    expect(result.value?.quality).toEqual(timeline.quality);
    expect(timeline.quality.anchored_fraction).toBeGreaterThanOrEqual(0.8);
    expect(timeline.turnorder).toHaveLength(truth.turnorder.length);
    expect(timeline.turnorder.map((event) => event.marker)).toContain("combat_started");
  });
});
