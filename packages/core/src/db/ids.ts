import { randomBytes } from "node:crypto";

/**
 * Prefixed ids, so a stray one is identifiable on sight in a log or an error
 * message. Twelve hex characters is 48 bits — ample for a personal campaign
 * archive and short enough to read aloud.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export const ID_PATTERN = /^[a-z_]+_[a-f0-9]{12}$/;
