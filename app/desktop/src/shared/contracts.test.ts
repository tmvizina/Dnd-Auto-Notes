import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  ContractValidationError,
  assertOnlyKeys,
  sanitizeOutboundEvent,
  validateRequest,
  validateResponse,
  validateOutboundEvent,
  validateResponseEnvelope,
} from "./contracts.js";

describe("desktop IPC contracts", () => {
  it("keeps namespaced channels and limits immutable", () => {
    expect(Object.isFrozen(CHANNELS)).toBe(true);
    expect(Object.isFrozen(CHANNELS.sessions)).toBe(true);
    expect(Object.isFrozen(CHANNELS.pipeline)).toBe(true);
    expect(CHANNELS.sessions.list.split("/")).toEqual(["dnd", "sessions", "list"]);
  });

  it("rejects unknown request fields", () => {
    expect(() =>
      validateRequest(CHANNELS.settings.set, {
        key: "sessionsRoot",
        value: "~/sessions",
        typo: true,
      }),
    ).toThrowError(ContractValidationError);
  });

  it("allows a complete settings write only for an allow-listed key", () => {
    expect(
      validateRequest(CHANNELS.settings.set, {
        key: "sessionsRoot",
        value: "~/sessions",
      }),
    ).toEqual({ key: "sessionsRoot", value: "~/sessions" });
    expect(() =>
      validateRequest(CHANNELS.settings.set, {
        key: "credentials.apiKey",
        value: "secret",
      }),
    ).toThrowError(/not allowed/);
  });

  it("strips every internal field from an outbound event", () => {
    const sanitized = sanitizeOutboundEvent({
      type: "log",
      sequence: 1,
      runId: "run-1",
      level: "info",
      message: "safe",
      raw_line: "whispered raw process output",
      rawLines: ["raw"],
      path: "C:\\private\\session",
      internal_path: "/private/session",
      command: "pipeline --secret",
      command_string: "pipeline --secret",
      session_id: "s-1",
      sessionId: "s-1",
      nested: {
        filePath: "/private/nested",
        raw_text: "hidden",
        session: "s-1",
        value: "kept",
      },
    });

    expect(sanitized).not.toBeNull();
    expect(JSON.stringify(sanitized)).toContain("safe");
    for (const denied of ["raw", "private", "pipeline --secret", "s-1"]) {
      expect(JSON.stringify(sanitized)).not.toContain(denied);
    }
    expect(sanitized).toMatchObject({ type: "log", nested: { value: "kept" } });
  });

  it("fails safely for cycles and over-deep payloads", () => {
    const cyclic: Record<string, unknown> = { type: "log" };
    cyclic.self = cyclic;
    expect(sanitizeOutboundEvent(cyclic)).toBeNull();

    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 32; i += 1) deep = { child: deep };
    expect(sanitizeOutboundEvent(deep)).toBeNull();
  });

  it("does not accept stacks in an error envelope", () => {
    expect(() =>
      validateResponseEnvelope(CHANNELS.settings.get, {
        ok: false,
        error: { code: "internal_error", message: "failed", stack: "secret stack" },
      }),
    ).toThrowError(ContractValidationError);
    expect(() =>
      validateResponseEnvelope(CHANNELS.settings.get, {
        ok: false,
        error: {
          code: "internal_error",
          message: "failed",
          details: { stack_trace: "secret stack" },
        },
      }),
    ).toThrowError(ContractValidationError);
  });

  it("assertOnlyKeys reports the offending field", () => {
    expect(() =>
      assertOnlyKeys({ accepted: true, unexpected: 1 }, ["accepted"], "request"),
    ).toThrow("unexpected");
  });

  it("validates setup commands and bounded sidecar log requests", () => {
    expect(
      validateResponse(CHANNELS.sidecar.status, {
        status: "unavailable",
        reason: "environment missing",
        setupCommand: "uv venv .venv",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "environment missing",
      setupCommand: "uv venv .venv",
    });
    expect(validateRequest(CHANNELS.sidecar.logs, { maxLines: 20 })).toEqual({ maxLines: 20 });
    expect(validateResponse(CHANNELS.sidecar.logs, { lines: ["one", "two"] })).toEqual({
      lines: ["one", "two"],
    });
    expect(() => validateRequest(CHANNELS.sidecar.logs, { maxLines: 10_001 })).toThrow();
  });

  it("keeps setupCommand explicit on sanitized sidecar events", () => {
    expect(
      validateOutboundEvent({
        type: "sidecar_status",
        status: "unavailable",
        reason: "venv missing",
        setupCommand: "uv venv .venv",
      }),
    ).toEqual({
      type: "sidecar_status",
      status: "unavailable",
      reason: "venv missing",
      setupCommand: "uv venv .venv",
    });
    expect(() =>
      validateOutboundEvent({
        type: "sidecar_status",
        status: "unavailable",
        setupCommand: 42,
      }),
    ).toThrow();
  });

  it("validates streamed copy progress and explicit mapping operations", () => {
    expect(
      validateRequest(CHANNELS.sessions.copy, {
        sessionId: "2026-01-01-session",
        kind: "craig",
        sourcePath: "C:\\incoming\\recording.wav",
      }),
    ).toEqual({
      sessionId: "2026-01-01-session",
      kind: "craig",
      sourcePath: "C:\\incoming\\recording.wav",
    });
    expect(
      validateRequest(CHANNELS.sessions.mapping, {
        sessionId: "2026-01-01-session",
        decisions: [{ observed: "track-a", kind: "discord", playerId: null }],
      }),
    ).toEqual({
      sessionId: "2026-01-01-session",
      decisions: [{ observed: "track-a", kind: "discord", playerId: null }],
    });
    expect(
      validateOutboundEvent({
        type: "copy_progress",
        sequence: 1,
        runId: "copy-1",
        kind: "craig",
        progress: 0.5,
        bytesCopied: 50,
        totalBytes: 100,
        sourcePath: "private-path",
      }),
    ).toEqual({
      type: "copy_progress",
      sequence: 1,
      runId: "copy-1",
      kind: "craig",
      progress: 0.5,
      bytesCopied: 50,
      totalBytes: 100,
    });
  });
});
