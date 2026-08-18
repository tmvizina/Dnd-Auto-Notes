import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeArtifact, resolveSession } from "@dnd/core";
import { labelSession, type LabelFileIo } from "./label.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".p2-12-label-"));
  roots.push(root);
  const campaign = join(root, "campaign");
  mkdirSync(campaign, { recursive: true });
  writeFileSync(
    join(root, "session.json"),
    JSON.stringify({
      id: "2026-01-01-label",
      title: "Label",
      number: null,
      date: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
    }),
  );
  writeFileSync(
    join(campaign, "campaign.json"),
    JSON.stringify({ name: "Test", system: "D&D 5e", timezone: "UTC", session_prefix: "s" }),
  );
  writeFileSync(join(campaign, "players.json"), JSON.stringify({ players: [] }));
  writeFileSync(join(campaign, "npcs.json"), JSON.stringify({ npcs: [] }));
  const session = (await resolveSession(root, root))!;
  await writeArtifact(session, "transcript", {
    utterances: [
      {
        id: "u_1",
        track_id: "t_1",
        player_id: "pl_a",
        start_s: 0,
        end_s: 1,
        text: "hello",
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
        mode: "uncertain",
        character_id: null,
        confidence: 0.25,
        evidence: { score_ic: 0.25 },
        flags: [],
        children: [],
        source: "deterministic",
        overridden_from: null,
      },
    ],
    summary: {
      in_character: 0,
      out_of_character: 0,
      narration: 0,
      uncertain: 1,
      unknown_character: 0,
    },
  });
  await writeArtifact(session, "features", {
    embedding: { backend: "fake", dimension: 2, normalised: true, blob: "features.bin" },
    min_duration_s: 0.1,
    rows: [
      {
        utterance_id: "u_1",
        player_id: "pl_a",
        offset: 0,
        prosody: {
          f0_mean: 1,
          f0_std: 1,
          f0_range: 1,
          rate_wps: 1,
          intensity_mean: 1,
          intensity_std: 1,
          spectral_tilt: 1,
          jitter_proxy: 1,
          pause_ratio: 1,
        },
        prosody_z: {
          f0_mean: 0,
          f0_std: 0,
          f0_range: 0,
          rate_wps: 0,
          intensity_mean: 0,
          intensity_std: 0,
          spectral_tilt: 0,
          jitter_proxy: 0,
          pause_ratio: 0,
        },
      },
    ],
  });
  const blob = new ArrayBuffer(8);
  new DataView(blob).setFloat32(0, 1, true);
  new DataView(blob).setFloat32(4, 0, true);
  writeFileSync(join(root, "work", "03-features", "features.bin"), Buffer.from(blob));
  return { root, campaign, session };
}

describe("label command", () => {
  it("records attribution evidence, embedding, ownership, and skips existing labels", async () => {
    const { campaign, session } = await fixture();
    const choose = async (item: {
      features: Readonly<Record<string, number>>;
      embedding?: readonly number[];
      clip: { path: string; start_s: number; end_s: number };
    }) => {
      expect(item.features["evidence.score_ic"]).toBe(0.25);
      expect(item.features["prosody_z.rate_wps"]).toBe(0);
      expect(item.embedding).toEqual([1, 0]);
      expect(item.clip.path).toContain("clips");
      expect(item.clip.start_s).toBe(0);
      expect(item.clip.end_s).toBe(1);
      return { mode: "in_character" as const, character_id: "ch_hero" };
    };
    let played = 0;
    const first = await labelSession({
      session,
      campaignRoot: campaign,
      limit: 1,
      now: () => "2026-01-01T00:00:00Z",
      choose,
      play: async (clip) => {
        played += 1;
        expect(clip.end_s).toBe(1);
      },
    });
    expect(first.selected).toBe(1);
    expect(played).toBe(1);
    const line = JSON.parse(readFileSync(first.path, "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({
      utterance_id: "u_1",
      player_id: "pl_a",
      session_id: session.descriptor.id,
      character_id: "ch_hero",
    });
    const second = await labelSession({
      session,
      campaignRoot: campaign,
      limit: 1,
      choose: async () => ({ mode: "narration", character_id: null }),
    });
    expect(second.selected).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("appends fifty labels and skips all fifty on the rerun", async () => {
    const { campaign, session } = await fixture();
    await writeArtifact(session, "transcript", {
      utterances: Array.from({ length: 50 }, (_, index) => ({
        id: `u_${String(index)}`,
        track_id: "t_1",
        player_id: "pl_a",
        start_s: index,
        end_s: index + 0.5,
        text: `line ${String(index)}`,
        words: [],
        overlap_ids: [],
        bleed_of: null,
        is_backchannel: false,
      })),
    });
    let prompted = 0;
    const choose = async () => {
      prompted += 1;
      return { mode: "uncertain" as const, character_id: null };
    };
    const first = await labelSession({ session, campaignRoot: campaign, limit: 50, choose });
    expect(first.selected).toBe(50);
    expect(prompted).toBe(50);
    const second = await labelSession({ session, campaignRoot: campaign, limit: 50, choose });
    expect(second.selected).toBe(0);
    expect(second.skipped).toBe(50);
    expect(prompted).toBe(50);
  });

  it("rolls back both label files when the second publication fails", async () => {
    const { campaign, session } = await fixture();
    const files = new Map<string, string>();
    let appends = 0;
    const io: LabelFileIo = {
      appendFile: async (path, data) => {
        appends += 1;
        if (appends === 2) throw new Error("injected publication failure");
        files.set(path, `${files.get(path) ?? ""}${data}`);
      },
      readFile: async (path) => {
        const value = files.get(path);
        if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return value;
      },
      writeFile: async (path, data) => void files.set(path, data),
      mkdir: async () => undefined,
      rm: async (path) => void files.delete(path),
    };
    await expect(
      labelSession({
        session,
        campaignRoot: campaign,
        limit: 1,
        choose: async () => ({ mode: "uncertain", character_id: null }),
        io,
      }),
    ).rejects.toThrow("injected publication failure");
    expect(files.size).toBe(0);
  });

  it("leaves a durable receipt when rollback fails and consumes it on retry", async () => {
    const { campaign, session } = await fixture();
    const sessionPath = join(campaign, "labels", `${session.descriptor.id}.jsonl`);
    const allPath = join(campaign, "labels", "all.jsonl");
    const receiptPath = join(campaign, "labels", ".label-publication-receipt.json");
    const files = new Map<string, string>([
      [sessionPath, "old-session\n"],
      [allPath, "old-all\n"],
    ]);
    let appends = 0;
    let failPublication = true;
    let failRestore = true;
    const io: LabelFileIo = {
      appendFile: async (path, data) => {
        appends += 1;
        if (failPublication && appends === 2) throw new Error("injected publication failure");
        files.set(path, `${files.get(path) ?? ""}${data}`);
      },
      readFile: async (path) => {
        const value = files.get(path);
        if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return value;
      },
      writeFile: async (path, data) => {
        if (failRestore && (path === sessionPath || path === allPath))
          throw new Error("injected rollback failure");
        files.set(path, data);
      },
      mkdir: async () => undefined,
      rm: async (path) => void files.delete(path),
    };
    await expect(
      labelSession({
        session,
        campaignRoot: campaign,
        limit: 1,
        choose: async () => ({ mode: "uncertain", character_id: null }),
        io,
      }),
    ).rejects.toThrow("rollback failed");
    expect(files.has(receiptPath)).toBe(true);
    failRestore = false;
    failPublication = false;
    appends = 0;
    await labelSession({
      session,
      campaignRoot: campaign,
      limit: 1,
      choose: async () => ({ mode: "uncertain", character_id: null }),
      io,
    });
    expect(files.has(receiptPath)).toBe(false);
    expect(files.get(sessionPath)).toContain("old-session");
    expect(files.get(allPath)).toContain("old-all");
  });
});
