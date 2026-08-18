import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  PersonaConfigError,
  scorePersona,
  validatePersonaConfig,
  type PersonaScoringInput,
} from "./scorer.js";
import { createSession, writeArtifact } from "../session/session.js";
import { runPersonaStage } from "../stages/persona.js";
import { openDb, closeDb } from "../db/db.js";
import { upsertSession } from "../db/records.js";

const config = loadConfig();

function input(id: string, changes: Partial<PersonaScoringInput> = {}): PersonaScoringInput {
  return {
    utterance_id: id,
    player_id: "pl_a",
    start_s: 0,
    end_s: 2,
    text: "the ancient keep",
    is_backchannel: false,
    overlap: false,
    lex_ic: 1,
    profiles: [{ character_id: "ch_hero", similarity: 0.9 }],
    active_character_ids: ["ch_hero"],
    ...changes,
  };
}

describe("persona scorer", () => {
  it("loads versioned weights and carries evidence into banded decisions", () => {
    const result = scorePersona(
      [input("u1", { voice_sim_character: 1, voice_margin: 0.5 })],
      config,
    );
    expect(result.file.weights_version).toBe("persona-1");
    expect(result.file.attributions[0]).toMatchObject({
      mode: "in_character",
      character_id: "ch_hero",
      evidence: {
        lex_ic: 1,
        voice_sim_character: 1,
        duration_s: 2,
        is_backchannel: false,
        overlap: false,
        profile_similarity: 0.9,
        profile_match_count: 1,
        score_ic: expect.any(Number),
      },
    });
  });

  it("restricts character matches to active profiles and flags close margins", () => {
    const result = scorePersona(
      [
        input("u1", {
          voice_sim_character: 1,
          profiles: [
            { character_id: "ch_inactive", similarity: 0.99 },
            { character_id: "ch_hero", similarity: 0.98 },
          ],
          active_character_ids: ["ch_hero"],
        }),
      ],
      config,
    );
    expect(result.file.attributions[0]?.character_id).toBe("ch_hero");
    expect(
      scorePersona([input("u-empty", { voice_sim_character: 1, active_character_ids: [] })], config)
        .file.attributions[0]?.character_id,
    ).toBe(null);

    const uncertain = scorePersona(
      [input("u2", { lex_ooc: 0.5, lex_ic: 0.5, voice_margin: 0 })],
      config,
    ).file.attributions[0];
    expect(uncertain?.mode).toBe("uncertain");
    expect(uncertain?.flags.some((flag) => flag.code === "voice_margin_low")).toBe(true);
  });

  it("creates exact-time child quote attributions and bounded smoothing logs", () => {
    const result = scorePersona(
      [
        input("u1", { voice_sim_character: 1 }),
        input("u2", { voice_sim_character: 0, lex_ooc: 0, lex_ic: 0 }),
        input("u3", { voice_sim_character: 1 }),
      ],
      config,
    );
    expect(result.file.attributions[1]?.mode).toBe("in_character");
    expect(
      result.file.attributions[1]?.flags.some((flag) => flag.code === "smoothing_applied"),
    ).toBe(true);
    const quote = scorePersona(
      [input("u4", { quoteSpans: [{ start_s: 1.25, end_s: 1.75 }] })],
      config,
    ).file.attributions[0]?.children[0];
    expect(
      scorePersona([input("u4", { quoteSpans: [{ start_s: 1.25, end_s: 1.75 }] })], config).file
        .attributions[0]?.mode,
    ).toBe("narration");
    expect(quote).toMatchObject({ start_s: 1.25, end_s: 1.75, mode: "in_character" });
  });

  it("does not smooth strong or quoted decisions and validates caller configs", () => {
    const strong = scorePersona(
      [
        input("u1", { lex_ooc: 2 }),
        input("u2", { voice_sim_character: 1, lex_ic: 2 }),
        input("u3", { lex_ooc: 2 }),
      ],
      config,
    ).file.attributions[1];
    expect(strong?.flags.some((flag) => flag.code === "smoothing_applied")).toBe(false);
    expect(() =>
      validatePersonaConfig({ ...config, thresholds: { ...config.thresholds, hi: 0.2 } }),
    ).toThrowError(PersonaConfigError);
  });

  it("completes an empty profile bank with explicit flags and reports per-class truth", () => {
    const result = scorePersona(
      [
        input("u1", { profiles: [], active_character_ids: [] }),
        input("u2", { lex_ooc: 2, lex_ic: 0, profiles: [] }),
      ],
      config,
      { u1: "in_character", u2: "out_of_character" },
    );
    expect(result.file.attributions.every((item) => item.flags.length > 0)).toBe(true);
    expect(result.file.attributions.every((item) => item.mode === "uncertain")).toBe(true);
    expect(result.accuracy).toEqual({
      in_character: { correct: 0, total: 1, accuracy: 0 },
      out_of_character: { correct: 0, total: 1, accuracy: 0 },
    });
  });

  it("writes attribution and mirrors persona flags while invalidating on registry/config inputs", async () => {
    const root = await mkdtemp(join(process.cwd(), ".p2-07-stage-"));
    const campaign = join(root, "campaign");
    const sessions = join(root, "sessions");
    try {
      await mkdir(campaign, { recursive: true });
      await writeFile(
        join(campaign, "players.json"),
        JSON.stringify({
          players: [
            {
              id: "pl_a",
              display_name: "Alice",
              is_dm: false,
              discord: { username: "alice", craig_track_hints: [] },
              roll20: { player_ids: [] },
              characters: [{ id: "ch_hero", name: "Hero" }],
            },
          ],
        }),
      );
      const session = await createSession(sessions, {
        title: "Persona",
        date: "2026-01-01",
        number: 1,
      });
      await writeArtifact(session, "transcript", {
        utterances: [
          {
            id: "u1",
            track_id: "t1",
            player_id: "pl_a",
            start_s: 0,
            end_s: 2,
            text: "the ancient keep",
            words: [
              { t: "the", s: 0, e: 0.2 },
              { t: "ancient", s: 0.2, e: 0.5 },
              { t: "keep", s: 0.5, e: 0.8 },
            ],
            overlap_ids: [],
            bleed_of: null,
            is_backchannel: false,
          },
        ],
      });
      await writeArtifact(session, "features", {
        embedding: { backend: "fake", dimension: 1, normalised: true, blob: "features.bin" },
        min_duration_s: 0.6,
        rows: [
          { utterance_id: "u1", player_id: "pl_a", offset: null, prosody: null, prosody_z: null },
        ],
      });
      await writeArtifact(session, "timeline", {
        rolls: [],
        anchors: [],
        turnorder: [],
        quality: {
          anchored_fraction: 0,
          median_residual_s: null,
          largest_unanchored_gap_s: null,
          clock_drift_s: null,
        },
      });
      const db = openDb(join(root, "notes.db"));
      try {
        upsertSession(db, {
          session_id: session.descriptor.id,
          title: session.descriptor.title,
          number: 1,
          date: session.descriptor.date,
          root_path: session.paths.root,
        });
        const result = await runPersonaStage({
          session,
          campaignRoot: campaign,
          profiles: { pl_a: [{ character_id: "ch_hero", similarity: 0.9 }] },
          db,
          force: true,
        });
        expect(result.value?.attributions[0]?.character_id).toBe("ch_hero");
        expect(result.value?.weights_version).toBe("persona-1");
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM flags WHERE session_id = ? AND stage = 'persona'",
            )
            .get(session.descriptor.id),
        ).toMatchObject({ count: 0 });
        const prosody = {
          f0_mean: 0,
          f0_std: 0,
          f0_range: 0,
          rate_wps: 0,
          intensity_mean: 0,
          intensity_std: 0,
          spectral_tilt: 0,
          jitter_proxy: 0,
          pause_ratio: 0,
        };
        await writeArtifact(session, "features", {
          embedding: { backend: "fake", dimension: 1, normalised: true, blob: "features.bin" },
          min_duration_s: 0.6,
          rows: [
            { utterance_id: "u1", player_id: "pl_a", offset: null, prosody, prosody_z: prosody },
          ],
        });
        const prosodyBaseline = await runPersonaStage({
          session,
          campaignRoot: campaign,
          profiles: { pl_a: [{ character_id: "ch_hero", similarity: 0.9 }] },
          db,
          force: true,
        });
        const changedProsody = { ...prosody, f0_std: 5 };
        await writeArtifact(session, "features", {
          embedding: { backend: "fake", dimension: 1, normalised: true, blob: "features.bin" },
          min_duration_s: 0.6,
          rows: [
            {
              utterance_id: "u1",
              player_id: "pl_a",
              offset: null,
              prosody: changedProsody,
              prosody_z: changedProsody,
            },
          ],
        });
        const prosodyChanged = await runPersonaStage({
          session,
          campaignRoot: campaign,
          profiles: { pl_a: [{ character_id: "ch_hero", similarity: 0.9 }] },
          db,
          force: true,
        });
        expect(prosodyChanged.value?.attributions[0]?.evidence.prosody_z?.f0_std).toBe(5);
        expect(prosodyChanged.value?.attributions[0]?.evidence.score_ic).not.toBe(
          prosodyBaseline.value?.attributions[0]?.evidence.score_ic,
        );
        const skipped = await runPersonaStage({
          session,
          campaignRoot: campaign,
          profiles: { pl_a: [{ character_id: "ch_hero", similarity: 0.9 }] },
          db,
        });
        expect(skipped.skipped).toBe(true);
        await writeFile(
          join(campaign, "players.json"),
          JSON.stringify({
            players: [
              {
                id: "pl_a",
                display_name: "Alice Updated",
                is_dm: false,
                discord: { username: "alice", craig_track_hints: [] },
                roll20: { player_ids: [] },
                characters: [{ id: "ch_hero", name: "Hero" }],
              },
            ],
          }),
        );
        const registryChanged = await runPersonaStage({
          session,
          campaignRoot: campaign,
          profiles: { pl_a: [{ character_id: "ch_hero", similarity: 0.9 }] },
          db,
        });
        expect(registryChanged.skipped).toBe(false);
        const configChanged = await runPersonaStage({
          session,
          campaignRoot: campaign,
          config: { ...config, version: "persona-test", weights: { ...config.weights } },
          profiles: { pl_a: [{ character_id: "ch_hero", similarity: 0.9 }] },
          db,
        });
        expect(configChanged.skipped).toBe(false);
        const profileBaseline = await runPersonaStage({
          session,
          campaignRoot: campaign,
          profiles: { pl_a: [{ character_id: "ch_hero", similarity: 0.9 }] },
          db,
        });
        expect(profileBaseline.skipped).toBe(false);
        const profileChanged = await runPersonaStage({
          session,
          campaignRoot: campaign,
          profiles: { pl_a: [{ character_id: "ch_hero", similarity: 0.95 }] },
          db,
        });
        expect(profileChanged.skipped).toBe(false);
      } finally {
        closeDb(db);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
