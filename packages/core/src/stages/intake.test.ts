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
