import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StageMeta } from "../contracts/stageMeta.js";
import { createSession, readArtifact, writeArtifact } from "../session/session.js";
import type { Session } from "../session/session.js";
import { MINIMAL } from "../testing/fixtures.js";
import { runStage } from "./runner.js";

let root: string;
let session: Session;
let inputPath: string;

/** A stage that records how many times it actually executed. */
function countingStage() {
  const calls = { count: 0 };
  const run = async () => {
    calls.count += 1;
    await writeArtifact(session, "transcript", MINIMAL.transcript);
    return calls.count;
  };
  return { calls, run };
}

const base = () => ({
  session,
  stage: "transcript",
  version: 1,
  output: "transcript" as const,
  inputs: [inputPath],
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dnd-stage-"));
  session = await createSession(root, { title: "Stage", date: "2026-08-16" });
  inputPath = session.paths.input("craig", "info.txt");
  mkdirSync(session.paths.input("craig"), { recursive: true });
  writeFileSync(inputPath, "recording start 00:00:00\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runStage", () => {
  it("runs the first time and skips when nothing has changed", async () => {
    const stage = countingStage();

    const first = await runStage(base(), stage.run);
    expect(first.skipped).toBe(false);
    expect(first.value).toBe(1);

    const mtime = statSync(session.paths.artifact("transcript")).mtimeMs;

    const second = await runStage(base(), stage.run);
    expect(second.skipped).toBe(true);
    expect(second.value).toBeUndefined();
    expect(stage.calls.count).toBe(1);
    // A skip must not rewrite the artifact — that is the whole point.
    expect(statSync(session.paths.artifact("transcript")).mtimeMs).toBe(mtime);
  });

  it("re-runs when a single input byte changes", async () => {
    const stage = countingStage();
    await runStage(base(), stage.run);

    writeFileSync(inputPath, "recording start 00:00:01\n");

    expect((await runStage(base(), stage.run)).skipped).toBe(false);
    expect(stage.calls.count).toBe(2);
  });

  it("re-runs when the stage version is bumped", async () => {
    const stage = countingStage();
    await runStage(base(), stage.run);

    const bumped = await runStage({ ...base(), version: 2 }, stage.run);
    expect(bumped.skipped).toBe(false);
    expect(bumped.meta.version).toBe(2);
  });

  it("re-runs when params change, and ignores their key order", async () => {
    const stage = countingStage();
    await runStage({ ...base(), params: { model: "large-v3", beam: 5 } }, stage.run);

    const reordered = await runStage(
      { ...base(), params: { beam: 5, model: "large-v3" } },
      stage.run,
    );
    expect(reordered.skipped).toBe(true);

    const changed = await runStage(
      { ...base(), params: { beam: 1, model: "large-v3" } },
      stage.run,
    );
    expect(changed.skipped).toBe(false);
  });

  it("always re-runs with force, even straight after a successful run", async () => {
    const stage = countingStage();
    await runStage(base(), stage.run);
    expect((await runStage(base(), stage.run)).skipped).toBe(true);

    const forced = await runStage({ ...base(), force: true }, stage.run);
    expect(forced.skipped).toBe(false);
    expect(stage.calls.count).toBe(2);
  });

  it("re-runs when the artifact is missing even though the meta says ok", async () => {
    const stage = countingStage();
    await runStage(base(), stage.run);
    rmSync(session.paths.artifact("transcript"));

    expect((await runStage(base(), stage.run)).skipped).toBe(false);
  });

  it("counts a declared input appearing later as a change", async () => {
    const stage = countingStage();
    const absent = session.paths.input("roll20", "capture.json");
    const options = { ...base(), inputs: [inputPath, absent] };

    await runStage(options, stage.run);
    expect((await runStage(options, stage.run)).skipped).toBe(true);

    mkdirSync(session.paths.input("roll20"), { recursive: true });
    writeFileSync(absent, "{}");

    expect((await runStage(options, stage.run)).skipped).toBe(false);
  });

  it("leaves the previous artifact intact when a stage throws, and records the error", async () => {
    const stage = countingStage();
    await runStage(base(), stage.run);
    const before = readFileSync(session.paths.artifact("transcript"), "utf8");

    await expect(
      runStage({ ...base(), version: 2 }, async () => {
        throw new Error("ASR backend unavailable");
      }),
    ).rejects.toThrow("ASR backend unavailable");

    expect(readFileSync(session.paths.artifact("transcript"), "utf8")).toBe(before);
    await expect(readArtifact(session, "transcript")).resolves.toBeDefined();

    const meta = StageMeta.parse(
      JSON.parse(readFileSync(session.paths.stageMeta("transcript"), "utf8")),
    );
    expect(meta.status).toBe("error");
    expect(meta.error).toContain("ASR backend unavailable");
  });

  it("re-runs after a failure rather than trusting the errored meta", async () => {
    await expect(
      runStage(base(), async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow();

    const stage = countingStage();
    expect((await runStage(base(), stage.run)).skipped).toBe(false);
  });

  it("treats unreadable stage meta as a reason to re-run, not an error", async () => {
    const stage = countingStage();
    await runStage(base(), stage.run);
    writeFileSync(session.paths.stageMeta("transcript"), "{ truncated");

    expect((await runStage(base(), stage.run)).skipped).toBe(false);
  });

  it("reports progress through the supplied callback", async () => {
    const seen: Array<[number, string]> = [];
    await runStage({ ...base(), onProgress: (f, m) => seen.push([f, m]) }, async (context) => {
      context.progress(0.5, "halfway");
      await writeArtifact(session, "transcript", MINIMAL.transcript);
    });
    expect(seen).toEqual([[0.5, "halfway"]]);
  });
});
