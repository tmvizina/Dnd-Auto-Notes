import { readFile } from "node:fs/promises";

/**
 * `info.txt` is the only place Craig writes Discord *user ids*, and a user id
 * is the one binding key that cannot be wrong — display names change, ids do
 * not. It is also the only source for the recording's wall-clock start.
 *
 * Craig has emitted several layouts over the years and a human may have
 * hand-edited the file, so every field is optional and nothing here throws.
 * A missing `info.txt` degrades binding to filename matching, which still works.
 */

export interface CraigParticipant {
  /** Track number this participant's audio was written to, when stated. */
  readonly index: number | null;
  readonly username: string;
  readonly discriminator: string | null;
  /** The Discord snowflake. Exact-matched against `players.json` first. */
  readonly userId: string | null;
}

export interface CraigInfo {
  /** ISO 8601, or null when absent or unparseable. Never a guessed time. */
  readonly startedAt: string | null;
  readonly guild: string | null;
  readonly channel: string | null;
  readonly participants: CraigParticipant[];
  /** Lines that looked like content but matched nothing, for the QA hint. */
  readonly unparsed: string[];
}

export const EMPTY_INFO: CraigInfo = Object.freeze({
  startedAt: null,
  guild: null,
  channel: null,
  participants: [],
  unparsed: [],
});

/** Craig has spelled the start time at least these three ways. */
const START_KEYS = new Set(["start time", "started", "start", "recording started"]);
const GUILD_KEYS = new Set(["guild", "server"]);
const CHANNEL_KEYS = new Set(["channel", "voice channel"]);

/** A Discord snowflake: 17-20 digits, and never confusable with a track index. */
const SNOWFLAKE = /\((\d{17,20})\)\s*$/;

/** Legacy `name#1234`, which Craig still writes for accounts that predate the change. */
const DISCRIMINATOR = /#(\d{4})\s*$/;

function parseTimestamp(value: string): string | null {
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * A participant line is `<index>: <name> (<id>)` in the modern layout and a
 * bare indented `<name> (<id>)` in the older one. Both parse; either half may
 * be missing.
 */
function parseParticipant(line: string): CraigParticipant | null {
  let rest = line.trim();
  if (rest === "") return null;

  let index: number | null = null;
  const indexed = /^(\d{1,4})\s*[:.)-]\s*(.+)$/s.exec(rest);
  if (indexed !== null) {
    index = Number.parseInt(indexed[1] ?? "", 10);
    rest = (indexed[2] ?? "").trim();
  }

  let userId: string | null = null;
  const snowflake = SNOWFLAKE.exec(rest);
  if (snowflake !== null) {
    userId = snowflake[1] ?? null;
    rest = rest.slice(0, rest.length - snowflake[0].length).trim();
  }

  let discriminator: string | null = null;
  const discriminated = DISCRIMINATOR.exec(rest);
  if (discriminated !== null) {
    discriminator = discriminated[1] ?? null;
    rest = rest.slice(0, rest.length - discriminated[0].length).trim();
  }

  // Without a name there is nothing to bind on, and an id-only row would match
  // every player equally under fuzzy scoring.
  if (rest === "" && userId === null) return null;

  return { index, username: rest, discriminator, userId };
}

export function parseInfoText(text: string): CraigInfo {
  const lines = text.split(/\r?\n/);

  let startedAt: string | null = null;
  let guild: string | null = null;
  let channel: string | null = null;
  const participants: CraigParticipant[] = [];
  const unparsed: string[] = [];

  // Everything after a "Tracks:" / "Channels:" heading is a participant list,
  // even when a row happens to contain a colon of its own.
  let inParticipants = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;

    const heading = /^\s*(tracks|channels|users|participants)\s*:\s*(\d+)?\s*$/i.exec(line);
    if (heading !== null) {
      inParticipants = true;
      continue;
    }

    const indented = /^[\t ]+\S/.test(raw);
    if (inParticipants && indented) {
      const participant = parseParticipant(line);
      if (participant === null) unparsed.push(line.trim());
      else participants.push(participant);
      continue;
    }

    const keyed = /^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/.exec(line);
    if (keyed === null) {
      // An indented row under a heading Craig spelled differently is still a
      // participant; anything else is genuinely unrecognised.
      if (indented) {
        const participant = parseParticipant(line);
        if (participant !== null) {
          participants.push(participant);
          continue;
        }
      }
      unparsed.push(line.trim());
      continue;
    }

    inParticipants = false;
    const key = (keyed[1] ?? "").trim().toLowerCase();
    const value = (keyed[2] ?? "").trim();
    if (value === "") continue;

    if (START_KEYS.has(key)) startedAt = startedAt ?? parseTimestamp(value);
    else if (GUILD_KEYS.has(key)) guild = guild ?? value;
    else if (CHANNEL_KEYS.has(key)) channel = channel ?? value;
    else unparsed.push(line.trim());
  }

  return { startedAt, guild, channel, participants, unparsed };
}

/** Returns `EMPTY_INFO` when the file is missing — its absence is not an error. */
export async function readInfoFile(path: string): Promise<CraigInfo> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return EMPTY_INFO;
  }
  return parseInfoText(text);
}
