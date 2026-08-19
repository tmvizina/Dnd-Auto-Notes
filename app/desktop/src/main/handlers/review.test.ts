import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReviewHandlers } from "./review.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("review handlers", () => {
  it("lists impact-sorted flags and transactionally appends a resolution label", async () => {
    const root = await mkdtemp(join(process.cwd(), ".p4-08-review-"));
    roots.push(root);
    const sessions = join(root, "sessions");
    const campaign = join(root, "campaign");
    await mkdir(join(sessions, "s1", "work", "05-persona"), { recursive: true });
    await writeFile(
      join(sessions, "s1", "work", "05-persona", "attribution.json"),
      JSON.stringify({
        attributions: [
          {
            utterance_id: "u1",
            mode: "uncertain",
            character_id: null,
            confidence: 0.2,
            flags: [{ code: "uncertain", reason: "low" }],
          },
          {
            utterance_id: "u2",
            mode: "uncertain",
            character_id: null,
            confidence: 0.8,
            flags: [{ code: "uncertain", reason: "high" }],
          },
        ],
      }),
    );
    const handlers = createReviewHandlers({ sessionsRoot: sessions, campaignRoot: campaign });
    const listed = await handlers.reviewList({ sessionId: "s1" });
    expect(listed.flags.map((flag) => flag.utteranceId)).toEqual(["u1", "u2"]);
    await expect(
      handlers.reviewResolve({
        sessionId: "s1",
        utteranceId: "u1",
        action: "candidate",
        label: "in_character",
        characterId: "npc-1",
      }),
    ).resolves.toMatchObject({ saved: true });
    expect(await readFile(join(campaign, "labels", "s1.jsonl"), "utf8")).toContain(
      '"utterance_id":"u1"',
    );
    expect((await handlers.reviewList({ sessionId: "s1" })).flags).toHaveLength(1);
  });

  it("delegates journaled profile changes, bulk clusters, and rerun", async () => {
    const root = await mkdtemp(join(process.cwd(), ".p4-08-review-"));
    roots.push(root);
    const sessions = join(root, "sessions");
    await mkdir(join(sessions, "s1", "work", "05-persona"), { recursive: true });
    await writeFile(
      join(sessions, "s1", "work", "05-persona", "attribution.json"),
      JSON.stringify({
        attributions: [
          {
            utterance_id: "u1",
            mode: "uncertain",
            character_id: null,
            cluster_id: "c1",
            flags: [{ code: "uncertain", reason: "low" }],
          },
          {
            utterance_id: "u2",
            mode: "uncertain",
            character_id: null,
            cluster_id: "c1",
            flags: [{ code: "uncertain", reason: "low" }],
          },
        ],
      }),
    );
    const updateProfile = async (): Promise<string> => "j1";
    const rerun = async (): Promise<string> => "run1";
    const handlers = createReviewHandlers({
      sessionsRoot: sessions,
      campaignRoot: join(root, "campaign"),
      updateProfile,
      rerun,
    });
    await expect(
      handlers.reviewResolve({
        sessionId: "s1",
        utteranceId: "u1",
        action: "character",
        characterId: "npc",
      }),
    ).resolves.toMatchObject({ journalId: "j1", rerunSuggested: true });
    await expect(
      handlers.reviewBulk({ sessionId: "s1", clusterId: "c1", action: "out_of_character" }),
    ).resolves.toMatchObject({ count: 2 });
    await expect(handlers.reviewRerun({ sessionId: "s1", utteranceIds: ["u1"] })).resolves.toEqual({
      runId: "run1",
    });
  });

  it("rolls back every member when a bulk resolution fails mid-cluster", async () => {
    const root = await mkdtemp(join(process.cwd(), ".p4-08-review-"));
    roots.push(root);
    const sessions = join(root, "sessions");
    const artifactDir = join(sessions, "s1", "work", "05-persona");
    await mkdir(artifactDir, { recursive: true });
    const original = {
      attributions: [
        {
          utterance_id: "u1",
          mode: "uncertain",
          character_id: null,
          cluster_id: "c1",
          flags: [{ code: "uncertain", reason: "x" }],
        },
        {
          utterance_id: "u2",
          mode: "uncertain",
          character_id: null,
          cluster_id: "c1",
          flags: [{ code: "uncertain", reason: "x" }],
        },
      ],
    };
    const artifact = join(artifactDir, "attribution.json");
    await writeFile(artifact, JSON.stringify(original));
    let calls = 0;
    const handlers = createReviewHandlers({
      sessionsRoot: sessions,
      campaignRoot: join(root, "campaign"),
      updateProfile: async () => {
        calls += 1;
        if (calls === 2) throw new Error("injected bulk failure");
        return "journal-1";
      },
    });
    await expect(
      handlers.reviewBulk({
        sessionId: "s1",
        clusterId: "c1",
        action: "character",
        characterId: "npc",
      }),
    ).rejects.toThrow("injected bulk failure");
    expect(JSON.parse(await readFile(artifact, "utf8"))).toEqual(original);
  });

  it("recovers a profile journal when the receipt was written before its id", async () => {
    const root = await mkdtemp(join(process.cwd(), ".p4-08-review-"));
    roots.push(root);
    const sessions = join(root, "sessions");
    const artifactDir = join(sessions, "s1", "work", "05-persona");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "attribution.json"), JSON.stringify({ attributions: [] }));
    await writeFile(
      join(artifactDir, "attribution.json.u1.review-receipt.json"),
      JSON.stringify({
        previousArtifact: JSON.stringify({ attributions: [] }),
        previousLabels: "",
        utteranceId: "u1",
      }),
    );
    const reverted: string[] = [];
    const handlers = createReviewHandlers({
      sessionsRoot: sessions,
      campaignRoot: join(root, "campaign"),
      findProfileJournal: async () => "journal-1",
      revertProfile: async (_session, journal) => {
        reverted.push(journal);
      },
    });
    await handlers.reviewList({ sessionId: "s1" });
    expect(reverted).toEqual(["journal-1"]);
  });

  it("retains a bulk receipt when rollback cannot complete", async () => {
    const root = await mkdtemp(join(process.cwd(), ".p4-08-review-"));
    roots.push(root);
    const sessions = join(root, "sessions");
    const artifactDir = join(sessions, "s1", "work", "05-persona");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "attribution.json"), JSON.stringify({ attributions: [] }));
    const receipt = join(artifactDir, "attribution.json.c1.bulk-review-receipt.json");
    await writeFile(
      receipt,
      JSON.stringify({
        previousArtifact: JSON.stringify({ attributions: [] }),
        previousLabels: "",
        journalIds: ["j1"],
      }),
    );
    const handlers = createReviewHandlers({
      sessionsRoot: sessions,
      campaignRoot: join(root, "campaign"),
      revertProfile: async () => {
        throw new Error("revert unavailable");
      },
    });
    await handlers.reviewList({ sessionId: "s1" });
    expect(await readFile(receipt, "utf8")).toContain("j1");
  });

  it("evicts custom-extractor clips through injected disk I/O", async () => {
    const root = await mkdtemp(join(process.cwd(), ".p4-08-review-"));
    roots.push(root);
    const removed: string[] = [];
    const handlers = createReviewHandlers({
      sessionsRoot: join(root, "sessions"),
      campaignRoot: join(root, "campaign"),
      maxCachedClips: 2,
      io: {
        readFile: async () => "",
        writeFile: async () => undefined,
        rename: async () => undefined,
        mkdir: async () => undefined,
        unlink: async (path) => {
          removed.push(path);
        },
      },
      extractClip: async (_session, utterance) =>
        join(root, "sessions", "s1", "media", "clips", `${utterance}.wav`),
    });
    await handlers.reviewClip({ sessionId: "s1", utteranceId: "u1" });
    await handlers.reviewClip({ sessionId: "s1", utteranceId: "u2" });
    await handlers.reviewClip({ sessionId: "s1", utteranceId: "u3" });
    expect(removed).toEqual([join(root, "sessions", "s1", "media", "clips", "u1.wav")]);
  });
});
