export type NormalizedStreamEvent =
  | { readonly type: "result"; readonly text: string; readonly usage?: LlmUsage }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "malformed"; readonly line: string; readonly reason: string };

export interface LlmUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>)["text"] === "string"
          ? (part as Record<string, unknown>)["text"]
          : "",
      )
      .join("");
    return text === "" ? null : text;
  }
  return null;
}

export function normalizeStreamLine(line: string): NormalizedStreamEvent {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object")
      return { type: "malformed", line, reason: "event is not an object" };
    const record = value as Record<string, unknown>;
    const type = record["type"];
    const result = textFrom(record["result"]) ?? textFrom(record["text"]);
    if (type === "result" || type === "assistant" || type === "message_stop") {
      if (result === null) return { type: "malformed", line, reason: "result event has no text" };
      const usage = usageFrom(record["usage"]);
      return usage === undefined
        ? { type: "result", text: result }
        : { type: "result", text: result, usage };
    }
    if (result !== null) return { type: "message", text: result };
    return { type: "malformed", line, reason: "event has no supported text" };
  } catch {
    return { type: "malformed", line, reason: "invalid JSON" };
  }
}

function usageFrom(value: unknown): LlmUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const input = typeof record["input_tokens"] === "number" ? record["input_tokens"] : undefined;
  const output = typeof record["output_tokens"] === "number" ? record["output_tokens"] : undefined;
  return input === undefined && output === undefined
    ? undefined
    : {
        ...(input === undefined ? {} : { input_tokens: input }),
        ...(output === undefined ? {} : { output_tokens: output }),
      };
}

export function normalizeNdjson(text: string): {
  readonly events: readonly NormalizedStreamEvent[];
  readonly result: string | null;
  readonly malformed: number;
} {
  const events = text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map(normalizeStreamLine);
  const result =
    [...events]
      .reverse()
      .find(
        (event): event is Extract<NormalizedStreamEvent, { type: "result" }> =>
          event.type === "result",
      )?.text ?? null;
  return { events, result, malformed: events.filter((event) => event.type === "malformed").length };
}
