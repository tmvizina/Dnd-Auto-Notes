import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readArtifact, resolveSession } from "../session/session.js";
import { readFeatureEmbedding, runFeaturesStage } from "./features.js";
import type { FeaturesSidecar } from "./features.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".p2-04-features-"));
  roots.push(root);
  writeFileSync(
    join(root, "session.json"),
    JSON.stringify({
      id: "2026-01-01-features",
      title: "Features",
      number: null,
      date: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
    }),
  );
  writeFileSync(join(root, "track.wav"), "synthetic");
  const track = {
    track_id: "tr_a",
    path: "track.wav",
    player_id: "pl_a",
    match: "manual",
    sha256: "a".repeat(64),
    duration_s: 2,
    sample_rate: 16000,
    channels: 1,
    speech_ratio: 1,
    aligned: true,
  };
  const base = join(root, "work", "01-intake");
  const transcriptDir = join(root, "work", "02-transcript");
  mkdirSync(base, { recursive: true });
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(base, "manifest.json"),
    JSON.stringify({
      session_id: "2026-01-01-features",
      recording: { started_at: null, duration_s: 2, source: "craig", track_count: 1 },
      tracks: [track],
      rolls: [],
      roll20: null,
      qa: [],
    }),
  );
  const utterances = [
    {
      id: "u1",
      track_id: "tr_a",
      player_id: "pl_a",
      start_s: 0,
      end_s: 1,
      text: "one",
      words: [],
      overlap_ids: [],
      bleed_of: null,
      is_backchannel: false,
    },
    {
      id: "u2",
      track_id: "tr_a",
      player_id: "pl_a",
      start_s: 1,
      end_s: 1.2,
      text: "short",
      words: [],
      overlap_ids: [],
      bleed_of: null,
      is_backchannel: false,
    },
  ];
  writeFileSync(join(transcriptDir, "utterances.json"), JSON.stringify({ utterances }));
  return (await resolveSession(root, root))!;
}

const vector = (seed: number) => Array.from({ length: 3 }, (_, index) => seed + index + 0.25);
const prosody = (seed: number) => ({
  f0_mean: seed,
  f0_std: 1,
  f0_range: 2,
  rate_wps: 3,
  intensity_mean: 4,
  intensity_std: 5,
  spectral_tilt: 6,
  jitter_proxy: 7,
  pause_ratio: 8,
});

describe("features stage", () => {
  it("writes deterministic float32 offsets and round-trips the binary index", async () => {
    const session = await fixture();
    const sidecar = {
      runJob: async () => ({
        backend: "fake",
        dimension: 3,
        rows: [
          { utterance_id: "u1", player_id: "pl_a", embedding: vector(1), prosody: prosody(1) },
          { utterance_id: "u2", player_id: "pl_a", embedding: null, prosody: null },
        ],
      }),
    } as FeaturesSidecar;
    const result = await runFeaturesStage({ session, sidecar, minDurationS: 0.6, force: true });
    expect(result.value?.rows[0]?.offset).toBe(0);
    expect(result.value?.rows[1]?.offset).toBeNull();
    const norm = Math.sqrt(1.25 ** 2 + 2.25 ** 2 + 3.25 ** 2);
    const blob = (await readArtifact(session, "features")).embedding.blob;
    expect(
      await readFeatureEmbedding(join(session.paths.root, "work", "03-features", blob), 0, 3),
    ).toEqual([Math.fround(1.25 / norm), Math.fround(2.25 / norm), Math.fround(3.25 / norm)]);
    const bytes = readFileSync(join(session.paths.root, "work", "03-features", blob));
    await runFeaturesStage({ session, sidecar, minDurationS: 0.6, force: true });
    expect(
      readFileSync(
        join(
          session.paths.root,
          "work",
          "03-features",
          (await readArtifact(session, "features")).embedding.blob,
        ),
      ),
    ).toEqual(bytes);
    expect((await readArtifact(session, "features")).rows[0]?.prosody_z?.jitter_proxy).toBe(0);
  });

  it("skips unchanged work and force reruns; custom IO receives binary atomically", async () => {
    const session = await fixture();
    let calls = 0;
    const sidecar = {
      runJob: async () => {
        calls += 1;
        return {
          backend: "fake",
          dimension: 3,
          rows: [
            { utterance_id: "u1", player_id: "pl_a", embedding: vector(1), prosody: prosody(1) },
            { utterance_id: "u2", player_id: "pl_a", embedding: null, prosody: null },
          ],
        };
      },
    } as FeaturesSidecar;
    const first = await runFeaturesStage({ session, sidecar });
    expect(first.skipped).toBe(false);
    expect((await runFeaturesStage({ session, sidecar })).skipped).toBe(true);
    expect(calls).toBe(1);
    expect((await runFeaturesStage({ session, sidecar, force: true })).skipped).toBe(false);
    expect(calls).toBe(2);
    const writes: unknown[] = [];
    const io = {
      mkdir: async () => undefined,
      writeFile: async (_path: string, data: string | Uint8Array) => {
        writes.push(data);
      },
      rename: async () => undefined,
      rm: async () => undefined,
    };
    await runFeaturesStage({ session, sidecar, force: true, io });
    expect(writes.some((value) => value instanceof Uint8Array)).toBe(true);
  });

  it("keeps the old JSON/blob pair valid until the new JSON is published", async () => {
    const session = await fixture();
    const oldSidecar = {
      runJob: async () => ({
        backend: "fake",
        dimension: 3,
        rows: [
          { utterance_id: "u1", player_id: "pl_a", embedding: vector(1), prosody: prosody(1) },
          { utterance_id: "u2", player_id: "pl_a", embedding: null, prosody: null },
        ],
      }),
    } as FeaturesSidecar;
    await runFeaturesStage({ session, sidecar: oldSidecar, force: true });
    const oldArtifact = await readArtifact(session, "features");
    const oldBlobPath = join(session.paths.root, "work", "03-features", oldArtifact.embedding.blob);
    const oldBytes = readFileSync(oldBlobPath);
    let observedOldPair = false;
    const newSidecar = {
      runJob: async () => ({
        backend: "fake",
        dimension: 3,
        rows: [
          { utterance_id: "u1", player_id: "pl_a", embedding: vector(10), prosody: prosody(2) },
          { utterance_id: "u2", player_id: "pl_a", embedding: null, prosody: null },
        ],
      }),
    } as FeaturesSidecar;
    const io = {
      mkdir: async () => undefined,
      writeFile: async (path: string, data: string | Uint8Array, encoding?: "utf8") => {
        if (typeof data === "string" && path.includes("features.json") && path.includes(".tmp"))
          throw new Error("injected JSON publication failure");
        writeFileSync(path, data, encoding === "utf8" ? "utf8" : undefined);
      },
      rename: async (from: string, to: string) => {
        if (to.endsWith(".bin")) {
          const current = JSON.parse(
            readFileSync(session.paths.artifact("features"), "utf8"),
          ) as typeof oldArtifact;
          expect(current.embedding.blob).toBe(oldArtifact.embedding.blob);
          expect(readFileSync(oldBlobPath)).toEqual(oldBytes);
          observedOldPair = true;
        }
        const { renameSync } = await import("node:fs");
        renameSync(from, to);
      },
      rm: async (path: string) => {
        rmSync(path, { force: true });
      },
    };
    await expect(
      runFeaturesStage({ session, sidecar: newSidecar, force: true, io }),
    ).rejects.toThrow("injected JSON publication failure");
    expect(observedOldPair).toBe(true);
    expect((await readArtifact(session, "features")).embedding.blob).toBe(
      oldArtifact.embedding.blob,
    );
    expect(readFileSync(oldBlobPath)).toEqual(oldBytes);
  });
});
