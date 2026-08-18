import { open } from "node:fs/promises";

export const DEFAULT_LOG_TAIL_LINES = 200;
export const DEFAULT_LOG_TAIL_BYTES = 512 * 1024;
const MAX_LOG_TAIL_BYTES = 8 * 1024 * 1024;

function boundedCount(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function boundedBytes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOG_TAIL_BYTES;
  return Math.min(MAX_LOG_TAIL_BYTES, Math.max(0, Math.floor(value)));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Read only a bounded suffix of a log.  Sidecar logs are rotated by the core
 * supervisor, but this second bound keeps a troubleshooting request cheap if
 * a user supplies a very large historical file.
 */
export async function readLogTail(
  logPath: string,
  maxLines = DEFAULT_LOG_TAIL_LINES,
  maxBytes = DEFAULT_LOG_TAIL_BYTES,
): Promise<readonly string[]> {
  const lineLimit = boundedCount(maxLines, DEFAULT_LOG_TAIL_LINES);
  const byteLimit = boundedBytes(maxBytes);
  if (lineLimit === 0 || byteLimit === 0) return [];

  let handle;
  try {
    handle = await open(logPath, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }

  try {
    const stats = await handle.stat();
    const offset = Math.max(0, stats.size - byteLimit);
    const length = Math.max(0, stats.size - offset);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, offset);
    const text = buffer.subarray(0, result.bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-lineLimit);
  } finally {
    await handle.close();
  }
}

/** Small object form useful for dependency injection in main-process handlers. */
export class SidecarLogTail {
  constructor(readonly logPath: string) {}

  read(
    maxLines = DEFAULT_LOG_TAIL_LINES,
    maxBytes = DEFAULT_LOG_TAIL_BYTES,
  ): Promise<readonly string[]> {
    return readLogTail(this.logPath, maxLines, maxBytes);
  }
}
