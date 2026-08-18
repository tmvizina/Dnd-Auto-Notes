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
} from "./main.js";

describe("desktop quit supervision", () => {
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
});
