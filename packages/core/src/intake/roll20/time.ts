import type { QaEntry } from "../../contracts/common.js";
import type { TimeBasis } from "../../contracts/manifest.js";
import type { NormalizedRoll20Input, Roll20Capture } from "./parser.js";

/** Firebase's push-id alphabet, in the order used by its base-64 timestamp. */
export const FIREBASE_PUSH_ALPHABET =
  "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

const PUSH_TIMESTAMP_LENGTH = 8;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
// A decoded push timestamp outside this range is almost certainly not a
// Firebase message id.  The bound is deliberately broad enough for archived
// campaigns without allowing random ids to masquerade as a wall clock.
const MIN_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

export interface Roll20RecordingWindow {
  /** Craig's recording start as an ISO timestamp. */
  readonly started_at?: string | null;
  /** A millisecond start is useful to callers that already parsed the info file. */
  readonly start_ms?: number | null;
  readonly duration_s?: number | null;
}

/** Options accepted by the detailed timing resolver. */
export interface ResolveRoll20TimeOptions extends Roll20RecordingWindow {
  readonly recording?: Roll20RecordingWindow | null;
  readonly window?: Roll20RecordingWindow | null;
  readonly recording_started_at?: string | null;
  readonly recording_start_ms?: number | null;
  readonly recording_duration_s?: number | null;
}

/** A capture record after timing has been recovered. */
export interface Roll20TimedRecord {
  readonly id: string | null;
  readonly seq: number;
  readonly t_wall_ms: number | null;
  /** Null when no trustworthy wall clock was recovered. */
  readonly t_audio_s: number | null;
  readonly [key: string]: unknown;
}

export interface Roll20TimeResolution {
  readonly basis: TimeBasis;
  /** Alias matching the manifest field name. */
  readonly time_basis: TimeBasis;
  /** Add this to wall-clock seconds to obtain recording-relative seconds. */
  readonly clock_offset_s: number | null;
  readonly recording_start_ms: number | null;
  readonly messages: readonly Roll20TimedRecord[];
  readonly turnorder_events: readonly Roll20TimedRecord[];
  readonly qa: readonly QaEntry[];
}

interface InputRecord {
  readonly value: Record<string, unknown>;
  readonly id: string | null;
  readonly seq: number;
  readonly tWallMs: number | null;
  readonly stream: "messages" | "turnorder_events";
  readonly index: number;
}

interface CaptureRecords {
  readonly messages: readonly InputRecord[];
  readonly turnorderEvents: readonly InputRecord[];
}

interface DecodedStream {
  readonly records: readonly InputRecord[];
  readonly decoded: readonly (number | null)[];
  readonly missing: boolean;
  readonly backwardAt: number | null;
}

interface RecordingWindow {
  readonly startMs: number | null;
  readonly durationS: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asInteger(value: unknown): number | null {
  const number = asFiniteNumber(value);
  return number === null ? null : Math.trunc(number);
}

function asNonEmptyString(value: unknown): string | null {
  let textValue: string;
  if (typeof value !== "string") {
    if (typeof value !== "number" && typeof value !== "boolean") return null;
    textValue = String(value);
  } else {
    textValue = value;
  }
  const text = textValue.trim();
  return text === "" ? null : text;
}

function firstValue(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function idFromRecord(record: Record<string, unknown>): string | null {
  const direct = asNonEmptyString(firstValue(record, ["id", "message_id", "messageid"]));
  if (direct !== null) return direct;

  // A few hand-saved captures retain only outerHTML.  Recovering the id here
  // keeps those captures useful without attempting to parse their markup.
  const raw = asNonEmptyString(firstValue(record, ["outerHTML", "outer_html", "raw"]));
  if (raw === null) return null;
  const match = /\bdata-message(?:id|-id)\s*=\s*(["'])(.*?)\1/iu.exec(raw);
  return match?.[2]?.trim() || null;
}

function wallMsFromRecord(record: Record<string, unknown>): number | null {
  const direct = asFiniteNumber(
    firstValue(record, ["t_wall_ms", "t_wall", "wall_ms", "timestamp", "time_ms"]),
  );
  if (direct !== null) return direct;

  const raw = asNonEmptyString(firstValue(record, ["outerHTML", "outer_html", "raw"]));
  if (raw === null) return null;
  const match =
    /\b(?:data-timestamp|data-time|data-wall-ms|data-wallclock|timestamp)\s*=\s*(["'])(.*?)\1/iu.exec(
      raw,
    );
  return asFiniteNumber(match?.[2]);
}

function sequenceFromRecord(record: Record<string, unknown>, fallback: number): number {
  const direct = asInteger(firstValue(record, ["seq", "sequence"]));
  if (direct !== null && direct >= 0) return direct;
  const raw = asNonEmptyString(firstValue(record, ["outerHTML", "outer_html", "raw"]));
  if (raw !== null) {
    const match = /\bdata-seq\s*=\s*(["'])(.*?)\1/iu.exec(raw);
    const fromMarkup = asInteger(match?.[2]);
    if (fromMarkup !== null && fromMarkup >= 0) return fromMarkup;
  }
  return fallback;
}

function recordsFrom(value: unknown, stream: InputRecord["stream"]): InputRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    if (record === null) return [];
    return [
      {
        value: record,
        id: idFromRecord(record),
        seq: sequenceFromRecord(record, index + 1),
        tWallMs: wallMsFromRecord(record),
        stream,
        index,
      },
    ];
  });
}

function captureRecords(capture: unknown): CaptureRecords {
  const root = asRecord(capture);
  if (root === null) return { messages: [], turnorderEvents: [] };
  return {
    messages: recordsFrom(root["messages"], "messages"),
    turnorderEvents: recordsFrom(root["turnorder_events"] ?? root["turnorder"], "turnorder_events"),
  };
}

function streamBySequence(records: readonly InputRecord[]): InputRecord[] {
  return [...records].sort((left, right) => left.seq - right.seq || left.index - right.index);
}

function decodePushTimestampPrefix(id: string): number | null {
  if (id.length < PUSH_TIMESTAMP_LENGTH) return null;
  let timestamp = 0;
  for (const character of id.slice(0, PUSH_TIMESTAMP_LENGTH)) {
    const digit = FIREBASE_PUSH_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    timestamp = timestamp * FIREBASE_PUSH_ALPHABET.length + digit;
  }
  return timestamp >= MIN_PLAUSIBLE_TIMESTAMP_MS && timestamp < MAX_PLAUSIBLE_TIMESTAMP_MS
    ? timestamp
    : null;
}

/** Decode the millisecond timestamp carried by a Firebase-style push id. */
export function decodeFirebasePushTimestamp(id: string): number | null {
  return decodePushTimestampPrefix(id.trim());
}

function decodeStream(records: readonly InputRecord[]): DecodedStream {
  const ordered = streamBySequence(records);
  const decoded = ordered.map((record) =>
    record.id === null ? null : decodePushTimestampPrefix(record.id),
  );
  const missing = ordered.length === 0 || decoded.some((value) => value === null);
  let backwardAt: number | null = null;
  if (!missing) {
    for (let index = 1; index < decoded.length; index += 1) {
      const previous = decoded[index - 1];
      const current = decoded[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        previous !== null &&
        current !== null &&
        current < previous
      ) {
        backwardAt = index;
        break;
      }
    }
  }
  return { records: ordered, decoded, missing, backwardAt };
}

function timeBasisDiagnostics(capture: unknown): {
  readonly basis: TimeBasis;
  readonly streams: readonly DecodedStream[];
} {
  const records = captureRecords(capture);
  const all = [...records.messages, ...records.turnorderEvents];
  if (all.some((record) => record.tWallMs !== null)) {
    return { basis: "wallclock", streams: [] };
  }

  const streams = [records.messages, records.turnorderEvents]
    .filter((stream) => stream.length > 0)
    .map(decodeStream);
  const complete = streams.length > 0 && streams.every((stream) => !stream.missing);
  const monotonic = complete && streams.every((stream) => stream.backwardAt === null);
  return { basis: monotonic ? "messageid" : "order_only", streams };
}

/**
 * Decide which clock is safe to use.  A live timestamp wins over all inferred
 * clocks; decoded ids are accepted only when every id is valid and monotonic.
 */
export function resolveTimeBasis(
  capture: Roll20Capture | NormalizedRoll20Input | unknown,
): TimeBasis {
  return timeBasisDiagnostics(capture).basis;
}

function parseIsoMs(value: unknown): number | null {
  const text = asNonEmptyString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordingWindow(input: unknown): RecordingWindow {
  const root = asRecord(input);
  if (root === null) return { startMs: null, durationS: null };
  const nested = asRecord(root["recording"] ?? root["window"]);
  const sources = nested === null ? [root] : [root, nested];
  let startMs: number | null = null;
  let durationS: number | null = null;
  for (const source of sources) {
    startMs =
      startMs ??
      asFiniteNumber(
        firstValue(source, ["recording_start_ms", "start_ms", "recordingStartedMs"]),
      ) ??
      parseIsoMs(firstValue(source, ["recording_started_at", "started_at", "startedAt"]));
    durationS =
      durationS ??
      asFiniteNumber(firstValue(source, ["recording_duration_s", "duration_s", "durationS"]));
  }
  return {
    startMs,
    durationS: durationS !== null && durationS >= 0 ? durationS : null,
  };
}

function timeForRecord(
  record: InputRecord,
  basis: TimeBasis,
  decoded: number | null,
  recordingStartMs: number | null,
): number | null {
  const wall = basis === "wallclock" ? record.tWallMs : basis === "messageid" ? decoded : null;
  if (wall === null || recordingStartMs === null) return null;
  // Do the subtraction before converting to seconds.  Millisecond values in
  // 2026 are exact integers, while subtracting two large floating-point
  // seconds would throw away useful sub-second precision.
  return (wall - recordingStartMs) / 1000;
}

function timedRecords(
  records: readonly InputRecord[],
  basis: TimeBasis,
  decodedByIndex: ReadonlyMap<number, number>,
  recordingStartMs: number | null,
): Roll20TimedRecord[] {
  return records.map((record) => {
    const decoded = decodedByIndex.get(record.index) ?? null;
    const wall = basis === "wallclock" ? record.tWallMs : basis === "messageid" ? decoded : null;
    return {
      ...record.value,
      id: record.id,
      seq: record.seq,
      t_wall_ms: wall,
      t_audio_s: timeForRecord(record, basis, decoded, recordingStartMs),
    };
  });
}

function decodedMap(stream: DecodedStream): ReadonlyMap<number, number> {
  const map = new Map<number, number>();
  for (const [index, value] of stream.records.entries()) {
    const decoded = stream.decoded[index];
    if (decoded !== undefined && decoded !== null) map.set(value.index, decoded);
  }
  return map;
}

function qaEntry(
  code: string,
  severity: QaEntry["severity"],
  message: string,
  subject?: string,
  hint?: string,
): QaEntry {
  return {
    code,
    severity,
    message,
    ...(subject === undefined ? {} : { subject }),
    ...(hint === undefined ? {} : { hint }),
  };
}

interface EffectiveTimeRecord {
  readonly record: InputRecord;
  readonly wallMs: number | null;
}

function windowQa(records: readonly EffectiveTimeRecord[], window: RecordingWindow): QaEntry[] {
  if (window.startMs === null) return [];
  const lower = window.startMs - FIVE_MINUTES_MS;
  const upper =
    window.durationS === null ? null : window.startMs + window.durationS * 1000 + FIVE_MINUTES_MS;
  const entries: QaEntry[] = [];
  for (const item of records) {
    const { record, wallMs } = item;
    if (wallMs === null) continue;
    const outside = wallMs < lower || (upper !== null && wallMs > upper);
    if (!outside) continue;
    const direction = wallMs < lower ? "before" : "after";
    entries.push(
      qaEntry(
        "ROLL20_WINDOW_MISMATCH",
        "warning",
        `Roll20 ${record.stream === "messages" ? "message" : "turn-order event"} ${record.id ?? `seq ${String(record.seq)}`} is ${direction} the Craig recording window`,
        record.id ?? `seq:${String(record.seq)}`,
        "Check that input/roll20 and input/craig belong to the same recording; events are retained without clamping",
      ),
    );
  }
  return entries;
}

function nonMonotonicQa(streams: readonly DecodedStream[]): QaEntry[] {
  const entries: QaEntry[] = [];
  for (const stream of streams) {
    if (stream.backwardAt === null) continue;
    const current = stream.records[stream.backwardAt];
    const previous = stream.records[stream.backwardAt - 1];
    if (current === undefined || previous === undefined) continue;
    entries.push(
      qaEntry(
        "ROLL20_MESSAGEID_NON_MONOTONIC",
        "warning",
        `decoded Roll20 message ids go backwards between ${previous.id ?? `seq ${String(previous.seq)}`} and ${current.id ?? `seq ${String(current.seq)}`}; using order_only`,
        current.id ?? `seq:${String(current.seq)}`,
        "Keep the capture ordering and let P2-09 align it without absolute timestamps",
      ),
    );
  }
  return entries;
}

/**
 * Recover timing for messages and turn-order events.
 *
 * `t_wall_ms` is deliberately nulled for an order-only result.  When a
 * recording start is available, `clock_offset_s` is still returned so callers
 * can persist the proposed clock relationship and refine it in P2-09.
 */
export function resolveRoll20Time(
  capture: Roll20Capture | NormalizedRoll20Input | unknown,
  options: ResolveRoll20TimeOptions | Roll20RecordingWindow | null = null,
): Roll20TimeResolution {
  const records = captureRecords(capture);
  const diagnostics = timeBasisDiagnostics(capture);
  const basis = diagnostics.basis;
  const window = recordingWindow(options);
  const clockOffsetS = window.startMs === null ? null : -window.startMs / 1000;

  // Streams are built in the same order as the non-empty source arrays.  Keep
  // the lookup keyed by stream kind so independent sequence counters used by
  // the browser capture script cannot shift timestamps onto another stream.
  const streamFor = (kind: InputRecord["stream"]): DecodedStream | null =>
    diagnostics.streams.find((stream) => stream.records[0]?.stream === kind) ?? null;
  const messageStream = streamFor("messages");
  const turnStream = streamFor("turnorder_events");
  const messageDecoded =
    messageStream === null ? new Map<number, number>() : decodedMap(messageStream);
  const turnDecoded = turnStream === null ? new Map<number, number>() : decodedMap(turnStream);

  const qa: QaEntry[] = [];
  if (basis === "order_only") {
    qa.push(
      qaEntry(
        "TIME_BASIS_ORDER_ONLY",
        "info",
        "Roll20 absolute time was not trusted; capture order remains available for alignment",
        undefined,
        "P2-09 will align ordered Roll20 events to the transcript without a wall clock",
      ),
    );
    qa.push(...nonMonotonicQa(diagnostics.streams));
  }

  const all = [...records.messages, ...records.turnorderEvents];
  const decodedForMessages = basis === "messageid" ? messageDecoded : new Map<number, number>();
  const decodedForTurns = basis === "messageid" ? turnDecoded : new Map<number, number>();
  const messages = timedRecords(records.messages, basis, decodedForMessages, window.startMs);
  const turnorderEvents = timedRecords(
    records.turnorderEvents,
    basis,
    decodedForTurns,
    window.startMs,
  );
  if (basis === "wallclock" || basis === "messageid") {
    const effective = all.map((record) => ({
      record,
      wallMs:
        basis === "wallclock"
          ? record.tWallMs
          : ((record.stream === "messages" ? messageDecoded : turnDecoded).get(record.index) ??
            null),
    }));
    qa.push(...windowQa(effective, window));
  }

  return {
    basis,
    time_basis: basis,
    clock_offset_s: clockOffsetS,
    recording_start_ms: window.startMs,
    messages,
    turnorder_events: turnorderEvents,
    qa,
  };
}

/** Plural alias used by stage callers that process both event collections. */
export const resolveRoll20Times = resolveRoll20Time;

/** Convert a wall-clock millisecond value using a Craig start timestamp. */
export function wallClockToAudioSeconds(tWallMs: number, recordingStartMs: number): number {
  return (tWallMs - recordingStartMs) / 1000;
}
