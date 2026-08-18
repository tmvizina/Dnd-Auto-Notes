import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  Manifest,
  openDb,
  QaReport,
  readArtifact,
  readIntakeQaReport,
  resolveSession,
  runIntakeStage,
} from "../index.js";
import { listFlags } from "../db/records.js";
import { nodeIo } from "../session/io.js";

const generator = join(process.cwd(), "tools", "generate-fixture.mjs");
let root: string;
let clean: string;
let defects: string;
let unparsed: string;

function generate(out: string, ...extra: string[]): void {
  execFileSync(process.execPath, [generator, "--out", out, ...extra], { stdio: "pipe" });
}

async function fixtureSession(path: string) {
  const session = await resolveSession(root, path.slice(root.length + 1));
  if (session === null) throw new Error(`fixture session was not created: ${path}`);
  return session;
}

beforeAll(() => {
  root = mkdtempSync(join(process.cwd(), ".p1-09-stage-"));
  clean = join(root, "clean");
  defects = join(root, "defects");
  unparsed = join(root, "unparsed");
  generate(clean);
  generate(defects, "--with-defects");
  generate(unparsed);
  const capturePath = join(unparsed, "input", "roll20", "roll20-capture.json");
  const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
    messages: Array<Record<string, unknown>>;
  };
  capture.messages.push({
    id: "unparsed-message",
    seq: 999,
    t_wall_ms: Date.UTC(2026, 7, 16, 23, 5, 10),
    kind: "future-message-kind",
    text: "unparsed fixture sample",
    outer_html: '<div class="message future">unparsed fixture sample</div>',
  });
  writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
}, 60_000);

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("public intake stage", () => {
  it("is exported from the core barrel and writes mapped roll evidence", async () => {
    const session = await fixtureSession(clean);
    const result = await runIntakeStage({ session });
    expect(result.skipped).toBe(false);

    const manifest = await readArtifact(session, "manifest");
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect(manifest.rolls).toHaveLength(6);
    expect(manifest.rolls.map((roll) => roll.id)).toEqual([
      "r0001",
      "r0002",
      "r0003",
      "r0004",
      "r0005",
      "r0006",
    ]);
    expect(manifest.rolls.map((roll) => roll.player_id)).toEqual([
      "pl_bly",
      "pl_ash",
      "pl_bly",
      "pl_cyd",
      "pl_ash",
      "pl_ash",
    ]);
    expect(manifest.rolls.every((roll) => roll.raw_ref.length > 0)).toBe(true);
    expect(manifest.rolls[0]?.source_id).toBe(manifest.rolls[0]?.raw_ref);
  });

  it("retains unmapped rolls as null and emits a QA error", async () => {
    const session = await fixtureSession(defects);
    await runIntakeStage({ session });
    const manifest = await readArtifact(session, "manifest");
    const unmapped = manifest.rolls.filter((roll) => roll.player_id === null);

    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]?.who).toBe("Cyd H.");
    expect(unmapped[0]?.raw_ref).toBe(unmapped[0]?.source_id);
    expect(manifest.qa).toContainEqual(
      expect.objectContaining({ code: "ROLL20_ACCOUNT_UNMAPPED", severity: "error" }),
    );
  });

  it("retains a deterministic raw reference and sample for an unparsed message", async () => {
    const session = await fixtureSession(unparsed);
    await runIntakeStage({ session, force: true });
    const manifest = await readArtifact(session, "manifest");
    const entry = manifest.qa.find((item) => item.code === "ROLL20_UNPARSED_MESSAGES");

    expect(entry).toEqual(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("sample unparsed-message: unparsed fixture sample"),
      }),
    );
  });

  it("keeps roll ids and source evidence byte-stable on a forced rerun", async () => {
    const session = await fixtureSession(clean);
    const before = readFileSync(session.paths.artifact("manifest"), "utf8");
    await runIntakeStage({ session, force: true });
    const after = readFileSync(session.paths.artifact("manifest"), "utf8");
    const beforeRolls = (JSON.parse(before) as { rolls: unknown[] }).rolls;
    const afterRolls = (JSON.parse(after) as { rolls: unknown[] }).rolls;

    expect(afterRolls).toEqual(beforeRolls);
  });

  it("writes a validated QA artifact and keeps manifest.qa identical", async () => {
    const session = await fixtureSession(clean);
    await runIntakeStage({ session, force: true });
    const manifest = await readArtifact(session, "manifest");
    const report = await readIntakeQaReport(session);

    expect(QaReport.safeParse(report).success).toBe(true);
    expect(report.stage).toBe("intake");
    expect(report.entries).toEqual([]);
    expect(manifest.qa).toEqual(report.entries);
  });

  it("reruns when QA is missing or invalid, then skips with a valid artifact", async () => {
    const session = await fixtureSession(clean);
    await runIntakeStage({ session, force: true });

    rmSync(session.paths.artifact("intakeQa"));
    const afterMissing = await runIntakeStage({ session });
    expect(afterMissing.skipped).toBe(false);
    expect(QaReport.safeParse(await readIntakeQaReport(session)).success).toBe(true);

    writeFileSync(session.paths.artifact("intakeQa"), "{}\n", "utf8");
    const afterInvalid = await runIntakeStage({ session });
    expect(afterInvalid.skipped).toBe(false);
    expect(QaReport.safeParse(await readIntakeQaReport(session)).success).toBe(true);

    const afterValid = await runIntakeStage({ session });
    expect(afterValid.skipped).toBe(true);
  });

  it("rolls back publication when cancellation lands after manifest publication", async () => {
    const session = await fixtureSession(clean);
    await runIntakeStage({ session, force: true });
    const paths = [
      session.paths.artifact("manifest"),
      session.paths.artifact("intakeQa"),
      session.paths.stageMeta("manifest"),
    ];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    const controller = new AbortController();
    const io = {
      ...nodeIo,
      readFile: async (path: string): Promise<string> => readFileSync(path, "utf8"),
      rename: async (from: string, to: string): Promise<void> => {
        await nodeIo.rename(from, to);
        if (to.endsWith("manifest.json")) controller.abort();
      },
    };
    await expect(
      runIntakeStage({ session, force: true, signal: controller.signal, io }),
    ).rejects.toThrow("intake cancelled");
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("rolls back every publication boundary through the injected IO backend", async () => {
    const session = await fixtureSession(clean);
    const paths = [
      session.paths.artifact("manifest"),
      session.paths.artifact("intakeQa"),
      session.paths.stageMeta("manifest"),
    ];
    for (const abortPath of paths) {
      const original = new Map(paths.map((path, index) => [path, `old-${String(index)}`]));
      const files = new Map(original);
      const controller = new AbortController();
      const io = {
        mkdir: async (): Promise<void> => undefined,
        readFile: async (path: string): Promise<string> => {
          const value = files.get(path);
          if (value === undefined) throw new Error(`missing ${path}`);
          return value;
        },
        writeFile: async (path: string, data: string | Uint8Array): Promise<void> => {
          files.set(path, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        },
        rename: async (from: string, to: string): Promise<void> => {
          const value = files.get(from);
          if (value === undefined) throw new Error(`missing temporary ${from}`);
          files.delete(from);
          files.set(to, value);
          if (to === abortPath) controller.abort();
        },
        rm: async (path: string): Promise<void> => {
          files.delete(path);
        },
      };
      await expect(
        runIntakeStage({ session, force: true, signal: controller.signal, io }),
      ).rejects.toThrow(/cancelled/u);
      expect(new Map(paths.map((path) => [path, files.get(path)]))).toEqual(original);
      expect([...files.keys()].filter((path) => path.includes(".tmp"))).toEqual([]);
    }
  });

  it("mirrors exactly the three defect entries into the open flags", async () => {
    const session = await fixtureSession(defects);
    const databasePath = join(root, "data", "notes.db");
    await runIntakeStage({ session, databasePath, force: true });
    const report = await readIntakeQaReport(session);
    expect(report.entries.map((entry) => entry.code).sort()).toEqual([
      "ROLL20_ACCOUNT_UNMAPPED",
      "TRACK_DURATION_MISMATCH",
      "TRACK_SILENT",
    ]);

    const db = openDb(databasePath);
    try {
      const flags = listFlags(db, session.descriptor.id, { status: "open" });
      expect(flags).toHaveLength(3);
      expect(flags.map((flag) => flag.code).sort()).toEqual(
        report.entries.map((entry) => entry.code).sort(),
      );
    } finally {
      closeDb(db);
    }
  });
});
