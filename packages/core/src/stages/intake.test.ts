import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Manifest, readArtifact, resolveSession, runIntakeStage } from "../index.js";

const generator = join(process.cwd(), "tools", "generate-fixture.mjs");
let root: string;
let clean: string;
let defects: string;

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
  generate(clean);
  generate(defects, "--with-defects");
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

  it("keeps roll ids and source evidence byte-stable on a forced rerun", async () => {
    const session = await fixtureSession(clean);
    const before = readFileSync(session.paths.artifact("manifest"), "utf8");
    await runIntakeStage({ session, force: true });
    const after = readFileSync(session.paths.artifact("manifest"), "utf8");
    const beforeRolls = (JSON.parse(before) as { rolls: unknown[] }).rolls;
    const afterRolls = (JSON.parse(after) as { rolls: unknown[] }).rolls;

    expect(afterRolls).toEqual(beforeRolls);
  });
});
