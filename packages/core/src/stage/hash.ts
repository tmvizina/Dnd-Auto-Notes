import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

/** Streamed so a four-hour FLAC does not become a four-gigabyte Buffer. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function hashFileIfPresent(path: string): Promise<string | null> {
  try {
    await stat(path);
  } catch {
    return null;
  }
  return hashFile(path);
}

/**
 * Stable digest of a params object. Keys are sorted at every level, so a
 * re-ordered config is not mistaken for a changed one — the difference between
 * a free skip and a needless four-hour ASR run.
 */
export function hashParams(params: unknown): string {
  return createHash("sha256").update(canonicalise(params)).digest("hex");
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
  return `{${entries.join(",")}}`;
}
