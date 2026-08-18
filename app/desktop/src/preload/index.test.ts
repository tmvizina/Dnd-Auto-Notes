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
});
