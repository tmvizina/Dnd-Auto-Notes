import { describe, expect, it, vi } from "vitest";
import { CLI_VERSION, playLabelClip, run } from "./cli.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureProfileAccuracy, profilePartitions, readLabels, readProfiles } from "@dnd/core";

describe("pipeline argument handling", () => {
  it("prints usage and exits 0 with no arguments", async () => {
    const outcome = await run([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("Usage:");
  });

  it.each(["--help", "-h", "help"])("prints usage for %s", async (flag) => {
    const outcome = await run([flag]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("pipeline <command> [options]");
  });

  it("prints the version", async () => {
    await expect(run(["--version"])).resolves.toEqual({ stdout: `${CLI_VERSION}\n`, exitCode: 0 });
  });

  it("prints resolved config for a known cwd", async () => {
    const outcome = await run(["config"], process.cwd());
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("sidecar port");
    expect(outcome.stdout).toContain("sessions");
  });

  it("names the delivering ticket for an unimplemented command, and fails", async () => {
    const outcome = await run(["notes", "--session", "s42"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("P3-08");
    expect(outcome.stdout).toContain("--session s42");
  });

  it("exits 2 on an unknown command and shows usage", async () => {
    const outcome = await run(["definitely-not-a-command"]);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toContain("Unknown command");
    expect(outcome.stdout).toContain("Usage:");
  });

  it("calibrate reports the deterministic shortfall", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-12-cli-"));
    try {
      const campaign = join(root, "campaign");
      mkdirSync(join(root, "docs"), { recursive: true });
      mkdirSync(join(campaign, "labels"), { recursive: true });
      writeFileSync(
        join(campaign, "labels", "all.jsonl"),
        JSON.stringify({
          utterance_id: "u1",
          mode: "uncertain",
          character_id: null,
          labeller: "test",
          at: "2026-01-01T00:00:00Z",
        }) + "\n",
      );
      const outcome = await run(["calibrate", "--campaign", campaign], root);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stdout).toContain("need 19 more labels");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid label strategy and minutes before resolving a session", async () => {
    expect((await run(["label", "--session", "missing", "--strategy", "bogus"])).exitCode).toBe(2);
    expect((await run(["label", "--session", "missing", "--minutes", "0"])).exitCode).toBe(2);
  });

  it("rejects unknown options and missing option values", async () => {
    expect((await run(["calibrate", "--campaign"])).exitCode).toBe(2);
    expect((await run(["calibrate", "--campaign", ".", "--bogus"])).exitCode).toBe(2);
    expect((await run(["label", "--session", "missing", "--bogus"])).exitCode).toBe(2);
    expect((await run(["config", "--bogus"])).exitCode).toBe(2);
  });

  it("passes exact clip bounds and handles player failure and hangs", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-12-player-"));
    try {
      const clipPath = join(root, "clip.wav");
      writeFileSync(clipPath, "fake");
      const callbacks = new Map<string, (value?: unknown) => void>();
      const child = {
        once: (event: string, callback: (value?: unknown) => void) => {
          callbacks.set(event, callback);
          return child;
        },
        removeListener: (event: string) => {
          callbacks.delete(event);
          return child;
        },
        kill: vi.fn(),
      };
      const spawnProcess = vi.fn(() => child) as unknown as NonNullable<
        Parameters<typeof playLabelClip>[1]
      >;
      const running = playLabelClip({ path: clipPath, start_s: 1.25, end_s: 3.75 }, spawnProcess);
      expect(spawnProcess).toHaveBeenCalledWith(
        "ffplay",
        ["-nodisp", "-autoexit", "-ss", "1.25", "-t", "2.5", clipPath],
        { stdio: "ignore", windowsHide: true },
      );
      callbacks.get("close")?.(0);
      await expect(running).resolves.toBeUndefined();

      const failed = playLabelClip({ path: clipPath, start_s: 0, end_s: 1 }, spawnProcess);
      callbacks.get("error")?.(new Error("ENOENT"));
      await expect(failed).rejects.toThrow("ENOENT");

      const nonzero = playLabelClip({ path: clipPath, start_s: 0, end_s: 1 }, spawnProcess);
      callbacks.get("close")?.(7);
      await expect(nonzero).rejects.toThrow("audio player exited with 7");

      vi.useFakeTimers();
      const hung = playLabelClip({ path: clipPath, start_s: 0, end_s: 1 }, spawnProcess);
      // The rejection handler has to be attached before the timers are driven.
      // Asserting after the fact leaves a microtask gap in which the rejection
      // is genuinely unhandled, which Node reports and Vitest counts as an
      // error even though every assertion passes.
      const hungRejects = expect(hung).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(1_000);
      await hungRejects;
      expect(callbacks.size).toBe(0);
      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the injected clock for calibration publication and docs", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-12-clock-"));
    try {
      const campaign = join(root, "campaign");
      mkdirSync(join(campaign, "labels"), { recursive: true });
      const labels = Array.from({ length: 20 }, (_, index) => ({
        utterance_id: `u${String(index)}`,
        mode: "in_character",
        character_id: "ch_hero",
        labeller: "test",
        at: "2026-01-01T00:00:00Z",
        session_id: index < 10 ? "s1" : "s2",
        player_id: "p1",
        features: { score: index < 10 ? 1 : -1 },
        embedding: [1, 0],
      }));
      writeFileSync(
        join(campaign, "labels", "all.jsonl"),
        `${labels.map((label) => JSON.stringify(label)).join("\n")}\n`,
      );
      const fixed = "2030-02-03T04:05:06.000Z";
      const outcome = await run(["calibrate", "--campaign", campaign], root, { now: () => fixed });
      expect(outcome.exitCode).toBe(0);
      // writeCalibration folds both `:` and `.` out of the stamp, because the
      // stamp is also the `version` token stored inside the file.
      expect(outcome.stdout).toContain("scorer-2030-02-03T04-05-06-000Z.json");
      expect(readFileSync(join(root, "docs", "calibration.md"), "utf8")).toContain(fixed);
      const allLabels = await readLabels(join(campaign, "labels", "all.jsonl"));
      const partitions = profilePartitions(allLabels);
      const persisted = await readProfiles(join(campaign, "profiles"), "p1");
      const report = JSON.parse(
        readFileSync(outcome.stdout.trim().split("\n").at(-1)!, "utf8"),
      ) as { profile_accuracy_after: { accuracy: number | null; evaluated: number } };
      expect(measureProfileAccuracy(partitions.held_out, persisted)).toEqual(
        report.profile_accuracy_after,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
