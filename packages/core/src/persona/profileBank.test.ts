import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readProfiles,
  readTableProfile,
  recoverProfileBank,
  revertProfile,
  updateProfile,
  writeTableProfile,
} from "./profileBank.js";
import type { BankIo } from "./profileBank.js";

const profile = {
  profile_id: "hero",
  centroid: [1, 0],
  spread_radius: 0.1,
  example_utterance_count: 2,
  sessions: ["s1"],
  version: 1,
};
const readFileText = (path: string) => readFileSync(path, "utf8");
describe("voice profile bank", () => {
  it("updates, journals, reverts, and ignores corrupt/temp files", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-05-bank-"));
    try {
      const update = await updateProfile(
        root,
        "p1",
        profile,
        {
          id: "v1",
          player_id: "p1",
          utterance_ids: ["u3"],
          centroid: [0, 1],
          airtime_s: 1,
          table_score: 0,
        },
        "s2",
      );
      writeFileSync(join(root, "p1", "partial.json"), "broken");
      writeFileSync(
        join(root, "p1", "invalid.json"),
        JSON.stringify({ ...profile, example_utterance_count: -1, sessions: [4], version: 1.5 }),
      );
      writeFileSync(join(root, "p1", "journal", "corrupt.json"), "{");
      expect((await readProfiles(root, "p1")).map((item) => item.profile_id)).toEqual(["hero"]);
      expect(update.next.version).toBe(2);
      await revertProfile(root, "p1", update);
      expect((await readProfiles(root, "p1"))[0]?.version).toBe(1);
      await writeTableProfile(root, "p1", profile);
      expect((await readTableProfile(root, "p1"))?.profile_id).toBe("hero");
      rmSync(join(root, "p1"), { recursive: true, force: true });
      expect(await readProfiles(root, "p1")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("requires explicit confirmation before folding a cluster", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-05-bank-confirm-"));
    try {
      const cluster = {
        id: "v1",
        player_id: "p1",
        utterance_ids: ["u1", "u2"],
        centroid: [0, 1],
        airtime_s: 1,
        table_score: 0,
      };
      await expect(updateProfile(root, "p1", profile, cluster, "s2", 0.9, ["u1"])).rejects.toThrow(
        "explicitly confirmed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("recovers an update intent after profile publication failure", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-05-bank-fail-"));
    try {
      let fail = true;
      const io: BankIo = {
        mkdir: async (path) => {
          mkdirSync(path, { recursive: true });
        },
        writeFile: async (path, data) => {
          writeFileSync(path, data, "utf8");
        },
        rename: async (from, to) => {
          if (fail && to.endsWith("hero.json")) throw new Error("profile failure");
          const { renameSync } = await import("node:fs");
          renameSync(from, to);
        },
      };
      const cluster = {
        id: "v1",
        player_id: "p1",
        utterance_ids: ["u1"],
        centroid: [0, 1],
        airtime_s: 1,
        table_score: 0,
      };
      await expect(
        updateProfile(root, "p1", profile, cluster, "s2", 0.9, ["u1"], io),
      ).rejects.toThrow("profile failure");
      writeFileSync(join(root, "p1", "journal", "hero-2.committed.json"), "partial");
      fail = false;
      await recoverProfileBank(root, "p1");
      await recoverProfileBank(root, "p1");
      expect((await readProfiles(root, "p1"))[0]?.version).toBe(2);
      expect((await readFileText(join(root, "p1", "journal", "hero-2.json"))).includes("u1")).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("recovers a revert intent idempotently", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-05-bank-revert-"));
    try {
      const cluster = {
        id: "v1",
        player_id: "p1",
        utterance_ids: ["u1"],
        centroid: [0, 1],
        airtime_s: 1,
        table_score: 0,
      };
      const update = await updateProfile(root, "p1", profile, cluster, "s2");
      let fail = true;
      const io: BankIo = {
        mkdir: async (path) => {
          mkdirSync(path, { recursive: true });
        },
        writeFile: async (path, data) => {
          writeFileSync(path, data, "utf8");
        },
        rename: async (from, to) => {
          if (fail && to.endsWith("hero.json")) throw new Error("revert profile failure");
          const { renameSync } = await import("node:fs");
          renameSync(from, to);
        },
      };
      await expect(revertProfile(root, "p1", update, io)).rejects.toThrow("revert profile failure");
      fail = false;
      await recoverProfileBank(root, "p1");
      await recoverProfileBank(root, "p1");
      expect((await readProfiles(root, "p1"))[0]?.version).toBe(1);
      expect(readFileText(join(root, "p1", "journal", "hero-2.revert.committed.json"))).toContain(
        "confirmed_utterance_ids",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
