import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clusterVoiceModes,
  coldStart,
  identifyTableVoice,
  matchClusterToProfiles,
} from "./voiceModes.js";

type Fixture = {
  generator: string;
  args: { seed: number; default_duration_s: number };
  embedding_dimension: number;
  embedding_backend: string;
  truth_sha256: string;
  rows: Array<{
    id: string;
    player_id: string;
    mode: string;
    character_id: string | null;
    embedding: number[];
    prosody_z: Record<string, number>;
  }>;
};
const load = (seed: number): Fixture =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), `packages/core/src/persona/fixtures/session-${seed}.json`),
      "utf8",
    ),
  ) as Fixture;
const samples = (fixture: Fixture) =>
  fixture.rows.map((row) => ({
    utterance_id: row.id,
    player_id: row.player_id,
    embedding: row.embedding,
    prosody: row.prosody_z,
    duration_s: 1,
    ooc_score: row.mode === "out_of_character" ? 1 : 0,
    roll_proximity: 0,
  }));
const truthLabel = (row: Fixture["rows"][number]) =>
  row.mode === "out_of_character" || row.character_id === null ? "table" : row.character_id;
function purity(clusters: ReturnType<typeof clusterVoiceModes>, fixture: Fixture): number {
  return (
    clusters.reduce((sum, cluster) => {
      const counts = new Map<string, number>();
      for (const id of cluster.utterance_ids) {
        const row = fixture.rows.find((item) => item.id === id)!;
        const label = truthLabel(row);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return sum + Math.max(...counts.values()) / cluster.utterance_ids.length;
    }, 0) / clusters.length
  );
}

describe("persona voice modes", () => {
  it("verifies real P2-04 provenance and vector dimensions", () => {
    const temporaryRoot = mkdtempSync(join(process.cwd(), ".p2-05-provenance-"));
    try {
      for (const seed of [501, 502]) {
        const fixture = load(seed);
        const generatedRoot = join(temporaryRoot, String(seed));
        expect(fixture.generator).toBe("tools/generate-fixture.mjs");
        expect(fixture.args).toEqual({ seed, default_duration_s: 60 });
        execFileSync(
          process.execPath,
          [fixture.generator, "--out", generatedRoot, "--seed", String(seed)],
          { cwd: process.cwd(), stdio: "ignore" },
        );
        const truthBytes = readFileSync(join(generatedRoot, "truth.json"));
        expect(createHash("sha256").update(truthBytes).digest("hex")).toBe(fixture.truth_sha256);
        expect(fixture.embedding_backend).toBe("DND_FAKE_EMBED");
        expect(fixture.embedding_dimension).toBe(16);
        expect(
          fixture.rows.every((row) => row.embedding.length === fixture.embedding_dimension),
        ).toBe(true);
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
  it("computes the recorded threshold and representation sweep", () => {
    const fixture = load(501);
    const options = [0.18, 0.22, 0.28, 0.34];
    const weights = [0.2, 0.35, 0.5];
    const measured = ["embedding", "prosody", "concatenated"].map((representation) => {
      let best = { purity: -1, threshold: 0, weight: 0 };
      for (const threshold of options)
        for (const weight of weights) {
          const value = purity(
            clusterVoiceModes(samples(fixture), {
              representation:
                representation === "concatenated"
                  ? "concatenated"
                  : (representation as "embedding" | "prosody"),
              threshold,
              prosodyWeight: weight,
            }),
            fixture,
          );
          if (value > best.purity) best = { purity: value, threshold, weight };
        }
      return best;
    });
    expect(measured[0]).toEqual({ purity: 1, threshold: 0.18, weight: 0.2 });
    expect(measured[1]).toEqual({ purity: 1, threshold: 0.18, weight: 0.2 });
    expect(measured[2]).toEqual({ purity: 1, threshold: 0.18, weight: 0.2 });
  });
  it("clusters the first session and matches the second session", () => {
    const firstFixture = load(501);
    const secondFixture = load(502);
    const first = clusterVoiceModes(samples(firstFixture), {
      representation: "embedding",
      threshold: 0.18,
    });
    const second = clusterVoiceModes(samples(secondFixture), {
      representation: "embedding",
      threshold: 0.18,
    });
    expect(first.length).toBeGreaterThan(0);
    const profileLabel = (cluster: (typeof first)[number], fixture: Fixture) => {
      const labels = cluster.utterance_ids.map((id) =>
        truthLabel(fixture.rows.find((row) => row.id === id)!),
      );
      return labels.sort(
        (a, b) => labels.filter((x) => x === b).length - labels.filter((x) => x === a).length,
      )[0]!;
    };
    const profiles = first.map((item) => ({
      profile_id: profileLabel(item, firstFixture),
      centroid: item.centroid,
    }));
    const correct = second.filter((cluster) => {
      const candidate = matchClusterToProfiles(cluster, profiles)[0];
      return candidate?.labelled && candidate.profile_id === profileLabel(cluster, secondFixture);
    }).length;
    expect(correct / second.length).toBe(1);
    expect(first.filter((cluster) => cluster.player_id === "pl_ash").length).toBeGreaterThanOrEqual(
      1,
    );
    for (const player of new Set(firstFixture.rows.map((row) => row.player_id))) {
      const expected = new Set(
        firstFixture.rows.filter((row) => row.player_id === player).map(truthLabel),
      ).size;
      const actual = first.filter((cluster) => cluster.player_id === player).length;
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
    }
    expect(identifyTableVoice(first)).not.toBeNull();
  });
  it("rejects ambiguous matches and reports cold start", () => {
    const cluster = clusterVoiceModes([samples(load(501))[0]!], {
      representation: "embedding",
    })[0]!;
    const candidates = matchClusterToProfiles(cluster, [
      { profile_id: "a", centroid: cluster.centroid },
      { profile_id: "b", centroid: cluster.centroid },
    ]);
    expect(candidates[0]?.labelled).toBe(false);
    const cold = coldStart([cluster]);
    expect(cold.matches[0]?.labelled).toBe(false);
    expect(cold.qa.code).toBe("PERSONA_COLD_START");
  });
});
