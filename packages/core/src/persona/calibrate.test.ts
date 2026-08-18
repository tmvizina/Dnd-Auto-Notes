import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  calibrate,
  MIN_LABELS,
  sampleLabels,
  writeCalibration,
  type LabelRecord,
} from "./calibrate.js";

function labels(): LabelRecord[] {
  return Array.from({ length: 20 }, (_, index) => {
    const inCharacter = index < 10;
    return {
      utterance_id: `u_${String(index).padStart(2, "0")}`,
      mode: inCharacter ? "in_character" : "out_of_character",
      character_id: inCharacter ? "ch_hero" : "ch_other",
      player_id: inCharacter ? "pl_a" : "pl_a",
      session_id: index < 10 ? "s1" : "s2",
      labeller: "test",
      at: "2026-01-01T00:00:00Z",
      features: {
        score_ic: inCharacter ? (index === 9 ? -2 : 2) : index === 19 ? 2 : -2,
        lex_ic: inCharacter ? (index === 9 ? -1 : 1) : index === 19 ? 1 : -1,
      },
      embedding: inCharacter ? [1, 0] : [0, 1],
    };
  });
}

describe("label calibration", () => {
  it("refuses short data and fits real regularized held-out metrics", () => {
    expect(() => calibrate(labels().slice(0, MIN_LABELS - 1))).toThrow("need 1 more labels");
    const report = calibrate(labels(), MIN_LABELS, [
      {
        profile_id: "ch_hero",
        centroid: [0, 1],
        spread_radius: 0,
        example_utterance_count: 1,
        sessions: ["old"],
        version: 1,
      },
      {
        profile_id: "ch_other",
        centroid: [1, 0],
        spread_radius: 0,
        example_utterance_count: 1,
        sessions: ["old"],
        version: 1,
      },
    ]);
    expect(report.folds).toBe(5);
    expect(report.weights_by_class["in_character"]?.["score_ic"]).toBeDefined();
    expect(Object.keys(report.precision)).toEqual(["in_character", "out_of_character"]);
    expect(report.threshold_sweep.some((item) => item.flagged_fraction > 0)).toBe(true);
    expect(report.threshold_sweep.some((item) => item.error_rate > 0)).toBe(true);
    expect(report.profile_accuracy_before.accuracy).toBe(0);
    expect(report.profile_accuracy_after.accuracy).toBe(0);
    expect(report.profile_accuracy_after.evaluated).toBe(10);
  });

  it("samples all strategies deterministically and excludes labelled records", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      utterance_id: `u${index}`,
      player_id: index < 10 ? "a" : "b",
      mode: index < 10 ? "in_character" : "narration",
      score: index === 11 ? 0.5 : 0.1,
    }));
    expect(
      sampleLabels(items, "sequential", 2, new Set(["u0"])).map((item) => item.utterance_id),
    ).toEqual(["u1", "u2"]);
    expect(sampleLabels(items, "uncertain", 1).map((item) => item.utterance_id)).toEqual(["u5"]);
    const stratified = sampleLabels(items, "stratified", 6);
    expect(stratified).toHaveLength(6);
    expect(stratified.filter((item) => item.player_id === "a")).toHaveLength(5);
    expect(stratified.filter((item) => item.player_id === "b")).toHaveLength(1);
  });

  it("publishes immutable scorer versions and moves only the active pointer", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-12-calibration-"));
    try {
      const report = calibrate(labels());
      const now = () => "2026-01-01T00:00:00.000Z";
      const first = await writeCalibration(root, report, now);
      const second = await writeCalibration(root, report, now);
      expect(first).not.toBe(second);
      expect(readFileSync(first, "utf8")).toContain("weights_by_class");
      expect(JSON.parse(readFileSync(join(root, "active.json"), "utf8")).path).toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
