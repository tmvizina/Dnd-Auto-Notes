import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidecarError } from "./errors.js";
import {
  DEFAULT_PORT,
  SidecarSupervisor,
  freePort,
  resolveLauncher,
  resolvePort,
} from "./supervisor.js";

const REPO_ROOT = join(process.cwd());
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "dnd-sidecar-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("resolvePort", () => {
  it("prefers an explicit option over everything", () => {
    expect(resolvePort(9100, { DND_SIDECAR_PORT: "9200" })).toBe(9100);
  });

  it("falls back to the environment, then the documented default", () => {
    expect(resolvePort(undefined, { DND_SIDECAR_PORT: "9200" })).toBe(9200);
    expect(resolvePort(undefined, {})).toBe(DEFAULT_PORT);
  });

  it("ignores an unusable override rather than crashing before it can report", () => {
    expect(resolvePort(undefined, { DND_SIDECAR_PORT: "0" })).toBe(DEFAULT_PORT);
    expect(resolvePort(undefined, { DND_SIDECAR_PORT: "not-a-port" })).toBe(DEFAULT_PORT);
    expect(resolvePort(undefined, { DND_SIDECAR_PORT: "  " })).toBe(DEFAULT_PORT);
  });
});

describe("resolveLauncher", () => {
  it("finds this repo's environment", () => {
    const launcher = resolveLauncher(join(REPO_ROOT, "sidecar"));
    expect(["uv", "venv"]).toContain(launcher.kind);
    expect(launcher.args).not.toContain("run");
  });

  it("names the exact command to run when there is no environment at all", () => {
    const error = (() => {
      try {
        resolveLauncher(join(stateDir, "no-sidecar-here"));
        return null;
      } catch (thrown) {
        return thrown as SidecarError;
      }
    })();

    expect(error?.code).toBe("env_missing");
    // Actionable, not merely true: the message carries a runnable command.
    expect(error?.message).toContain("venv .venv");
    expect(error?.message).toContain("pip install -e");
    expect(error?.message).toContain("To fix:");
  });

  it("never installs anything itself", () => {
    // Installing uv is machine-wide software and needs a human's say-so.
    expect(() => resolveLauncher(join(stateDir, "nothing"))).toThrow(SidecarError);
    expect(existsSync(join(stateDir, "nothing"))).toBe(false);
  });
});

describe("freePort", () => {
  it("returns a port nothing is listening on", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });
});

describe("SidecarSupervisor", () => {
  it("starts the real sidecar and answers health", async () => {
    const port = await freePort();
    const supervisor = new SidecarSupervisor({ repoRoot: REPO_ROOT, port, stateDir });

    const record = await supervisor.ensureRunning();
    try {
      expect(record.port).toBe(port);
      expect(record.ownedByUs).toBe(true);
      expect(record.pid).toBeGreaterThan(0);

      const health = await supervisor.client(port).health();
      expect(health.status).toBe("ok");

      // The record is on disk so another process can find the sidecar.
      const written = JSON.parse(readFileSync(supervisor.recordPath, "utf8")) as {
        port: number;
      };
      expect(written.port).toBe(port);
      expect(existsSync(supervisor.logPath)).toBe(true);
    } finally {
      await supervisor.stop();
    }
  }, 90_000);

  it("reuses a running sidecar instead of spawning a second", async () => {
    const port = await freePort();
    const supervisor = new SidecarSupervisor({ repoRoot: REPO_ROOT, port, stateDir });

    const first = await supervisor.ensureRunning();
    try {
      const second = await supervisor.ensureRunning();
      expect(second.pid).toBe(first.pid);
      expect(second.port).toBe(first.port);
    } finally {
      await supervisor.stop();
    }
  }, 90_000);

  it("adopts a sidecar someone else started, and does not kill it", async () => {
    const port = await freePort();
    const owner = new SidecarSupervisor({ repoRoot: REPO_ROOT, port, stateDir });
    await owner.ensureRunning();

    try {
      const adopter = new SidecarSupervisor({
        repoRoot: REPO_ROOT,
        port,
        stateDir: join(stateDir, "other"),
      });
      const adopted = await adopter.ensureRunning();

      expect(adopted.ownedByUs).toBe(false);
      expect(adopter.owns).toBe(false);

      // Stopping the adopter must leave the original running: killing the
      // terminal a developer is watching is not ours to do.
      await adopter.stop();
      expect((await owner.client(port).health()).status).toBe("ok");
    } finally {
      await owner.stop();
    }
  }, 90_000);

  it("leaves no orphan process after stop", async () => {
    const port = await freePort();
    const supervisor = new SidecarSupervisor({ repoRoot: REPO_ROOT, port, stateDir });
    const record = await supervisor.ensureRunning();
    const pid = record.pid;
    expect(pid).not.toBeNull();

    await supervisor.stop();

    // Give the OS a moment to reap, then confirm the pid is gone.
    await new Promise((resolve) => setTimeout(resolve, 500));
    let alive = true;
    try {
      process.kill(pid as number, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 90_000);
});
