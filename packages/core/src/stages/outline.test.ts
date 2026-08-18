import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readArtifact, resolveSession, writeArtifact } from "../session/session.js";
import { runOutlineStage } from "./outline.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".p3-01-outline-"));
  roots.push(root);
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(
    join(root, "session.json"),
    JSON.stringify({
      id: "2026-01-01-outline",
      title: "Outline",
      number: null,
      date: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
    }),
  );
  const campaignRoot = join(root, "campaign");
  mkdirSync(campaignRoot, { recursive: true });
  writeFileSync(
    join(campaignRoot, "campaign.json"),
    JSON.stringify({ name: "Test", system: "D&D 5e", timezone: "UTC", session_prefix: "s" }),
  );
  writeFileSync(
    join(campaignRoot, "players.json"),
    JSON.stringify({
      players: [
        {
          id: "pl_1",
          display_name: "Alice",
          is_dm: false,
          discord: { username: "alice", craig_track_hints: [] },
          roll20: { player_ids: [] },
          characters: [{ id: "ch_hero", name: "Hero" }],
        },
      ],
    }),
  );
  writeFileSync(join(campaignRoot, "npcs.json"), JSON.stringify({ npcs: [] }));
  const session = (await resolveSession(root, root))!;
  await writeArtifact(session, "transcript", {
    utterances: [
      {
        id: "u_1",
        track_id: "t_1",
        player_id: "pl_1",
        start_s: 0,
        end_s: 1,
        text: "Attack",
        words: [],
        overlap_ids: [],
        bleed_of: null,
        is_backchannel: false,
      },
    ],
  });
  await writeArtifact(session, "attribution", {
    attributions: [
      {
        utterance_id: "u_1",
        mode: "in_character",
        character_id: "ch_hero",
        confidence: 1,
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
      narration: 0,
      uncertain: 0,
      unknown_character: 0,
    },
  });
  await writeArtifact(session, "timeline", {
    rolls: [
      {
        id: "r_1",
        seq: 1,
        who: "Alice",
        player_id: "pl_1",
        formula: "1d20",
        dice: [],
        modifiers: 0,
        total: 18,
        kind: "attack",
        advantage: "none",
      },
    ],
    anchors: [
      {
        roll_id: "r_1",
        t_audio_s: 0.5,
        t_uncertainty_s: 0.1,
        anchor: "matched",
        matched_utterance_id: "u_1",
      },
    ],
    turnorder: [],
    quality: {
      anchored_fraction: 1,
      median_residual_s: 0,
      largest_unanchored_gap_s: 0,
      clock_drift_s: 0,
    },
  });
  return { session, campaignRoot };
}

describe("outline stage", () => {
  it("writes a schema-valid artifact and skips, force-reruns, and invalidates deterministically", async () => {
    const { session, campaignRoot } = await fixture();
    const first = await runOutlineStage({ session, campaignRoot });
    expect(first.skipped).toBe(false);
    expect((await readArtifact(session, "events")).events[0]?.id).toBe("e_session_start");
    expect((await runOutlineStage({ session, campaignRoot })).skipped).toBe(true);
    expect((await runOutlineStage({ session, campaignRoot, force: true })).skipped).toBe(false);
    const transcriptPath = session.paths.artifact("transcript");
    const changed = JSON.parse(readFileSync(transcriptPath, "utf8")) as {
      utterances: Array<{ text: string }>;
    };
    changed.utterances[0]!.text = "Changed attack";
    writeFileSync(transcriptPath, JSON.stringify(changed));
    expect((await runOutlineStage({ session, campaignRoot })).skipped).toBe(false);
  });
});
