import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatProgress, run } from "./cli.js";
import type { ProgressEvent } from "./cli.js";

const generator = join(process.cwd(), "tools", "generate-fixture.mjs");
let root: string;
let clean: string;
let defects: string;

function generate(out: string, ...extra: string[]): void {
  execFileSync(process.execPath, [generator, "--out", out, ...extra], { stdio: "pipe" });
}

function events(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(() => {
  root = mkdtempSync(join(process.cwd(), ".p1-09-cli-"));
  clean = join(root, "clean");
  defects = join(root, "defects");
  generate(clean);
  generate(defects, "--with-defects");
}, 60_000);

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("pipeline intake CLI", () => {
  it("uses the public core stage, emits progress, skips, and force-runs", async () => {
    const first = await run(["run", "--session", clean, "--stage", "intake", "--json"]);
    const firstEvents = events(first.stdout);
    expect(first.exitCode).toBe(0);
    expect(firstEvents.some((event) => event["event"] === "progress")).toBe(true);
    expect(firstEvents.find((event) => event["event"] === "stage")).toMatchObject({
      stage: "intake",
      status: "ok",
    });
    expect(firstEvents.filter((event) => event["terminal"] === true)).toHaveLength(1);

    const started = performance.now();
    const second = await run(["run", "--session", clean, "--stage", "intake", "--json"]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(second.exitCode).toBe(0);
    expect(events(second.stdout).find((event) => event["event"] === "stage")).toMatchObject({
      stage: "intake",
      status: "skipped",
    });

    const forced = await run(["run", "--session", clean, "--stage", "intake", "--force", "--json"]);
    expect(forced.exitCode).toBe(0);
    expect(events(forced.stdout).find((event) => event["event"] === "stage")).toMatchObject({
      stage: "intake",
      status: "ok",
    });

    const manifest = JSON.parse(
      readFileSync(join(clean, "work", "01-intake", "manifest.json"), "utf8"),
    ) as { rolls: unknown[] };
    expect(manifest.rolls).toHaveLength(6);
  });

  it("renders readable TTY progress lines and forwards live events", async () => {
    const live: ProgressEvent[] = [];
    const outcome = await run(
      ["run", "--session", clean, "--stage", "intake", "--force"],
      process.cwd(),
      { isTTY: true, onProgress: (event) => live.push(event) },
    );
    expect(outcome.exitCode).toBe(0);
    expect(live.map((event) => event.fraction)).toEqual([0.05, 0.2, 0.65, 0.95, 1]);
    expect(formatProgress(live[0] as ProgressEvent)).toBe("intake: 5% loading campaign registry");

    const buffered = await run(
      ["run", "--session", clean, "--stage", "intake", "--force"],
      process.cwd(),
      { isTTY: true },
    );
    expect(buffered.stdout).toContain("intake: 100% intake complete");
  });

  it("returns 2 and names all three synthetic defects", async () => {
    const outcome = await run(["run", "--session", defects, "--stage", "intake", "--json"]);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toContain("TRACK_DURATION_MISMATCH");
    expect(outcome.stdout).toContain("TRACK_SILENT");
    expect(outcome.stdout).toContain("ROLL20_ACCOUNT_UNMAPPED");
    expect(events(outcome.stdout).filter((event) => event["terminal"] === true)).toHaveLength(1);
  });

  it("reports status and QA through both output modes", async () => {
    await run(["run", "--session", clean, "--stage", "intake"]);

    const statusText = await run(["status", "--session", clean]);
    expect(statusText.exitCode).toBe(0);
    expect(statusText.stdout).toContain("intake: ok");

    const statusJson = await run(["status", "--session", clean, "--json"]);
    expect(statusJson.exitCode).toBe(0);
    expect(events(statusJson.stdout)).toEqual([
      expect.objectContaining({ event: "status", terminal: true }),
    ]);

    const qaText = await run(["qa", "--session", clean]);
    expect(qaText.exitCode).toBe(0);
    expect(qaText.stdout).toContain("QA for");

    const qaJson = await run(["qa", "--session", clean, "--json"]);
    expect(qaJson.exitCode).toBe(0);
    expect(events(qaJson.stdout)).toEqual([
      expect.objectContaining({ event: "qa", terminal: true, exit_code: 0 }),
    ]);
  });

  it("resolves a session folder from a different cwd", async () => {
    const outcome = await run(
      ["run", "--session", clean, "--stage", "intake", "--json"],
      join(process.cwd(), "packages", "cli"),
    );
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(join(clean, "work", "01-intake", "manifest.json"))).toBe(true);
  });

  it("scaffolds a session with Craig, Roll20, and clip folders", async () => {
    const sessionsRoot = join(root, "new-sessions");
    const previous = process.env["DND_SESSIONS_ROOT"];
    process.env["DND_SESSIONS_ROOT"] = sessionsRoot;
    try {
      const outcome = await run([
        "session",
        "new",
        "A New Table",
        "--date",
        "2026-08-18",
        "--number",
        "7",
      ]);
      const sessionRoot = join(sessionsRoot, "2026-08-18-a-new-table");
      expect(outcome.exitCode).toBe(0);
      expect(existsSync(join(sessionRoot, "session.json"))).toBe(true);
      expect(existsSync(join(sessionRoot, "input", "craig"))).toBe(true);
      expect(existsSync(join(sessionRoot, "input", "roll20"))).toBe(true);
      expect(existsSync(join(sessionRoot, "media", "clips"))).toBe(true);
      expect(outcome.stdout).toContain("Drop Craig audio");
    } finally {
      if (previous === undefined) delete process.env["DND_SESSIONS_ROOT"];
      else process.env["DND_SESSIONS_ROOT"] = previous;
    }
  });

  it("resolves the latest session id", async () => {
    const sessionsRoot = join(root, "latest-sessions");
    const previous = process.env["DND_SESSIONS_ROOT"];
    process.env["DND_SESSIONS_ROOT"] = sessionsRoot;
    try {
      const created = await run(["session", "new", "Latest Table", "--date", "2026-08-18"]);
      expect(created.exitCode).toBe(0);
      const latest = await run(["status", "--latest", "--json"]);
      expect(latest.exitCode).toBe(0);
      expect(latest.stdout).toContain('"session_id":"2026-08-18-latest-table"');
    } finally {
      if (previous === undefined) delete process.env["DND_SESSIONS_ROOT"];
      else process.env["DND_SESSIONS_ROOT"] = previous;
    }
  });
});
