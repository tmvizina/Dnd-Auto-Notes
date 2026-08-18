import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACTS } from "../contracts/artifacts.js";
import { ARTIFACT_NAMES, CORRUPTED, MINIMAL } from "../testing/fixtures.js";
import { nodeIo, writeFileAtomic } from "./io.js";
import type { FileIo } from "./io.js";
import {
  ArtifactError,
  createSession,
  readArtifact,
  resolveSession,
  sessionIdFrom,
  writeArtifact,
} from "./session.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dnd-session-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("session lifecycle", () => {
  it("creates a session and resolves it back by id", async () => {
    const created = await createSession(root, { title: "Ambush at the Ford", date: "2026-08-16" });
    expect(created.descriptor.id).toBe("2026-08-16-ambush-at-the-ford");

    const resolved = await resolveSession(root, created.descriptor.id);
    expect(resolved?.descriptor).toEqual(created.descriptor);
  });

  it("resolves by absolute path and by `latest`", async () => {
    await createSession(root, { title: "First", date: "2026-01-01" });
    const second = await createSession(root, { title: "Second", date: "2026-02-02" });

    expect((await resolveSession(root, second.paths.root))?.descriptor.id).toBe(
      second.descriptor.id,
    );
    expect((await resolveSession(root, "latest"))?.descriptor.id).toBe(second.descriptor.id);
  });

  it("returns null for an unknown session rather than throwing", async () => {
    expect(await resolveSession(root, "no-such-session")).toBeNull();
    expect(await resolveSession(root, "latest")).toBeNull();
  });

  it("builds ids that are safe as directory names", () => {
    expect(sessionIdFrom("2026-08-16", "Séance / Round #2: the Ford!")).toBe(
      "2026-08-16-seance-round-2-the-ford",
    );
    expect(sessionIdFrom("2026-08-16", "***")).toBe("2026-08-16-session");
  });
});

describe("artifact round-trip", () => {
  it.each(ARTIFACT_NAMES)("writes and reads %s through its contract", async (name) => {
    const session = await createSession(root, { title: "T", date: "2026-08-16" });
    const written = await writeArtifact(session, name, MINIMAL[name]);
    const read = await readArtifact(session, name);
    expect(read).toEqual(written);
  });

  it.each(ARTIFACT_NAMES)(
    "rejects a corrupted %s with a message naming the field",
    async (name) => {
      const session = await createSession(root, { title: "T", date: "2026-08-16" });
      await expect(writeArtifact(session, name, CORRUPTED[name])).rejects.toBeInstanceOf(
        ArtifactError,
      );
      await expect(writeArtifact(session, name, CORRUPTED[name])).rejects.toThrow(
        /refusing to write artifact/,
      );
    },
  );

  it("refuses to write an invalid artifact at all — nothing reaches disk", async () => {
    const session = await createSession(root, { title: "T", date: "2026-08-16" });
    await expect(writeArtifact(session, "manifest", CORRUPTED.manifest)).rejects.toThrow();
    expect(() => readFileSync(session.paths.artifact("manifest"))).toThrow();
  });

  it("reports a missing artifact distinctly from an invalid one", async () => {
    const session = await createSession(root, { title: "T", date: "2026-08-16" });
    await expect(readArtifact(session, "transcript")).rejects.toThrow(/has not been written yet/);

    mkdirSync(dirname(session.paths.artifact("transcript")), { recursive: true });
    writeFileSync(session.paths.artifact("transcript"), "{ not json");
    await expect(readArtifact(session, "transcript")).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an artifact mutated on disk after it was written", async () => {
    const session = await createSession(root, { title: "T", date: "2026-08-16" });
    await writeArtifact(session, "timeline", MINIMAL.timeline);

    const path = session.paths.artifact("timeline");
    const mutated = JSON.parse(readFileSync(path, "utf8")) as {
      quality: { anchored_fraction: number };
    };
    mutated.quality.anchored_fraction = 99;
    writeFileSync(path, JSON.stringify(mutated));

    await expect(readArtifact(session, "timeline")).rejects.toThrow(/does not match its contract/);
  });
});

describe("atomic writes", () => {
  it("leaves the previous file intact when the write fails", async () => {
    const target = join(root, "artifact.json");
    await writeFileAtomic(target, '{"generation":1}\n');

    const failing: FileIo = {
      ...nodeIo,
      writeFile: async () => {
        throw new Error("disk full");
      },
    };
    await expect(writeFileAtomic(target, '{"generation":2}\n', failing)).rejects.toThrow(
      "disk full",
    );

    expect(readFileSync(target, "utf8")).toBe('{"generation":1}\n');
  });

  it("never leaves a truncated file at the target path when rename fails", async () => {
    const target = join(root, "artifact.json");
    await writeFileAtomic(target, '{"generation":1}\n');

    const failing: FileIo = {
      ...nodeIo,
      rename: async () => {
        throw new Error("interrupted");
      },
    };
    await expect(writeFileAtomic(target, "PARTIAL", failing)).rejects.toThrow("interrupted");

    // Old content survives, and the temp file is cleaned up rather than left
    // behind to be mistaken for an artifact.
    expect(readFileSync(target, "utf8")).toBe('{"generation":1}\n');
    expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("writes through a temp file rather than in place", async () => {
    const target = join(root, "nested", "deep", "artifact.json");
    const seen: string[] = [];
    const spy: FileIo = {
      ...nodeIo,
      writeFile: async (path, data, encoding) => {
        seen.push(path);
        await nodeIo.writeFile(path, data, encoding);
      },
    };
    await writeFileAtomic(target, "{}\n", spy);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(target);
    expect(dirname(seen[0] ?? "")).toBe(dirname(target));
    expect(readFileSync(target, "utf8")).toBe("{}\n");
  });
});

describe("artifact paths", () => {
  it("puts every artifact where the data contract says", async () => {
    const session = await createSession(root, { title: "T", date: "2026-08-16" });
    expect(session.paths.artifact("transcript")).toBe(
      join(session.paths.root, ARTIFACTS.transcript),
    );
    expect(session.paths.stageMeta("transcript")).toBe(
      join(session.paths.root, "work", "02-transcript", "_stage.json"),
    );
  });
});
