import { describe, expect, it, vi } from "vitest";
import { normalizeNdjson } from "./normalize.js";
import { CliProvider, resolveCliExecutable } from "./cli.js";
import { HttpLocalProvider } from "./http.js";
import { LlmResponseError, NoneProvider } from "./provider.js";
import { z } from "zod";

describe("LLM providers", () => {
  it("normalizes malformed and result NDJSON without throwing", () => {
    const normalized = normalizeNdjson(
      '{"type":"message","text":"partial"}\nnot-json\n{"type":"result","result":"{\\"ok\\":true}"}',
    );
    expect(normalized.result).toBe('{"ok":true}');
    expect(normalized.malformed).toBe(1);
  });

  it("none is explicit and CLI resolution is cached", async () => {
    const none = new NoneProvider();
    await expect(
      none.complete({ system: "", prompt: "", schema: z.object({}) }),
    ).rejects.toMatchObject({ code: "llm_unavailable" });
    const resolver = vi.fn(async () => null);
    expect(await resolveCliExecutable("claude", resolver)).toBe(null);
    expect(await resolveCliExecutable("claude", resolver)).toBe(null);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("validates local HTTP JSON responses", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":7}' } }] }), {
          status: 200,
        }),
    );
    const provider = new HttpLocalProvider({ baseUrl: "http://127.0.0.1:1234", fetch });
    await expect(
      provider.complete({ system: "", prompt: "", schema: z.object({ answer: z.number() }) }),
    ).resolves.toMatchObject({ value: { answer: 7 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-JSON CLI result without leaving a process contract ambiguous", async () => {
    const fake = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: {
        on: vi.fn((_event: string, callback: (chunk: Buffer) => void) => {
          callback(Buffer.from('{"type":"result","result":"not json"}\n'));
        }),
      },
      on: vi.fn((event: string, callback: (code: number) => void) => {
        if (event === "close") callback(0);
      }),
      kill: vi.fn(),
      killed: false,
    };
    const provider = new CliProvider("claude", {
      executable: "fake",
      spawnProcess: (() => fake) as never,
    });
    await expect(
      provider.complete({ system: "", prompt: "", schema: z.object({}) }),
    ).rejects.toBeInstanceOf(LlmResponseError);
  });

  it("escalates a hung CLI child after cancellation and rejects", async () => {
    const signals: string[] = [];
    const fake = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn((signal: string) => signals.push(signal)),
      killed: false,
    };
    const provider = new CliProvider("codex", {
      executable: "fake",
      cancellationTimeoutMs: 10,
      spawnProcess: (() => fake) as never,
    });
    const controller = new AbortController();
    const pending = provider.complete({
      system: "",
      prompt: "",
      schema: z.object({}),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "llm_unavailable" });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
