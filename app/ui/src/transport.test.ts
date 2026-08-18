import { describe, expect, it } from "vitest";
import {
  createTransport,
  isDesktopBridge,
  isUnavailableOperation,
  type DesktopBridgeLike,
} from "./transport.js";

describe("renderer transport", () => {
  it("uses a structured unavailable operation in a plain browser", async () => {
    const transport = createTransport({});

    expect(transport.kind).toBe("browser");
    await expect(transport.sessions.list()).rejects.toMatchObject({
      code: "unavailable",
      operation: "sessions.list",
      message: 'unavailable("sessions.list")',
    });
    expect(() => transport.runs.onEvent(() => undefined)).toThrow('unavailable("runs.onEvent")');
  });

  it("accepts only the complete validated bridge shape", () => {
    expect(isDesktopBridge({})).toBe(false);
    expect(isDesktopBridge({ sessions: {} })).toBe(false);
  });

  it("unwraps successful preload envelopes and preserves failures", async () => {
    const bridge: DesktopBridgeLike = {
      sessions: {
        list: async () => ({ ok: true, value: { sessions: [] } }),
        get: async () => ({ ok: false, error: { code: "unavailable", message: "not ready" } }),
        create: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
        copy: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
        reveal: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
        qa: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
        mapping: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
      },
      pipeline: {
        run: async () => ({ ok: false, error: { code: "unavailable", message: "not ready" } }),
        cancel: async () => ({ ok: false, error: { code: "unavailable", message: "not ready" } }),
      },
      runs: {
        subscribe: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
        unsubscribe: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
        onEvent: () => () => undefined,
      },
      settings: {
        get: async () => ({ ok: false, error: { code: "unavailable", message: "not ready" } }),
        set: async () => ({ ok: false, error: { code: "unavailable", message: "not ready" } }),
        reveal: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
        testConnection: async () => ({
          ok: false,
          error: { code: "unavailable", message: "not ready" },
        }),
      },
      sidecar: {
        status: async () => ({ ok: true, value: { status: "ready" } }),
        logs: async () => ({ ok: false, error: { code: "unavailable", message: "not ready" } }),
      },
    };

    const transport = createTransport({ dnd: bridge });
    expect(transport.kind).toBe("electron");
    await expect(transport.sessions.list()).resolves.toEqual({
      sessions: [],
    });
    await expect(transport.sessions.get({ sessionId: "session-1" })).rejects.toMatchObject({
      code: "unavailable",
      operation: "sessions.get",
    });
    await expect(transport.settings.reveal({ key: "sessionsRoot" })).rejects.toMatchObject({
      code: "unavailable",
      operation: "settings.reveal",
    });
    await expect(
      transport.settings.testConnection({ baseUrl: "http://127.0.0.1:1234/v1" }),
    ).rejects.toMatchObject({ code: "unavailable", operation: "settings.testConnection" });
    await expect(
      transport.sessions.copy({
        sessionId: "session-1",
        kind: "craig",
        sourcePath: "C:\\incoming\\track.wav",
      }),
    ).rejects.toMatchObject({ code: "unavailable", operation: "sessions.copy" });
    expect(isUnavailableOperation(new Error("no"))).toBe(false);
  });
});
