import { describe, expect, it } from "vitest";
import { Manifest, ManifestRoll } from "./manifest.js";

const roll = {
  id: "r0001",
  source_id: "-Mfx000001",
  seq: 3,
  who: "Ash B.",
  roll20_player_id: null,
  player_id: "pl_ash",
  formula: "1d20+7",
  dice: [{ sides: 20, value: 16, dropped: false }],
  modifiers: 7,
  total: 23,
  kind: "attack",
  roll_kind: "attack",
  advantage: "none",
  used: 16,
  used_result: 16,
  target: "Bandit Captain",
  npc_mentions: ["Bandit Captain"],
  raw_ref: "-Mfx000001",
} as const;

describe("ManifestRoll", () => {
  it("accepts mapped evidence while retaining the source reference", () => {
    expect(ManifestRoll.safeParse(roll).success).toBe(true);
  });

  it("accepts incomplete parser evidence without inventing values", () => {
    const result = ManifestRoll.safeParse({
      ...roll,
      id: "r0002",
      source_id: null,
      who: null,
      roll20_player_id: "-Nunknown",
      player_id: null,
      dice: [{ sides: null, value: 0, dropped: false }],
      total: null,
      used: null,
      used_result: null,
      target: null,
      npc_mentions: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts the minimal parser payload when optional evidence is absent", () => {
    const result = ManifestRoll.safeParse({
      id: "r0003",
      seq: 4,
      who: null,
      player_id: null,
      formula: "",
      dice: [],
      modifiers: 0,
      total: null,
      roll_kind: "other",
      advantage: "none",
      raw_ref: "local:json:4",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-pipeline roll id and a missing raw reference", () => {
    const result = ManifestRoll.safeParse({ ...roll, id: "-Mfx000001", raw_ref: "" });
    expect(result.success).toBe(false);
  });

  it("defaults rolls for older manifests while validating the normalized shape", () => {
    const result = Manifest.safeParse({
      session_id: "2026-08-16-s42",
      recording: { started_at: null, duration_s: 0, source: "craig", track_count: 0 },
      tracks: [],
      roll20: null,
      qa: [],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rolls).toEqual([]);
  });
});
