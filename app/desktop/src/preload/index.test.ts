import { describe, expect, it, vi } from "vitest";
import { CHANNELS, IPC_LIMITS, success } from "../shared/contracts.js";
import { BRIDGE_NAME, buildBridge, type IpcRendererLike } from "./index.js";

const electronMocks = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("electron", () => electronMocks);

describe("preload bridge", () => {
  it("exposes exactly one object and never includes ipcRenderer", () => {
    expect(electronMocks.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [name, exposed] = electronMocks.contextBridge.exposeInMainWorld.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe(BRIDGE_NAME);
    expect(exposed).not.toHaveProperty("ipcRenderer");
    expect(Object.keys(exposed).sort()).toEqual([
      "pipeline",
      "runs",
      "sessions",
      "settings",
      "sidecar",
    ]);
  });

  it("validates before invoking and validates the response on return", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => success({ settings: {} }));
    const fake: IpcRendererLike = {
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = buildBridge(fake);
    const invalid = await bridge.settings.set({ key: "credentials.token", value: "nope" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "settings_key_not_allowed" } });
    expect(invoke).not.toHaveBeenCalled();

    const valid = await bridge.settings.get();
    expect(valid).toEqual({ ok: true, value: { settings: {} } });
    expect(invoke).toHaveBeenCalledWith(CHANNELS.settings.get, success({}));
  });

  it("validates and forwards settings reveal and connection test calls", async () => {
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === CHANNELS.settings.reveal)
        return success({ key: "sessionsRoot", revealed: true });
      return success({ ok: true, latencyMs: 7, models: ["local"], message: "Connected" });
    });
    const fake: IpcRendererLike = { invoke, on: vi.fn(), removeListener: vi.fn() };
    const bridge = buildBridge(fake);
    await expect(bridge.settings.reveal({ key: "sessionsRoot" })).resolves.toEqual({
      ok: true,
      value: { key: "sessionsRoot", revealed: true },
    });
    await expect(
      bridge.settings.testConnection({ baseUrl: "http://127.0.0.1:1234/v1" }),
    ).resolves.toEqual({
      ok: true,
      value: { ok: true, latencyMs: 7, models: ["local"], message: "Connected" },
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      CHANNELS.settings.reveal,
      success({ key: "sessionsRoot" }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      CHANNELS.settings.testConnection,
      success({ baseUrl: "http://127.0.0.1:1234/v1" }),
    );
  });

  it("drops invalid push events and unregisters listeners", () => {
    let receive: ((event: unknown, payload: unknown) => void) | undefined;
    const removeListener = vi.fn();
    const fake: IpcRendererLike = {
      invoke: vi.fn(),
      on: vi.fn((_channel: string, listener: (event: unknown, payload: unknown) => void) => {
        receive = listener;
      }),
      removeListener,
    };
    const bridge = buildBridge(fake);
    const listener = vi.fn();
    const unsubscribe = bridge.runs.onEvent(listener);
    receive?.(
      undefined,
      success({
        type: "log",
        sequence: 1,
        runId: "run-1",
        level: "info",
        message: "hello",
        session_id: "hidden",
      }),
    );
    expect(listener).toHaveBeenCalledWith({
      type: "log",
      sequence: 1,
      runId: "run-1",
      level: "info",
      message: "hello",
    });
    receive?.(undefined, { ok: true, value: { type: "unknown" } });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("enforces serialized request and response byte caps", async () => {
    const invoke = vi.fn(async (): Promise<unknown> =>
      success({
        sessions: Array.from({ length: IPC_LIMITS.maxArrayLength }, (_, index) => ({
          sessionId: `s-${String(index)}`,
          title: "x".repeat(IPC_LIMITS.maxStringLength / 128),
          number: index,
          date: "2026-01-01",
          durationS: 1,
          status: "new",
          grade: null,
          hasNotes: false,
        })),
      }),
    );
    const fake: IpcRendererLike = {
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = buildBridge(fake);

    const oversizedRequest = await bridge.settings.set({
      key: "sessionsRoot",
      value: "x".repeat(IPC_LIMITS.maxRequestBytes),
    });
    expect(oversizedRequest).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
    expect(invoke).not.toHaveBeenCalled();

    const oversizedResponse = await bridge.sessions.list();
    expect(oversizedResponse).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
  });

  it("exposes setup commands and bounded sidecar logs through the bridge", async () => {
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === CHANNELS.sidecar.status)
        return success({ status: "unavailable", setupCommand: "uv venv .venv" });
      return success({ lines: ["sidecar line"] });
    });
    const fake: IpcRendererLike = {
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = buildBridge(fake);

    await expect(bridge.sidecar.status()).resolves.toEqual({
      ok: true,
      value: { status: "unavailable", setupCommand: "uv venv .venv" },
    });
    await expect(bridge.sidecar.logs({ maxLines: 5 })).resolves.toEqual({
      ok: true,
      value: { lines: ["sidecar line"] },
    });
    expect(invoke).toHaveBeenCalledWith(CHANNELS.sidecar.logs, success({ maxLines: 5 }));
  });

  it("validates and forwards the session copy operation", async () => {
    const invoke = vi.fn(async (): Promise<unknown> =>
      success({ copyId: "copy-1", destinationName: "track.wav" }),
    );
    const fake: IpcRendererLike = { invoke, on: vi.fn(), removeListener: vi.fn() };
    const bridge = buildBridge(fake);
    await expect(
      bridge.sessions.copy({
        sessionId: "2026-01-01-session",
        kind: "craig",
        sourcePath: "C:\\incoming\\track.wav",
      }),
    ).resolves.toEqual({
      ok: true,
      value: { copyId: "copy-1", destinationName: "track.wav" },
    });
    expect(invoke).toHaveBeenCalledWith(
      CHANNELS.sessions.copy,
      success({
        sessionId: "2026-01-01-session",
        kind: "craig",
        sourcePath: "C:\\incoming\\track.wav",
      }),
    );
  });
});
