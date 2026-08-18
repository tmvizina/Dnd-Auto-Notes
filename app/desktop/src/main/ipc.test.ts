import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
import {
  CHANNELS,
  ContractValidationError,
  ERROR_CODES,
  IPC_LIMITS,
  success,
  type SettingKey,
} from "../shared/contracts.js";
import {
  registerIpcHandlers,
  sendOutboundEvent,
  type IpcInvokeEvent,
  type IpcMainLike,
} from "./ipc.js";

type Listener = (event: IpcInvokeEvent, ...args: unknown[]) => unknown;

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>();

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async call(channel: string, event: IpcInvokeEvent, ...payload: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`missing handler for ${channel}`);
    return handler(event, ...payload);
  }
}

const trustedEvent = (
  senderId = 7,
  frameUrl = "dnd-auto-notes://app/index.html",
): IpcInvokeEvent => ({
  sender: { id: senderId },
  senderFrame: { url: frameUrl },
});

describe("main IPC boundary", () => {
  it("checks sender and frame before validating a request", async () => {
    const ipc = new FakeIpcMain();
    const remove = registerIpcHandlers({
      expectedSenderId: 7,
      expectedOrigin: "dnd-auto-notes://app",
      expectedFrameUrl: "dnd-auto-notes://app/index.html",
      ipcMain: ipc,
    });

    const forgedSender = await ipc.call(CHANNELS.settings.get, trustedEvent(99), success({}));
    expect(forgedSender).toMatchObject({ ok: false, error: { code: "forbidden_sender" } });

    const forgedFrame = await ipc.call(
      CHANNELS.settings.get,
      trustedEvent(7, "https://evil.example/index.html"),
      success({}),
    );
    expect(forgedFrame).toMatchObject({ ok: false, error: { code: "forbidden_frame" } });

    const sameOriginForgedFrame = await ipc.call(
      CHANNELS.settings.get,
      trustedEvent(7, "dnd-auto-notes://app/evil.html"),
      success({}),
    );
    expect(sameOriginForgedFrame).toMatchObject({
      ok: false,
      error: { code: "forbidden_frame" },
    });

    const childFrameEvent: IpcInvokeEvent = {
      sender: { id: 7 },
      senderFrame: {
        url: "dnd-auto-notes://app/index.html",
        parent: { url: "dnd-auto-notes://app/index.html" },
      },
    };
    const forgedChildFrame = await ipc.call(CHANNELS.settings.get, childFrameEvent, success({}));
    expect(forgedChildFrame).toMatchObject({ ok: false, error: { code: "forbidden_frame" } });
    remove();
    expect(ipc.handlers.size).toBe(0);
  });

  it("returns a structured rejection for unknown request fields", async () => {
    const ipc = new FakeIpcMain();
    registerIpcHandlers({
      expectedSenderId: 7,
      expectedOrigin: "dnd-auto-notes://app",
      expectedFrameUrl: "dnd-auto-notes://app/index.html",
      ipcMain: ipc,
    });
    const result = await ipc.call(
      CHANNELS.settings.set,
      trustedEvent(),
      success({ key: "sessionsRoot", value: "~/sessions", extra: "rejected" }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "unknown_field" } });
    expect(result).not.toHaveProperty("error.stack");
  });

  it("requires exactly one wrapped request argument", async () => {
    const ipc = new FakeIpcMain();
    registerIpcHandlers({
      expectedSenderId: 7,
      expectedOrigin: "dnd-auto-notes://app",
      expectedFrameUrl: "dnd-auto-notes://app/index.html",
      ipcMain: ipc,
    });
    const direct = await ipc.call(CHANNELS.settings.get, trustedEvent(), {});
    expect(direct).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const multiple = await ipc.call(CHANNELS.settings.get, trustedEvent(), success({}), {});
    expect(multiple).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("rejects non-allow-listed settings keys at the main boundary", async () => {
    const ipc = new FakeIpcMain();
    registerIpcHandlers({
      expectedSenderId: 7,
      expectedOrigin: "dnd-auto-notes://app",
      expectedFrameUrl: "dnd-auto-notes://app/index.html",
      ipcMain: ipc,
      handlers: {
        settingsSet: ({ key, value }) => ({ key: key as SettingKey, value }),
      },
    });
    const result = await ipc.call(
      CHANNELS.settings.set,
      trustedEvent(),
      success({ key: "secrets.token", value: "never" }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "settings_key_not_allowed" } });
  });

  it("enforces request and response byte caps at the main boundary", async () => {
    const ipc = new FakeIpcMain();
    let settingsWrites = 0;
    registerIpcHandlers({
      expectedSenderId: 7,
      expectedOrigin: "dnd-auto-notes://app",
      expectedFrameUrl: "dnd-auto-notes://app/index.html",
      ipcMain: ipc,
      handlers: {
        settingsSet: ({ key, value }) => {
          settingsWrites += 1;
          return { key: key as SettingKey, value };
        },
        sessionsList: () => ({
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
      },
    });

    const oversizedRequest = await ipc.call(
      CHANNELS.settings.set,
      trustedEvent(),
      success({ key: "sessionsRoot", value: "x".repeat(IPC_LIMITS.maxRequestBytes) }),
    );
    expect(oversizedRequest).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
    expect(settingsWrites).toBe(0);

    const oversizedResponse = await ipc.call(CHANNELS.sessions.list, trustedEvent(), success({}));
    expect(oversizedResponse).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
  });

  it("validates handler responses before returning them", async () => {
    const ipc = new FakeIpcMain();
    registerIpcHandlers({
      expectedSenderId: 7,
      expectedOrigin: "dnd-auto-notes://app",
      expectedFrameUrl: "dnd-auto-notes://app/index.html",
      ipcMain: ipc,
      handlers: {
        settingsGet: () => ({ settings: {}, unexpected: true }) as never,
      },
    });
    const result = await ipc.call(CHANNELS.settings.get, trustedEvent(), success({}));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_response" } });
  });

  it("caps structured failures created by the outer handler catch", async () => {
    const ipc = new FakeIpcMain();
    registerIpcHandlers({
      expectedSenderId: 7,
      expectedOrigin: "dnd-auto-notes://app",
      expectedFrameUrl: "dnd-auto-notes://app/index.html",
      ipcMain: ipc,
      handlers: {
        settingsGet: () => {
          throw new ContractValidationError(ERROR_CODES.internal, "failed", {
            reason: "x".repeat(IPC_LIMITS.maxResponseBytes),
          });
        },
      },
    });
    const result = await ipc.call(CHANNELS.settings.get, trustedEvent(), success({}));
    expect(result).toEqual({
      ok: false,
      error: {
        code: "payload_too_large",
        message: "IPC error response exceeds its byte limit",
      },
    });
  });

  it("strips stack-like details from generated failures", async () => {
    const ipc = new FakeIpcMain();
    registerIpcHandlers({
      expectedSenderId: 7,
      expectedOrigin: "dnd-auto-notes://app",
      expectedFrameUrl: "dnd-auto-notes://app/index.html",
      ipcMain: ipc,
      handlers: {
        settingsGet: () => {
          throw new ContractValidationError(ERROR_CODES.internal, "failed", {
            stack: "secret stack",
            operation: "settings.get",
          });
        },
      },
    });
    const result = await ipc.call(CHANNELS.settings.get, trustedEvent(), success({}));
    expect(result).toEqual({
      ok: false,
      error: {
        code: "internal_error",
        message: "failed",
        details: { operation: "settings.get" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret stack");
  });

  it("sanitises push events before selecting the event channel", () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const target = {
      send(channel: string, payload: unknown): void {
        sent.push({ channel, payload });
      },
    };
    expect(
      sendOutboundEvent(target, {
        type: "log",
        sequence: 1,
        runId: "run-1",
        level: "info",
        message: "safe",
        raw_line: "private",
        internal_path: "C:\\private",
        command: "secret command",
        session_id: "s-1",
      }),
    ).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe(CHANNELS.runs.event);
    expect(JSON.stringify(sent[0]?.payload)).not.toContain("private");
    expect(JSON.stringify(sent[0]?.payload)).not.toContain("secret command");
    expect(JSON.stringify(sent[0]?.payload)).not.toContain("s-1");
  });

  it("canonicalizes valid events and drops invalid events or stacks", () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const target = {
      send(channel: string, payload: unknown): void {
        sent.push({ channel, payload });
      },
    };

    expect(
      sendOutboundEvent(target, {
        type: "stage_failed",
        sequence: 2,
        runId: "run-1",
        stage: "intake",
        error: { code: "internal_error", message: "failed", stack: "private stack" },
      }),
    ).toBe(true);
    expect(JSON.stringify(sent[0]?.payload)).not.toContain("private stack");

    expect(
      sendOutboundEvent(target, {
        type: "not_a_real_event",
        sequence: 3,
        runId: "run-1",
      }),
    ).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
