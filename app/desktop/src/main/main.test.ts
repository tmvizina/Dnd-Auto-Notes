import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => false),
    quit: vi.fn(),
  },
  BrowserWindow: class {},
  session: { defaultSession: {} },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

vi.mock("./uiProtocol.js", () => ({
  registerUiScheme: vi.fn(),
  registerUiProtocol: vi.fn(),
  createUiUrl: vi.fn(() => "dnd-auto-notes://app/index.html"),
  isAllowedUiUrl: vi.fn(() => true),
}));

import {
  createAcceptedPipelineRunTracker,
  createQuitStopper,
  createSidecarHandlers,
  runtimeRootsForSettings,
  sidecarRepoRootForSetting,
} from "./main.js";
import { createSettingsHandlers } from "./handlers/settings.js";
import { RunManager } from "./runs/index.js";

describe("desktop quit supervision", () => {
  it("composes persisted path settings into the next desktop runtime", () => {
    expect(
      runtimeRootsForSettings(
        {
          sessionsRoot: "C:\\campaign-sessions",
          campaignRoot: "C:\\campaign-data",
          sidecarPath: "C:\\tools\\sidecar",
        },
        {
          sessionsRoot: "C:\\default-sessions",
          campaignRoot: "C:\\default-campaign",
          sidecarRepoRoot: "C:\\repo",
        },
      ),
    ).toEqual({
      sessionsRoot: "C:\\campaign-sessions",
      campaignRoot: "C:\\campaign-data",
      sidecarRepoRoot: "C:\\tools",
    });
    expect(sidecarRepoRootForSetting(undefined, "C:\\repo")).toBe("C:\\repo");
  });

  it("loads persisted paths before composing handlers on restart", async () => {
    const root = await mkdtemp(join(process.cwd(), ".p4-11-runtime-"));
    try {
      const settings = createSettingsHandlers({ settingsPath: join(root, "settings.json") });
      await settings.settingsSet({ key: "sessionsRoot", value: join(root, "sessions") });
      await settings.settingsSet({ key: "campaignRoot", value: join(root, "campaign") });
      await mkdir(join(root, "sidecar"));
      await settings.settingsSet({ key: "sidecarPath", value: join(root, "sidecar") });
      const restarted = createSettingsHandlers({ settingsPath: join(root, "settings.json") });
      const roots = runtimeRootsForSettings((await restarted.settingsGet()).settings, {
        sessionsRoot: "C:\\default-sessions",
        campaignRoot: "C:\\default-campaign",
        sidecarRepoRoot: "C:\\repo",
      });
      expect(roots).toEqual({
        sessionsRoot: join(root, "sessions"),
        campaignRoot: join(root, "campaign"),
        sidecarRepoRoot: root,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("awaits one owned-sidecar stop even when quit is requested twice", async () => {
    let release: (() => void) | undefined;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const quitStop = createQuitStopper({ stop });

    const first = quitStop();
    const second = quitStop();
    expect(second).toBe(first);
    expect(stop).toHaveBeenCalledTimes(1);
    release?.();
    await expect(first).resolves.toBeUndefined();
  });

  it("starts the sidecar from pipeline demand and exposes bounded diagnostics", async () => {
    const supervisor = {
      state: {
        status: "ready" as const,
        setupCommand: "uv venv .venv",
        restartAttempt: 0,
      },
      ensureRunning: vi.fn(async () => supervisor.state),
      getLogTail: vi.fn(async () => ["sidecar log"]),
    };
    const handlers = createSidecarHandlers(supervisor);
    const status = await handlers.sidecarStatus?.({} as never, {} as never);
    expect(status).toMatchObject({ status: "ready", setupCommand: "uv venv .venv" });
    const logs = await handlers.sidecarLogs?.({ maxLines: 5 }, {} as never);
    expect(logs).toEqual({ lines: ["sidecar log"] });
    const run = await handlers.pipelineRun?.({ sessionId: "session-1" }, {} as never);
    expect(run).toMatchObject({ runId: expect.any(String) });
    expect(supervisor.ensureRunning).toHaveBeenCalledTimes(1);
  });

  it("includes the sidecar capability report in settings-facing status", async () => {
    const supervisor = {
      state: { status: "ready" as const, restartAttempt: 0 },
      ensureRunning: vi.fn(async () => supervisor.state),
      getLogTail: vi.fn(async () => []),
      client: () => ({ health: async () => ({ capabilities: { faster_whisper: true } }) }),
    };
    const handlers = createSidecarHandlers(supervisor);
    await expect(handlers.sidecarStatus?.({} as never, {} as never)).resolves.toEqual({
      status: "ready",
      capabilities: { faster_whisper: true },
    });
  });

  it("returns the demand-start failure without posting a sidecar job", async () => {
    const error = new Error("sidecar environment is missing");
    const supervisor = {
      state: { status: "stopped" as const, restartAttempt: 0 },
      ensureRunning: vi.fn(async () => {
        throw error;
      }),
      getLogTail: vi.fn(async () => []),
    };
    const handlers = createSidecarHandlers(supervisor);
    await expect(handlers.pipelineRun?.({ sessionId: "session-1" }, {} as never)).rejects.toBe(
      error,
    );
    expect(supervisor.ensureRunning).toHaveBeenCalledTimes(1);
  });

  it("emits run_failed and aborts accepted runs when the sidecar becomes unhealthy", () => {
    const events: unknown[] = [];
    const tracker = createAcceptedPipelineRunTracker((event) => events.push(event));
    const controller = new AbortController();
    tracker.accept("run-1", controller);

    tracker.fail("unhealthy", "unhealthy");

    expect(controller.signal.aborted).toBe(true);
    expect(events).toMatchObject([
      { type: "run_failed", runId: "run-1", error: { code: "unhealthy" } },
    ]);
    expect(tracker.cancel("run-1")).toBe(false);
  });

  it("starts the canonical intake runner and emits a structured missing-session failure", async () => {
    const events: unknown[] = [];
    const supervisor = {
      state: { status: "ready" as const, restartAttempt: 0 },
      ensureRunning: vi.fn(async () => supervisor.state),
      getLogTail: vi.fn(async () => []),
    };
    const handlers = createSidecarHandlers(supervisor, {
      sessionsRoot: "C:\\missing\\sessions",
      campaignRoot: "C:\\missing\\campaign",
      emit: (event) => events.push(event),
    });
    const result = await handlers.pipelineRun?.({ sessionId: "2026-01-01-session" }, {} as never);
    expect(result).toMatchObject({ runId: expect.any(String) });
    await vi.waitFor(() => {
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "stage_started", stage: "intake" }),
          expect.objectContaining({ type: "run_failed" }),
        ]),
      );
    });
  });

  it("routes managed runs through replay-safe subscriptions with run-local sequences", async () => {
    const events: Array<{
      readonly runId: string;
      readonly sequence: number;
      readonly type: string;
    }> = [];
    const supervisor = {
      state: { status: "ready" as const, restartAttempt: 0 },
      ensureRunning: vi.fn(async () => supervisor.state),
      getLogTail: vi.fn(async () => []),
    };
    const manager = new RunManager();
    const handlers = createSidecarHandlers(supervisor, {
      sessionsRoot: "C:\\missing\\sessions",
      campaignRoot: "C:\\missing\\campaign",
      manager,
      emit: (event) => {
        if ("runId" in event && "sequence" in event)
          events.push({ runId: event.runId, sequence: event.sequence, type: event.type });
      },
    });
    const run = await handlers.pipelineRun?.({ sessionId: "missing" }, {} as never);
    if (run === undefined) throw new Error("pipeline handler did not return a run");
    await vi.waitFor(() => expect(events.some((event) => event.type === "run_failed")).toBe(true));
    const replay = await handlers.runsSubscribe?.({ runId: run.runId }, {} as never);
    expect(replay?.replay.map((event) => event.runId)).toEqual([run.runId, run.runId, run.runId]);
    expect(replay?.replay.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set([run.runId]));
  });
});
