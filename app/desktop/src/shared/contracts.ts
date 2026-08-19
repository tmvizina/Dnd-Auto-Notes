/**
 * The renderer boundary is deliberately boring: this file is the one source
 * of channel names, wire DTOs, limits, and validation rules.  Keep it free of
 * Electron imports so it can be exercised in a plain Node test process.
 */

interface PlainRecord {
  readonly [key: string]: unknown;
  readonly ok?: unknown;
  readonly value?: unknown;
  readonly error?: unknown;
  readonly code?: unknown;
  readonly number?: unknown;
  readonly durationS?: unknown;
  readonly hasNotes?: unknown;
  readonly sessionId?: unknown;
  readonly title?: unknown;
  readonly date?: unknown;
  readonly status?: unknown;
  readonly grade?: unknown;
  readonly type?: unknown;
  readonly sequence?: unknown;
  readonly runId?: unknown;
  readonly stage?: unknown;
  readonly at?: unknown;
  readonly progress?: unknown;
  readonly message?: unknown;
  readonly level?: unknown;
  readonly details?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
  readonly stages?: unknown;
  readonly force?: unknown;
  readonly reason?: unknown;
  readonly setupCommand?: unknown;
  readonly maxLines?: unknown;
  readonly lines?: unknown;
  readonly subscriptionId?: unknown;
  readonly key?: unknown;
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly timeoutMs?: unknown;
  readonly latencyMs?: unknown;
  readonly models?: unknown;
  readonly revealed?: unknown;
  readonly capabilities?: unknown;
  readonly settings?: unknown;
  readonly sessions?: unknown;
  readonly nextCursor?: unknown;
  readonly session?: unknown;
  readonly cancelled?: unknown;
  readonly replay?: unknown;
  readonly replayCursor?: unknown;
  readonly replayTruncated?: unknown;
  readonly unsubscribed?: unknown;
  readonly copyId?: unknown;
  readonly destinationName?: unknown;
  readonly kind?: unknown;
  readonly sourcePath?: unknown;
  readonly entries?: unknown;
  readonly severity?: unknown;
  readonly hint?: unknown;
  readonly subject?: unknown;
  readonly suggestions?: unknown;
  readonly observed?: unknown;
  readonly exact?: unknown;
  readonly candidates?: unknown;
  readonly playerId?: unknown;
  readonly displayName?: unknown;
  readonly score?: unknown;
  readonly matchedOn?: unknown;
  readonly decisions?: unknown;
  readonly saved?: unknown;
  readonly craig?: unknown;
  readonly roll20?: unknown;
  readonly paths?: unknown;
  readonly bytesCopied?: unknown;
  readonly totalBytes?: unknown;
  readonly fraction?: unknown;
  readonly action?: unknown;
  readonly utteranceId?: unknown;
  readonly label?: unknown;
  readonly characterId?: unknown;
  readonly clusterId?: unknown;
  readonly journalId?: unknown;
  readonly utteranceIds?: unknown;
  readonly flags?: unknown;
  readonly impactS?: unknown;
  readonly timestampS?: unknown;
  readonly speaker?: unknown;
  readonly text?: unknown;
  readonly evidence?: unknown;
  readonly rerunSuggested?: unknown;
  readonly count?: unknown;
  readonly reverted?: unknown;
  readonly path?: unknown;
}

const isRecord = (value: unknown): value is PlainRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as PlainRecord)) deepFreeze(child);
  return value;
}

const CHANNEL_VALUES = {
  sessions: {
    list: "dnd/sessions/list",
    get: "dnd/sessions/get",
    create: "dnd/sessions/create",
    copy: "dnd/sessions/copy",
    reveal: "dnd/sessions/reveal",
    qa: "dnd/sessions/qa",
    mapping: "dnd/sessions/mapping",
  },
  review: {
    list: "dnd/review/list",
    resolve: "dnd/review/resolve",
    bulk: "dnd/review/bulk",
    revert: "dnd/review/revert",
    rerun: "dnd/review/rerun",
    clip: "dnd/review/clip",
  },
  pipeline: {
    run: "dnd/pipeline/run",
    cancel: "dnd/pipeline/cancel",
  },
  runs: {
    subscribe: "dnd/runs/subscribe",
    unsubscribe: "dnd/runs/unsubscribe",
    event: "dnd/runs/event",
  },
  settings: {
    get: "dnd/settings/get",
    set: "dnd/settings/set",
    reveal: "dnd/settings/reveal",
    testConnection: "dnd/settings/test-connection",
  },
  sidecar: {
    status: "dnd/sidecar/status",
    logs: "dnd/sidecar/logs",
  },
} as const;

/** Every IPC channel must be selected from this frozen namespace. */
export const IPC_CHANNELS = deepFreeze(CHANNEL_VALUES);

/** Short alias used by the preload and main implementations. */
export const CHANNELS = IPC_CHANNELS;

export type IpcChannel =
  (typeof CHANNEL_VALUES)[keyof typeof CHANNEL_VALUES][keyof (typeof CHANNEL_VALUES)[keyof typeof CHANNEL_VALUES]];

/** Hard limits protect both the structured-clone boundary and renderer memory. */
const LIMIT_VALUES = {
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxStringLength: 64 * 1024,
  maxArrayLength: 10_000,
  maxObjectKeys: 2_000,
  maxDepth: 16,
  maxEventDepth: 12,
  maxReplayEvents: 512,
  maxSubscriptions: 64,
} as const;

export const IPC_LIMITS = deepFreeze(LIMIT_VALUES);
export const LIMITS = IPC_LIMITS;

/** Byte caps are measured after JSON encoding, not by JavaScript code units. */
export function serializedByteLength(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalid(ERROR_CODES.payloadCyclic, "payload could not be serialised");
  }
  if (encoded === undefined)
    throw invalid(ERROR_CODES.invalidValue, "payload could not be serialised");
  return new TextEncoder().encode(encoded).byteLength;
}

export function assertSerializedBytes(value: unknown, maxBytes: number, context = "payload"): void {
  assertSafePayload(value);
  const bytes = serializedByteLength(value);
  if (bytes > maxBytes)
    throw invalid(ERROR_CODES.payloadTooLarge, `${context} exceeds its byte limit`, {
      bytes,
      limit: maxBytes,
    });
}

const ERROR_CODE_VALUES = {
  invalidRequest: "invalid_request",
  invalidResponse: "invalid_response",
  unknownField: "unknown_field",
  invalidValue: "invalid_value",
  payloadTooLarge: "payload_too_large",
  payloadTooDeep: "payload_too_deep",
  payloadCyclic: "payload_cyclic",
  forbiddenSender: "forbidden_sender",
  forbiddenFrame: "forbidden_frame",
  settingsKeyNotAllowed: "settings_key_not_allowed",
  unavailable: "unavailable",
  notImplemented: "not_implemented",
  internal: "internal_error",
  eventRejected: "event_rejected",
} as const;

export const ERROR_CODES = deepFreeze(ERROR_CODE_VALUES);

export type StructuredErrorCode =
  (typeof ERROR_CODE_VALUES)[keyof typeof ERROR_CODE_VALUES] | (string & {});

export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

/** Errors crossing IPC intentionally have no stack or arbitrary error object. */
export interface StructuredError {
  readonly code: StructuredErrorCode;
  readonly message: string;
  readonly details?: ErrorDetails;
}

export interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly value: T;
}

export interface FailureEnvelope {
  readonly ok: false;
  readonly error: StructuredError;
}

export type IpcEnvelope<T> = SuccessEnvelope<T> | FailureEnvelope;

export function success<T>(value: T): SuccessEnvelope<T> {
  return { ok: true, value };
}

export function failure(error: StructuredError): FailureEnvelope {
  return { ok: false, error };
}

export function structuredError(
  code: StructuredErrorCode,
  message: string,
  details?: ErrorDetails,
): StructuredError {
  const result: { code: StructuredErrorCode; message: string; details?: ErrorDetails } = {
    code,
    message: message.slice(0, IPC_LIMITS.maxStringLength),
  };
  if (details !== undefined) {
    const safeDetails: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(details)) {
      if (
        key
          .replace(/[^a-z0-9]/gi, "")
          .toLowerCase()
          .includes("stack")
      )
        continue;
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        safeDetails[key] = value;
    }
    if (Object.keys(safeDetails).length > 0) result.details = safeDetails;
  }
  return result;
}

/** A typed local validation error; callers turn it into a stack-free DTO. */
export class ContractValidationError extends Error {
  readonly code: StructuredErrorCode;
  readonly details?: ErrorDetails;

  constructor(code: StructuredErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "ContractValidationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invalid(
  code: StructuredErrorCode,
  message: string,
  details?: ErrorDetails,
): ContractValidationError {
  return new ContractValidationError(code, message, details);
}

/** Reject unknown keys rather than silently dropping a renderer typo. */
export function assertOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[],
  context = "value",
): asserts value is PlainRecord {
  if (!isRecord(value)) throw invalid(ERROR_CODES.invalidRequest, `${context} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(ERROR_CODES.unknownField, `${context} contains unknown field "${key}"`, {
        field: key,
      });
    }
  }
}

const objectKeys = (value: PlainRecord): string[] => {
  try {
    return Object.keys(value);
  } catch {
    throw invalid(ERROR_CODES.invalidRequest, "value could not be inspected");
  }
};

/** Check a value before invoking or serialising it, including cycle/depth guards. */
export function assertSafePayload(
  value: unknown,
  maxDepth = IPC_LIMITS.maxDepth,
  maxStringLength = IPC_LIMITS.maxStringLength,
): void {
  const active = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > maxDepth)
      throw invalid(ERROR_CODES.payloadTooDeep, "payload exceeds the depth limit");
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "string") {
      if (candidate.length > maxStringLength)
        throw invalid(ERROR_CODES.payloadTooLarge, "payload contains an oversized string");
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        throw invalid(ERROR_CODES.invalidValue, "payload contains a non-finite number");
      return;
    }
    if (typeof candidate !== "object")
      throw invalid(ERROR_CODES.invalidValue, "payload contains a non-serialisable value");
    if (active.has(candidate)) throw invalid(ERROR_CODES.payloadCyclic, "payload contains a cycle");
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > IPC_LIMITS.maxArrayLength)
          throw invalid(ERROR_CODES.payloadTooLarge, "payload contains an oversized array");
        for (const child of candidate) visit(child, depth + 1);
      } else {
        const record = candidate as PlainRecord;
        const keys = objectKeys(record);
        if (keys.length > IPC_LIMITS.maxObjectKeys)
          throw invalid(ERROR_CODES.payloadTooLarge, "payload contains too many fields");
        for (const key of keys) {
          if (key.length > 256)
            throw invalid(ERROR_CODES.payloadTooLarge, "payload contains an oversized field name");
          let child: unknown;
          try {
            child = record[key];
          } catch {
            throw invalid(ERROR_CODES.invalidValue, "payload contains an unreadable field");
          }
          visit(child, depth + 1);
        }
      }
    } finally {
      active.delete(candidate);
    }
  };
  visit(value, 0);
}

function parseObject(value: unknown, allowedKeys: readonly string[], context: string): PlainRecord {
  assertSafePayload(value);
  assertOnlyKeys(value, allowedKeys, context);
  return value;
}

function requiredString(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw invalid(ERROR_CODES.invalidValue, `${field} must be a non-empty string`, { field });
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw invalid(ERROR_CODES.invalidValue, `${field} must be a boolean`, { field });
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = 1_000_000,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
    throw invalid(ERROR_CODES.invalidValue, `${field} must be an integer in range`, { field });
  return value;
}

function requiredInteger(value: unknown, field: string, minimum = 0, maximum = 1_000_000): number {
  const parsed = optionalInteger(value, field, minimum, maximum);
  if (parsed === undefined)
    throw invalid(ERROR_CODES.invalidValue, `${field} is required`, { field });
  return parsed;
}

const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function sessionId(value: unknown, field = "sessionId"): string {
  const parsed = requiredString(value, field, 128);
  if (!SESSION_ID.test(parsed))
    throw invalid(ERROR_CODES.invalidValue, `${field} has an invalid format`, { field });
  return parsed;
}

function runId(value: unknown, field = "runId"): string {
  const parsed = requiredString(value, field, 128);
  if (!RUN_ID.test(parsed))
    throw invalid(ERROR_CODES.invalidValue, `${field} has an invalid format`, { field });
  return parsed;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly number: number | null;
  readonly date: string;
  readonly durationS: number | null;
  readonly status: string;
  readonly grade: string | null;
  readonly hasNotes: boolean;
}

export interface SessionsListRequest {
  readonly status?: string;
  readonly grade?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SessionsListResponse {
  readonly sessions: readonly SessionSummary[];
  readonly nextCursor?: string;
}

export interface SessionsGetRequest {
  readonly sessionId: string;
}

export interface SessionsGetResponse {
  readonly session: SessionSummary | null;
  readonly paths?: SessionDropPaths;
}

export interface SessionsCreateRequest {
  readonly sessionId: string;
  readonly title: string;
  readonly number?: number | null;
  readonly date: string;
}

export interface SessionsCreateResponse {
  readonly session: SessionSummary;
  readonly paths?: SessionDropPaths;
}

export type SessionDropKind = "craig" | "roll20";

export interface SessionDropPaths {
  readonly craig: string;
  readonly roll20: string;
}

export interface SessionsCopyRequest {
  readonly sessionId: string;
  readonly kind: SessionDropKind;
  readonly sourcePath: string;
}

export interface SessionsCopyResponse {
  readonly copyId: string;
  readonly destinationName: string;
}

export interface SessionsRevealRequest {
  readonly sessionId: string;
  readonly kind: SessionDropKind;
}

export interface SessionsRevealResponse {
  readonly revealed: boolean;
}

export interface IntakeQaEntry {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly subject?: string;
  readonly hint?: string;
}

export interface MappingCandidate {
  readonly playerId: string;
  readonly displayName: string;
  readonly score: number;
  readonly matchedOn: string;
}

export interface MappingSuggestion {
  readonly observed: string;
  readonly kind: "discord" | "roll20";
  readonly exact: string | null;
  readonly candidates: readonly MappingCandidate[];
}

export interface SessionsQaRequest {
  readonly sessionId: string;
}

export interface SessionsQaResponse {
  readonly entries: readonly IntakeQaEntry[];
  readonly grade: string | null;
  readonly suggestions: readonly MappingSuggestion[];
}

export interface SessionsMappingDecision {
  readonly observed: string;
  readonly kind: "discord" | "roll20";
  readonly playerId: string | null;
}

export interface SessionsMappingRequest {
  readonly sessionId: string;
  readonly decisions: readonly SessionsMappingDecision[];
}

export interface SessionsMappingResponse {
  readonly saved: boolean;
}

export interface ReviewCandidate {
  readonly label: string;
  readonly characterId: string | null;
  readonly score: number;
}
export interface ReviewFlag {
  readonly utteranceId: string;
  readonly code: string;
  readonly impactS: number;
  readonly timestampS: number;
  readonly speaker: string;
  readonly text: string;
  readonly candidates: readonly ReviewCandidate[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly clusterId: string | null;
}
export interface ReviewListRequest {
  readonly sessionId: string;
}
export interface ReviewListResponse {
  readonly flags: readonly ReviewFlag[];
}
export type ReviewAction = "candidate" | "character" | "out_of_character" | "unresolvable";
export interface ReviewResolveRequest {
  readonly sessionId: string;
  readonly utteranceId: string;
  readonly action: ReviewAction;
  readonly label?: string;
  readonly characterId?: string | null;
}
export interface ReviewResolveResponse {
  readonly saved: boolean;
  readonly rerunSuggested: boolean;
  readonly journalId?: string;
}
export interface ReviewBulkRequest {
  readonly sessionId: string;
  readonly clusterId: string;
  readonly action: ReviewAction;
  readonly label?: string;
  readonly characterId?: string | null;
}
export interface ReviewBulkResponse {
  readonly saved: boolean;
  readonly count: number;
  readonly rerunSuggested: boolean;
}
export interface ReviewRevertRequest {
  readonly sessionId: string;
  readonly journalId: string;
}
export interface ReviewRevertResponse {
  readonly reverted: boolean;
}
export interface ReviewRerunRequest {
  readonly sessionId: string;
  readonly utteranceIds: readonly string[];
}
export interface ReviewRerunResponse {
  readonly runId: string;
}
export interface ReviewClipRequest {
  readonly sessionId: string;
  readonly utteranceId: string;
}
export interface ReviewClipResponse {
  readonly path: string;
}

export interface PipelineRunRequest {
  readonly sessionId: string;
  readonly stages?: readonly string[];
  readonly force?: boolean;
}

export interface PipelineRunResponse {
  readonly runId: string;
}

export interface PipelineCancelRequest {
  readonly runId: string;
  readonly reason?: string;
}

export interface PipelineCancelResponse {
  readonly cancelled: boolean;
}

export interface RunsSubscribeRequest {
  readonly runId: string;
  readonly cursor?: number;
}

export interface RunsUnsubscribeRequest {
  readonly subscriptionId: string;
}

export interface RunsUnsubscribeResponse {
  readonly unsubscribed: boolean;
}

export interface StageStartedEvent {
  readonly type: "stage_started";
  readonly sequence: number;
  readonly runId: string;
  readonly stage: string;
  readonly at: string;
}

export interface StageProgressEvent {
  readonly type: "stage_progress";
  readonly sequence: number;
  readonly runId: string;
  readonly stage: string;
  readonly progress: number;
  readonly message?: string;
}

export interface CopyProgressEvent {
  readonly type: "copy_progress";
  readonly sequence: number;
  readonly runId: string;
  readonly kind: SessionDropKind;
  readonly progress: number;
  readonly bytesCopied: number;
  readonly totalBytes: number;
  readonly message?: string;
}

export interface StageSkippedEvent {
  readonly type: "stage_skipped";
  readonly sequence: number;
  readonly runId: string;
  readonly stage: string;
}

export interface StageCompletedEvent {
  readonly type: "stage_completed";
  readonly sequence: number;
  readonly runId: string;
  readonly stage: string;
  readonly durationS?: number;
}

export interface StageFailedEvent {
  readonly type: "stage_failed";
  readonly sequence: number;
  readonly runId: string;
  readonly stage: string;
  readonly error: StructuredError;
}

export interface RunCompletedEvent {
  readonly type: "run_completed";
  readonly sequence: number;
  readonly runId: string;
}

export interface RunFailedEvent {
  readonly type: "run_failed";
  readonly sequence: number;
  readonly runId: string;
  readonly error: StructuredError;
}

export interface RunLogEvent {
  readonly type: "log";
  readonly sequence: number;
  readonly runId: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export type RunEvent =
  | StageStartedEvent
  | StageProgressEvent
  | CopyProgressEvent
  | StageSkippedEvent
  | StageCompletedEvent
  | StageFailedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunLogEvent;

export interface SidecarStatusEvent {
  readonly type: "sidecar_status";
  readonly status: "stopped" | "starting" | "ready" | "unhealthy" | "unavailable";
  readonly reason?: string;
  readonly setupCommand?: string;
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

export type DesktopEvent = RunEvent | SidecarStatusEvent;

export interface RunsSubscribeResponse {
  readonly subscriptionId: string;
  readonly replay: readonly RunEvent[];
  readonly replayCursor: number;
  readonly replayTruncated: boolean;
}

export const SETTING_KEYS = deepFreeze([
  "sessionsRoot",
  "campaignRoot",
  "sidecarPath",
  "provider",
  "providerModel",
  "providerPermissionMode",
  "localEndpoint",
  "asrBackend",
  "asrModel",
  "asrLanguage",
  "asrGlossaryEnabled",
  "personaThresholds",
] as const);

export type SettingKey = (typeof SETTING_KEYS)[number];

export const PATH_SETTING_KEYS = deepFreeze([
  "sessionsRoot",
  "campaignRoot",
  "sidecarPath",
] as const);

export type PathSettingKey = (typeof PATH_SETTING_KEYS)[number];

export interface SettingsGetResponse {
  readonly settings: Readonly<Partial<Record<SettingKey, string>>>;
}

export interface SettingsSetRequest {
  readonly key: string;
  readonly value: string;
}

export interface SettingsSetResponse {
  readonly key: SettingKey;
  readonly value: string;
}

export interface SettingsRevealRequest {
  readonly key: string;
}

export interface SettingsRevealResponse {
  readonly key: PathSettingKey;
  readonly revealed: boolean;
}

export interface SettingsTestConnectionRequest {
  readonly baseUrl: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface SettingsTestConnectionResponse {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly models: readonly string[];
  readonly message: string;
}

export interface SidecarStatusResponse {
  readonly status: SidecarStatusEvent["status"];
  readonly reason?: string;
  readonly setupCommand?: string;
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

export interface SidecarLogsRequest {
  readonly maxLines?: number;
}

export interface SidecarLogsResponse {
  readonly lines: readonly string[];
}

export interface IpcRequestMap {
  sessionsList: SessionsListRequest;
  sessionsGet: SessionsGetRequest;
  sessionsCreate: SessionsCreateRequest;
  sessionsCopy: SessionsCopyRequest;
  sessionsReveal: SessionsRevealRequest;
  sessionsQa: SessionsQaRequest;
  sessionsMapping: SessionsMappingRequest;
  reviewList: ReviewListRequest;
  reviewResolve: ReviewResolveRequest;
  reviewBulk: ReviewBulkRequest;
  reviewRevert: ReviewRevertRequest;
  reviewRerun: ReviewRerunRequest;
  reviewClip: ReviewClipRequest;
  pipelineRun: PipelineRunRequest;
  pipelineCancel: PipelineCancelRequest;
  runsSubscribe: RunsSubscribeRequest;
  runsUnsubscribe: RunsUnsubscribeRequest;
  settingsGet: Record<string, never>;
  settingsSet: SettingsSetRequest;
  settingsReveal: SettingsRevealRequest;
  settingsTestConnection: SettingsTestConnectionRequest;
  sidecarStatus: Record<string, never>;
  sidecarLogs: SidecarLogsRequest;
}

export interface IpcResponseMap {
  sessionsList: SessionsListResponse;
  sessionsGet: SessionsGetResponse;
  sessionsCreate: SessionsCreateResponse;
  sessionsCopy: SessionsCopyResponse;
  sessionsReveal: SessionsRevealResponse;
  sessionsQa: SessionsQaResponse;
  sessionsMapping: SessionsMappingResponse;
  reviewList: ReviewListResponse;
  reviewResolve: ReviewResolveResponse;
  reviewBulk: ReviewBulkResponse;
  reviewRevert: ReviewRevertResponse;
  reviewRerun: ReviewRerunResponse;
  reviewClip: ReviewClipResponse;
  pipelineRun: PipelineRunResponse;
  pipelineCancel: PipelineCancelResponse;
  runsSubscribe: RunsSubscribeResponse;
  runsUnsubscribe: RunsUnsubscribeResponse;
  settingsGet: SettingsGetResponse;
  settingsSet: SettingsSetResponse;
  settingsReveal: SettingsRevealResponse;
  settingsTestConnection: SettingsTestConnectionResponse;
  sidecarStatus: SidecarStatusResponse;
  sidecarLogs: SidecarLogsResponse;
}

export type IpcOperation = keyof IpcRequestMap;
export type IpcRequest = IpcRequestMap[IpcOperation];
export type IpcResponse = IpcResponseMap[IpcOperation];

const operationForChannel = new Map<string, IpcOperation>([
  [CHANNELS.sessions.list, "sessionsList"],
  [CHANNELS.sessions.get, "sessionsGet"],
  [CHANNELS.sessions.create, "sessionsCreate"],
  [CHANNELS.sessions.copy, "sessionsCopy"],
  [CHANNELS.sessions.reveal, "sessionsReveal"],
  [CHANNELS.sessions.qa, "sessionsQa"],
  [CHANNELS.sessions.mapping, "sessionsMapping"],
  [CHANNELS.review.list, "reviewList"],
  [CHANNELS.review.resolve, "reviewResolve"],
  [CHANNELS.review.bulk, "reviewBulk"],
  [CHANNELS.review.revert, "reviewRevert"],
  [CHANNELS.review.rerun, "reviewRerun"],
  [CHANNELS.review.clip, "reviewClip"],
  [CHANNELS.pipeline.run, "pipelineRun"],
  [CHANNELS.pipeline.cancel, "pipelineCancel"],
  [CHANNELS.runs.subscribe, "runsSubscribe"],
  [CHANNELS.runs.unsubscribe, "runsUnsubscribe"],
  [CHANNELS.settings.get, "settingsGet"],
  [CHANNELS.settings.set, "settingsSet"],
  [CHANNELS.settings.reveal, "settingsReveal"],
  [CHANNELS.settings.testConnection, "settingsTestConnection"],
  [CHANNELS.sidecar.status, "sidecarStatus"],
  [CHANNELS.sidecar.logs, "sidecarLogs"],
]);

function parseSessionSummary(value: unknown, context: string): SessionSummary {
  const record = parseObject(
    value,
    ["sessionId", "title", "number", "date", "durationS", "status", "grade", "hasNotes"],
    context,
  );
  const number =
    record.number === null
      ? null
      : requiredInteger(record.number, `${context}.number`, 0, 1_000_000);
  const durationS =
    record.durationS === null
      ? null
      : typeof record.durationS === "number" &&
          Number.isFinite(record.durationS) &&
          record.durationS >= 0
        ? record.durationS
        : (() => {
            throw invalid(ERROR_CODES.invalidValue, `${context}.durationS must be non-negative`, {
              field: `${context}.durationS`,
            });
          })();
  if (typeof record.hasNotes !== "boolean")
    throw invalid(ERROR_CODES.invalidValue, `${context}.hasNotes must be a boolean`, {
      field: `${context}.hasNotes`,
    });
  return {
    sessionId: sessionId(record.sessionId, `${context}.sessionId`),
    title: requiredString(record.title, `${context}.title`),
    number,
    date: requiredString(record.date, `${context}.date`),
    durationS,
    status: requiredString(record.status, `${context}.status`),
    grade: record.grade === null ? null : requiredString(record.grade, `${context}.grade`),
    hasNotes: record.hasNotes,
  };
}

function parseDropPaths(value: unknown, context: string): SessionDropPaths {
  const record = parseObject(value, ["craig", "roll20"], context);
  return {
    craig: requiredString(record.craig, `${context}.craig`, IPC_LIMITS.maxStringLength),
    roll20: requiredString(record.roll20, `${context}.roll20`, IPC_LIMITS.maxStringLength),
  };
}

function parseQaEntry(value: unknown, context: string): IntakeQaEntry {
  const record = parseObject(value, ["code", "severity", "message", "subject", "hint"], context);
  if (record.severity !== "error" && record.severity !== "warning" && record.severity !== "info")
    throw invalid(ERROR_CODES.invalidValue, `${context}.severity is invalid`, {
      field: `${context}.severity`,
    });
  return {
    code: requiredString(record.code, `${context}.code`, 128),
    severity: record.severity,
    message: requiredString(record.message, `${context}.message`),
    ...(record.subject === undefined
      ? {}
      : { subject: requiredString(record.subject, `${context}.subject`) }),
    ...(record.hint === undefined ? {} : { hint: requiredString(record.hint, `${context}.hint`) }),
  };
}

function parseMappingCandidate(value: unknown, context: string): MappingCandidate {
  const record = parseObject(value, ["playerId", "displayName", "score", "matchedOn"], context);
  if (
    typeof record.score !== "number" ||
    !Number.isFinite(record.score) ||
    record.score < 0 ||
    record.score > 1
  )
    throw invalid(ERROR_CODES.invalidValue, `${context}.score must be between 0 and 1`, {
      field: `${context}.score`,
    });
  return {
    playerId: requiredString(record.playerId, `${context}.playerId`, 128),
    displayName: requiredString(record.displayName, `${context}.displayName`),
    score: record.score,
    matchedOn: requiredString(record.matchedOn, `${context}.matchedOn`),
  };
}

function parseMappingSuggestion(value: unknown, context: string): MappingSuggestion {
  const record = parseObject(value, ["observed", "kind", "exact", "candidates"], context);
  if (record.kind !== "discord" && record.kind !== "roll20")
    throw invalid(ERROR_CODES.invalidValue, `${context}.kind is invalid`, {
      field: `${context}.kind`,
    });
  if (!Array.isArray(record.candidates) || record.candidates.length > 100)
    throw invalid(ERROR_CODES.invalidValue, `${context}.candidates must be bounded`, {
      field: `${context}.candidates`,
    });
  return {
    observed: requiredString(record.observed, `${context}.observed`),
    kind: record.kind,
    exact: record.exact === null ? null : requiredString(record.exact, `${context}.exact`, 128),
    candidates: record.candidates.map((candidate, index) =>
      parseMappingCandidate(candidate, `${context}.candidates[${String(index)}]`),
    ),
  };
}

function parseRunEvent(value: unknown, context: string): RunEvent {
  const record = parseObject(
    value,
    [
      "type",
      "sequence",
      "runId",
      "stage",
      "at",
      "progress",
      "message",
      "durationS",
      "error",
      "level",
      "kind",
      "bytesCopied",
      "totalBytes",
    ],
    context,
  );
  const type = requiredString(record.type, `${context}.type`);
  const sequence = requiredInteger(
    record.sequence,
    `${context}.sequence`,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const id = runId(record.runId, `${context}.runId`);
  if (type === "copy_progress") {
    if (record.kind !== "craig" && record.kind !== "roll20")
      throw invalid(ERROR_CODES.invalidValue, `${context}.kind is invalid`, {
        field: `${context}.kind`,
      });
    if (
      typeof record.progress !== "number" ||
      !Number.isFinite(record.progress) ||
      record.progress < 0 ||
      record.progress > 1
    )
      throw invalid(ERROR_CODES.invalidValue, `${context}.progress must be between 0 and 1`, {
        field: `${context}.progress`,
      });
    return {
      type,
      sequence,
      runId: id,
      kind: record.kind,
      progress: record.progress,
      bytesCopied: requiredInteger(
        record.bytesCopied,
        `${context}.bytesCopied`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      totalBytes: requiredInteger(
        record.totalBytes,
        `${context}.totalBytes`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      ...(record.message === undefined
        ? {}
        : { message: requiredString(record.message, `${context}.message`) }),
    };
  }
  if (type === "stage_started")
    return {
      type,
      sequence,
      runId: id,
      stage: requiredString(record.stage, `${context}.stage`),
      at: requiredString(record.at, `${context}.at`),
    };
  if (type === "stage_progress") {
    if (
      typeof record.progress !== "number" ||
      !Number.isFinite(record.progress) ||
      record.progress < 0 ||
      record.progress > 1
    )
      throw invalid(ERROR_CODES.invalidValue, `${context}.progress must be between 0 and 1`, {
        field: `${context}.progress`,
      });
    return {
      type,
      sequence,
      runId: id,
      stage: requiredString(record.stage, `${context}.stage`),
      progress: record.progress,
      ...(record.message === undefined
        ? {}
        : { message: requiredString(record.message, `${context}.message`) }),
    };
  }
  if (type === "stage_skipped")
    return { type, sequence, runId: id, stage: requiredString(record.stage, `${context}.stage`) };
  if (type === "stage_completed")
    return {
      type,
      sequence,
      runId: id,
      stage: requiredString(record.stage, `${context}.stage`),
      ...(record.durationS === undefined
        ? {}
        : {
            durationS: requiredInteger(
              record.durationS,
              `${context}.durationS`,
              0,
              Number.MAX_SAFE_INTEGER,
            ),
          }),
    };
  if (type === "stage_failed")
    return {
      type,
      sequence,
      runId: id,
      stage: requiredString(record.stage, `${context}.stage`),
      error: parseStructuredError(record.error, `${context}.error`),
    };
  if (type === "run_completed") return { type, sequence, runId: id };
  if (type === "run_failed")
    return {
      type,
      sequence,
      runId: id,
      error: parseStructuredError(record.error, `${context}.error`),
    };
  if (type === "log") {
    if (record.level !== "info" && record.level !== "warning" && record.level !== "error")
      throw invalid(ERROR_CODES.invalidValue, `${context}.level is invalid`, {
        field: `${context}.level`,
      });
    return {
      type,
      sequence,
      runId: id,
      level: record.level,
      message: requiredString(record.message, `${context}.message`),
    };
  }
  throw invalid(ERROR_CODES.invalidValue, `${context}.type is unknown`, {
    field: `${context}.type`,
  });
}

function parseStructuredError(value: unknown, context: string): StructuredError {
  const record = parseObject(value, ["code", "message", "details"], context);
  const detailsValue = record.details;
  let details: ErrorDetails | undefined;
  if (detailsValue !== undefined) {
    if (!isRecord(detailsValue))
      throw invalid(ERROR_CODES.invalidValue, `${context}.details must be an object`);
    const parsed: Record<string, string | number | boolean | null> = {};
    for (const key of Object.keys(detailsValue)) {
      if (
        key
          .replace(/[^a-z0-9]/gi, "")
          .toLowerCase()
          .includes("stack")
      )
        throw invalid(ERROR_CODES.invalidValue, `${context}.details contains a forbidden field`, {
          field: key,
        });
      const child = detailsValue[key];
      if (
        child !== null &&
        typeof child !== "string" &&
        typeof child !== "number" &&
        typeof child !== "boolean"
      )
        throw invalid(ERROR_CODES.invalidValue, `${context}.details contains a non-scalar value`);
      parsed[key] = child;
    }
    details = parsed;
  }
  return structuredError(
    requiredString(record["code"], `${context}.code`, 128),
    requiredString(record.message, `${context}.message`),
    details,
  );
}

function parseRequestForOperation(operation: IpcOperation, value: unknown): IpcRequest {
  switch (operation) {
    case "sessionsList": {
      const record = parseObject(
        value,
        ["status", "grade", "limit", "cursor"],
        "sessions.list request",
      );
      return {
        ...(record.status === undefined ? {} : { status: requiredString(record.status, "status") }),
        ...(record.grade === undefined ? {} : { grade: requiredString(record.grade, "grade") }),
        ...(record.limit === undefined
          ? {}
          : { limit: requiredInteger(record.limit, "limit", 1, 1_000) }),
        ...(record.cursor === undefined
          ? {}
          : { cursor: requiredString(record.cursor, "cursor", 256) }),
      };
    }
    case "sessionsGet": {
      const record = parseObject(value, ["sessionId"], "sessions.get request");
      return { sessionId: sessionId(record.sessionId) };
    }
    case "sessionsCreate": {
      const record = parseObject(
        value,
        ["sessionId", "title", "number", "date"],
        "sessions.create request",
      );
      return {
        sessionId: sessionId(record.sessionId),
        title: requiredString(record.title, "title"),
        ...(record.number === undefined
          ? {}
          : {
              number: record.number === null ? null : requiredInteger(record.number, "number", 0),
            }),
        date: requiredString(record.date, "date"),
      };
    }
    case "sessionsCopy": {
      const record = parseObject(
        value,
        ["sessionId", "kind", "sourcePath"],
        "sessions.copy request",
      );
      if (record.kind !== "craig" && record.kind !== "roll20")
        throw invalid(ERROR_CODES.invalidValue, "kind must be craig or roll20", { field: "kind" });
      return {
        sessionId: sessionId(record.sessionId),
        kind: record.kind,
        sourcePath: requiredString(record.sourcePath, "sourcePath", IPC_LIMITS.maxStringLength),
      };
    }
    case "sessionsReveal": {
      const record = parseObject(value, ["sessionId", "kind"], "sessions.reveal request");
      if (record.kind !== "craig" && record.kind !== "roll20")
        throw invalid(ERROR_CODES.invalidValue, "kind must be craig or roll20", { field: "kind" });
      return { sessionId: sessionId(record.sessionId), kind: record.kind };
    }
    case "sessionsQa": {
      const record = parseObject(value, ["sessionId"], "sessions.qa request");
      return { sessionId: sessionId(record.sessionId) };
    }
    case "reviewList":
      return {
        sessionId: sessionId(parseObject(value, ["sessionId"], "review.list request").sessionId),
      };
    case "reviewResolve": {
      const record = parseObject(
        value,
        ["sessionId", "utteranceId", "action", "label", "characterId"],
        "review.resolve request",
      );
      if (
        !["candidate", "character", "out_of_character", "unresolvable"].includes(
          String(record.action),
        )
      )
        throw invalid(ERROR_CODES.invalidValue, "invalid review action");
      return {
        sessionId: sessionId(record.sessionId),
        utteranceId: requiredString(record.utteranceId, "utteranceId"),
        action: record.action as ReviewAction,
        ...(record.label === undefined ? {} : { label: requiredString(record.label, "label") }),
        ...(record.characterId === undefined
          ? {}
          : {
              characterId:
                record.characterId === null
                  ? null
                  : requiredString(record.characterId, "characterId"),
            }),
      };
    }
    case "reviewBulk": {
      const record = parseObject(
        value,
        ["sessionId", "clusterId", "action", "label", "characterId"],
        "review.bulk request",
      );
      if (
        !["candidate", "character", "out_of_character", "unresolvable"].includes(
          String(record.action),
        )
      )
        throw invalid(ERROR_CODES.invalidValue, "invalid review action");
      return {
        sessionId: sessionId(record.sessionId),
        clusterId: requiredString(record.clusterId, "clusterId"),
        action: record.action as ReviewAction,
        ...(record.label === undefined ? {} : { label: requiredString(record.label, "label") }),
        ...(record.characterId === undefined
          ? {}
          : {
              characterId:
                record.characterId === null
                  ? null
                  : requiredString(record.characterId, "characterId"),
            }),
      };
    }
    case "reviewRevert": {
      const record = parseObject(value, ["sessionId", "journalId"], "review.revert request");
      return {
        sessionId: sessionId(record.sessionId),
        journalId: requiredString(record.journalId, "journalId"),
      };
    }
    case "reviewRerun": {
      const record = parseObject(value, ["sessionId", "utteranceIds"], "review.rerun request");
      if (!Array.isArray(record.utteranceIds) || record.utteranceIds.length > 1_000)
        throw invalid(ERROR_CODES.invalidValue, "utteranceIds must be a bounded array");
      return {
        sessionId: sessionId(record.sessionId),
        utteranceIds: record.utteranceIds.map((id, index) =>
          requiredString(id, `utteranceIds[${String(index)}]`),
        ),
      };
    }
    case "reviewClip": {
      const record = parseObject(value, ["sessionId", "utteranceId"], "review.clip request");
      return {
        sessionId: sessionId(record.sessionId),
        utteranceId: requiredString(record.utteranceId, "utteranceId"),
      };
    }
    case "sessionsMapping": {
      const record = parseObject(value, ["sessionId", "decisions"], "sessions.mapping request");
      if (!Array.isArray(record.decisions) || record.decisions.length > 1_000)
        throw invalid(ERROR_CODES.invalidValue, "decisions must be a bounded array", {
          field: "decisions",
        });
      const decisions: SessionsMappingDecision[] = record.decisions.map((value, index) => {
        const item = parseObject(
          value,
          ["observed", "kind", "playerId"],
          `decisions[${String(index)}]`,
        );
        if (item.kind !== "discord" && item.kind !== "roll20")
          throw invalid(ERROR_CODES.invalidValue, "mapping kind is invalid", {
            field: `decisions[${String(index)}].kind`,
          });
        return {
          observed: requiredString(item.observed, `decisions[${String(index)}].observed`),
          kind: item.kind,
          playerId:
            item.playerId === null
              ? null
              : requiredString(item.playerId, `decisions[${String(index)}].playerId`, 128),
        };
      });
      return { sessionId: sessionId(record.sessionId), decisions };
    }
    case "pipelineRun": {
      const record = parseObject(value, ["sessionId", "stages", "force"], "pipeline.run request");
      let stages: string[] | undefined;
      if (record.stages !== undefined) {
        if (!Array.isArray(record.stages) || record.stages.length > 128)
          throw invalid(ERROR_CODES.invalidValue, "stages must be an array of at most 128 names", {
            field: "stages",
          });
        stages = record.stages.map((stage, index) =>
          requiredString(stage, `stages[${String(index)}]`, 128),
        );
      }
      return {
        sessionId: sessionId(record.sessionId),
        ...(stages === undefined ? {} : { stages }),
        ...(record.force === undefined ? {} : { force: optionalBoolean(record.force, "force") }),
      };
    }
    case "pipelineCancel": {
      const record = parseObject(value, ["runId", "reason"], "pipeline.cancel request");
      return {
        runId: runId(record.runId),
        ...(record.reason === undefined ? {} : { reason: requiredString(record.reason, "reason") }),
      };
    }
    case "runsSubscribe": {
      const record = parseObject(value, ["runId", "cursor"], "runs.subscribe request");
      return {
        runId: runId(record.runId),
        ...(record.cursor === undefined
          ? {}
          : { cursor: requiredInteger(record.cursor, "cursor", 0, Number.MAX_SAFE_INTEGER) }),
      };
    }
    case "runsUnsubscribe": {
      const record = parseObject(value, ["subscriptionId"], "runs.unsubscribe request");
      return { subscriptionId: requiredString(record.subscriptionId, "subscriptionId", 128) };
    }
    case "settingsGet":
      parseObject(value, [], "settings.get request");
      return {};
    case "settingsSet": {
      const record = parseObject(value, ["key", "value"], "settings.set request");
      const key = requiredString(record.key, "key", 128);
      if (!(SETTING_KEYS as readonly string[]).includes(key))
        throw invalid(ERROR_CODES.settingsKeyNotAllowed, `setting key "${key}" is not allowed`, {
          field: "key",
        });
      const parsedValue =
        key === "providerModel" && record.value === ""
          ? ""
          : requiredString(record.value, "value", IPC_LIMITS.maxRequestBytes);
      return { key, value: parsedValue };
    }
    case "settingsReveal": {
      const record = parseObject(value, ["key"], "settings.reveal request");
      const key = requiredString(record.key, "key", 128);
      if (!(PATH_SETTING_KEYS as readonly string[]).includes(key))
        throw invalid(
          ERROR_CODES.settingsKeyNotAllowed,
          `setting key "${key}" cannot be revealed`,
          {
            field: "key",
          },
        );
      return { key };
    }
    case "settingsTestConnection": {
      const record = parseObject(
        value,
        ["baseUrl", "model", "timeoutMs"],
        "settings.testConnection request",
      );
      return {
        baseUrl: requiredString(record.baseUrl, "baseUrl", 2_048),
        ...(record.model === undefined
          ? {}
          : { model: requiredString(record.model, "model", 512) }),
        ...(record.timeoutMs === undefined
          ? {}
          : { timeoutMs: requiredInteger(record.timeoutMs, "timeoutMs", 250, 30_000) }),
      };
    }
    case "sidecarStatus":
      parseObject(value, [], "sidecar.status request");
      return {};
    case "sidecarLogs": {
      const record = parseObject(value, ["maxLines"], "sidecar.logs request");
      return {
        ...(record.maxLines === undefined
          ? {}
          : { maxLines: requiredInteger(record.maxLines, "maxLines", 1, 1_000) }),
      };
    }
  }
}

/** Validate an unwrapped request DTO for a channel. */
export function validateRequest(channel: string, value: unknown): IpcRequest {
  const operation = operationForChannel.get(channel);
  if (operation === undefined) throw invalid(ERROR_CODES.invalidRequest, "unknown IPC channel");
  return parseRequestForOperation(operation, value);
}

/** Validate the sole request wire shape before inspecting its DTO. */
export function validateRequestEnvelope(channel: string, value: unknown): IpcRequest {
  assertOnlyKeys(value, ["ok", "value"], "request envelope");
  if (value.ok !== true || !("value" in value))
    throw invalid(ERROR_CODES.invalidRequest, "request envelope must contain ok: true and value");
  return validateRequest(channel, value.value);
}

function parseReviewFlag(value: unknown, context: string): ReviewFlag {
  const record = parseObject(
    value,
    [
      "utteranceId",
      "code",
      "impactS",
      "timestampS",
      "speaker",
      "text",
      "candidates",
      "evidence",
      "clusterId",
    ],
    context,
  );
  if (!Array.isArray(record.candidates))
    throw invalid(ERROR_CODES.invalidValue, `${context}.candidates must be an array`);
  const candidates = record.candidates.map((item, index) => {
    const candidate = parseObject(
      item,
      ["label", "characterId", "score"],
      `${context}.candidates[${String(index)}]`,
    );
    return {
      label: requiredString(candidate.label, "label"),
      characterId:
        candidate.characterId === null
          ? null
          : requiredString(candidate.characterId, "characterId"),
      score:
        typeof candidate.score === "number" && Number.isFinite(candidate.score)
          ? candidate.score
          : 0,
    };
  });
  return {
    utteranceId: requiredString(record.utteranceId, "utteranceId"),
    code: requiredString(record.code, "code"),
    impactS: typeof record.impactS === "number" ? record.impactS : 0,
    timestampS: typeof record.timestampS === "number" ? record.timestampS : 0,
    speaker: requiredString(record.speaker, "speaker"),
    text: requiredString(record.text, "text"),
    candidates,
    evidence: isRecord(record.evidence) ? record.evidence : {},
    clusterId: record.clusterId === null ? null : requiredString(record.clusterId, "clusterId"),
  };
}

function parseResponseForOperation(operation: IpcOperation, value: unknown): IpcResponse {
  switch (operation) {
    case "sessionsList": {
      const record = parseObject(value, ["sessions", "nextCursor"], "sessions.list response");
      if (!Array.isArray(record.sessions) || record.sessions.length > IPC_LIMITS.maxArrayLength)
        throw invalid(ERROR_CODES.invalidValue, "sessions must be an array", { field: "sessions" });
      return {
        sessions: record.sessions.map((item, index) =>
          parseSessionSummary(item, `sessions[${String(index)}]`),
        ),
        ...(record.nextCursor === undefined
          ? {}
          : { nextCursor: requiredString(record.nextCursor, "nextCursor", 256) }),
      };
    }
    case "sessionsGet": {
      const record = parseObject(value, ["session", "paths"], "sessions.get response");
      return {
        session: record.session === null ? null : parseSessionSummary(record.session, "session"),
        ...(record.paths === undefined ? {} : { paths: parseDropPaths(record.paths, "paths") }),
      };
    }
    case "reviewList": {
      const record = parseObject(value, ["flags"], "review.list response");
      if (!Array.isArray(record.flags))
        throw invalid(ERROR_CODES.invalidValue, "flags must be an array");
      return {
        flags: record.flags.map((item, index) => parseReviewFlag(item, `flags[${String(index)}]`)),
      };
    }
    case "reviewResolve": {
      const record = parseObject(
        value,
        ["saved", "rerunSuggested", "journalId"],
        "review.resolve response",
      );
      return {
        saved: record.saved === true,
        rerunSuggested: record.rerunSuggested === true,
        ...(record.journalId === undefined
          ? {}
          : { journalId: requiredString(record.journalId, "journalId") }),
      };
    }
    case "reviewBulk": {
      const record = parseObject(
        value,
        ["saved", "count", "rerunSuggested"],
        "review.bulk response",
      );
      return {
        saved: record.saved === true,
        count: requiredInteger(record.count, "count"),
        rerunSuggested: record.rerunSuggested === true,
      };
    }
    case "reviewRevert": {
      const record = parseObject(value, ["reverted"], "review.revert response");
      return { reverted: record.reverted === true };
    }
    case "reviewRerun": {
      const record = parseObject(value, ["runId"], "review.rerun response");
      return { runId: runId(record.runId) };
    }
    case "reviewClip": {
      const record = parseObject(value, ["path"], "review.clip response");
      return { path: requiredString(record.path, "path", IPC_LIMITS.maxStringLength) };
    }
    case "sessionsCreate": {
      const record = parseObject(value, ["session", "paths"], "sessions.create response");
      return {
        session: parseSessionSummary(record.session, "session"),
        ...(record.paths === undefined ? {} : { paths: parseDropPaths(record.paths, "paths") }),
      };
    }
    case "sessionsCopy": {
      const record = parseObject(value, ["copyId", "destinationName"], "sessions.copy response");
      return {
        copyId: runId(record.copyId, "copyId"),
        destinationName: requiredString(record.destinationName, "destinationName"),
      };
    }
    case "sessionsReveal": {
      const record = parseObject(value, ["revealed"], "sessions.reveal response");
      if (typeof record.revealed !== "boolean")
        throw invalid(ERROR_CODES.invalidValue, "revealed must be a boolean");
      return { revealed: record.revealed };
    }
    case "sessionsQa": {
      const record = parseObject(
        value,
        ["entries", "grade", "suggestions"],
        "sessions.qa response",
      );
      if (!Array.isArray(record.entries) || record.entries.length > IPC_LIMITS.maxArrayLength)
        throw invalid(ERROR_CODES.invalidValue, "entries must be a bounded array", {
          field: "entries",
        });
      if (!Array.isArray(record.suggestions) || record.suggestions.length > 1_000)
        throw invalid(ERROR_CODES.invalidValue, "suggestions must be a bounded array", {
          field: "suggestions",
        });
      return {
        entries: record.entries.map((entry, index) =>
          parseQaEntry(entry, `entries[${String(index)}]`),
        ),
        grade: record.grade === null ? null : requiredString(record.grade, "grade", 32),
        suggestions: record.suggestions.map((suggestion, index) =>
          parseMappingSuggestion(suggestion, `suggestions[${String(index)}]`),
        ),
      };
    }
    case "sessionsMapping": {
      const record = parseObject(value, ["saved"], "sessions.mapping response");
      if (typeof record.saved !== "boolean")
        throw invalid(ERROR_CODES.invalidValue, "saved must be a boolean");
      return { saved: record.saved };
    }
    case "pipelineRun": {
      const record = parseObject(value, ["runId"], "pipeline.run response");
      return { runId: runId(record.runId) };
    }
    case "pipelineCancel": {
      const record = parseObject(value, ["cancelled"], "pipeline.cancel response");
      if (typeof record.cancelled !== "boolean")
        throw invalid(ERROR_CODES.invalidValue, "cancelled must be a boolean");
      return { cancelled: record.cancelled };
    }
    case "runsSubscribe": {
      const record = parseObject(
        value,
        ["subscriptionId", "replay", "replayCursor", "replayTruncated"],
        "runs.subscribe response",
      );
      if (!Array.isArray(record.replay) || record.replay.length > IPC_LIMITS.maxReplayEvents)
        throw invalid(ERROR_CODES.invalidValue, "replay must be a bounded array", {
          field: "replay",
        });
      if (typeof record.replayTruncated !== "boolean")
        throw invalid(ERROR_CODES.invalidValue, "replayTruncated must be a boolean");
      return {
        subscriptionId: requiredString(record.subscriptionId, "subscriptionId", 128),
        replay: record.replay.map((event, index) =>
          parseRunEvent(event, `replay[${String(index)}]`),
        ),
        replayCursor: requiredInteger(
          record.replayCursor,
          "replayCursor",
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        replayTruncated: record.replayTruncated,
      };
    }
    case "runsUnsubscribe": {
      const record = parseObject(value, ["unsubscribed"], "runs.unsubscribe response");
      if (typeof record.unsubscribed !== "boolean")
        throw invalid(ERROR_CODES.invalidValue, "unsubscribed must be a boolean");
      return { unsubscribed: record.unsubscribed };
    }
    case "settingsGet": {
      const record = parseObject(value, ["settings"], "settings.get response");
      if (!isRecord(record.settings))
        throw invalid(ERROR_CODES.invalidValue, "settings must be an object");
      const settings: Partial<Record<SettingKey, string>> = {};
      for (const key of Object.keys(record.settings)) {
        if (!(SETTING_KEYS as readonly string[]).includes(key))
          throw invalid(ERROR_CODES.settingsKeyNotAllowed, `setting key "${key}" is not allowed`, {
            field: key,
          });
        settings[key as SettingKey] =
          key === "providerModel" && record.settings[key] === ""
            ? ""
            : requiredString(record.settings[key], `settings.${key}`);
      }
      return { settings };
    }
    case "settingsSet": {
      const record = parseObject(value, ["key", "value"], "settings.set response");
      const key = requiredString(record.key, "key", 128);
      if (!(SETTING_KEYS as readonly string[]).includes(key))
        throw invalid(ERROR_CODES.settingsKeyNotAllowed, `setting key "${key}" is not allowed`, {
          field: "key",
        });
      return {
        key: key as SettingKey,
        value:
          key === "providerModel" && record.value === ""
            ? ""
            : requiredString(record.value, "value"),
      };
    }
    case "settingsReveal": {
      const record = parseObject(value, ["key", "revealed"], "settings.reveal response");
      const key = requiredString(record.key, "key", 128);
      if (!(PATH_SETTING_KEYS as readonly string[]).includes(key))
        throw invalid(
          ERROR_CODES.settingsKeyNotAllowed,
          `setting key "${key}" cannot be revealed`,
          {
            field: "key",
          },
        );
      if (typeof record.revealed !== "boolean")
        throw invalid(ERROR_CODES.invalidValue, "revealed must be a boolean", {
          field: "revealed",
        });
      return { key: key as PathSettingKey, revealed: record.revealed };
    }
    case "settingsTestConnection": {
      const record = parseObject(
        value,
        ["ok", "latencyMs", "models", "message"],
        "settings.testConnection response",
      );
      if (typeof record.ok !== "boolean")
        throw invalid(ERROR_CODES.invalidValue, "ok must be a boolean", { field: "ok" });
      if (
        record.latencyMs !== null &&
        (typeof record.latencyMs !== "number" ||
          !Number.isFinite(record.latencyMs) ||
          record.latencyMs < 0)
      )
        throw invalid(ERROR_CODES.invalidValue, "latencyMs must be null or a non-negative number", {
          field: "latencyMs",
        });
      if (!Array.isArray(record.models) || record.models.length > 256)
        throw invalid(ERROR_CODES.invalidValue, "models must be a bounded array", {
          field: "models",
        });
      return {
        ok: record.ok,
        latencyMs: record.latencyMs as number | null,
        models: record.models.map((model, index) =>
          requiredString(model, `models[${String(index)}]`, 512),
        ),
        message: requiredString(record.message, "message", IPC_LIMITS.maxStringLength),
      };
    }
    case "sidecarStatus": {
      const record = parseObject(
        value,
        ["status", "reason", "setupCommand", "capabilities"],
        "sidecar.status response",
      );
      if (
        record.status !== "stopped" &&
        record.status !== "starting" &&
        record.status !== "ready" &&
        record.status !== "unhealthy" &&
        record.status !== "unavailable"
      )
        throw invalid(ERROR_CODES.invalidValue, "sidecar status is invalid", { field: "status" });
      const capabilities = record.capabilities;
      if (capabilities !== undefined && !isRecord(capabilities))
        throw invalid(ERROR_CODES.invalidValue, "capabilities must be an object", {
          field: "capabilities",
        });
      const parsedCapabilities: Record<string, boolean> = {};
      if (isRecord(capabilities)) {
        for (const [key, value] of Object.entries(capabilities)) {
          if (typeof value !== "boolean")
            throw invalid(ERROR_CODES.invalidValue, `capability "${key}" must be boolean`, {
              field: `capabilities.${key}`,
            });
          parsedCapabilities[key] = value;
        }
      }
      return {
        status: record.status,
        ...(record.reason === undefined ? {} : { reason: requiredString(record.reason, "reason") }),
        ...(record.setupCommand === undefined
          ? {}
          : { setupCommand: requiredString(record.setupCommand, "setupCommand") }),
        ...(capabilities === undefined ? {} : { capabilities: parsedCapabilities }),
      };
    }
    case "sidecarLogs": {
      const record = parseObject(value, ["lines"], "sidecar.logs response");
      if (!Array.isArray(record.lines) || record.lines.length > 1_000)
        throw invalid(ERROR_CODES.invalidValue, "sidecar log lines must be a bounded array", {
          field: "lines",
        });
      return {
        lines: record.lines.map((line, index) =>
          requiredString(line, `lines[${String(index)}]`, IPC_LIMITS.maxStringLength),
        ),
      };
    }
  }
}

/** Validate a response DTO for a channel before it reaches the renderer. */
export function validateResponse(channel: string, value: unknown): IpcResponse {
  const operation = operationForChannel.get(channel);
  if (operation === undefined) throw invalid(ERROR_CODES.invalidResponse, "unknown IPC channel");
  return parseResponseForOperation(operation, value);
}

export function validateResponseEnvelope(
  channel: string,
  value: unknown,
): IpcEnvelope<IpcResponse> {
  try {
    assertSafePayload(value, IPC_LIMITS.maxDepth, IPC_LIMITS.maxStringLength);
    assertOnlyKeys(value, ["ok", "value", "error"], "response envelope");
    if (value.ok === true) {
      if (!("value" in value) || "error" in value)
        throw invalid(ERROR_CODES.invalidResponse, "successful response envelope is malformed");
      return success(validateResponse(channel, value.value));
    }
    if (value.ok === false) {
      if (!("error" in value) || "value" in value)
        throw invalid(ERROR_CODES.invalidResponse, "error response envelope is malformed");
      return failure(parseStructuredError(value.error, "response error"));
    }
    throw invalid(ERROR_CODES.invalidResponse, "response envelope must have a boolean ok field");
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    throw invalid(ERROR_CODES.invalidResponse, "response envelope could not be inspected");
  }
}

export function errorFromUnknown(
  error: unknown,
  fallbackCode: StructuredErrorCode,
): StructuredError {
  if (error instanceof ContractValidationError)
    return structuredError(error.code, error.message, error.details);
  return structuredError(fallbackCode, "The IPC operation failed");
}

function parseCapabilities(value: unknown): Readonly<Record<string, boolean>> {
  if (!isRecord(value)) throw invalid(ERROR_CODES.eventRejected, "capabilities must be an object");
  const result: Record<string, boolean> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== "boolean")
      throw invalid(ERROR_CODES.eventRejected, `capability "${key}" must be boolean`);
    result[key] = child;
  }
  return result;
}

const DENY_NORMALISED = new Set([
  "raw",
  "rawline",
  "rawlines",
  "rawtext",
  "line",
  "lines",
  "path",
  "paths",
  "filepath",
  "filepaths",
  "rootpath",
  "internalpath",
  "internalpaths",
  "command",
  "commands",
  "commandline",
  "commandlines",
  "commandstring",
  "commandstrings",
  "argv",
  "args",
  "session",
  "sessions",
  "sessionid",
  "sessionids",
  "stack",
]);

function deniedOutboundKey(key: string): boolean {
  const normalised = key.replace(/[_.-]/g, "").toLowerCase();
  return (
    DENY_NORMALISED.has(normalised) ||
    normalised.startsWith("raw") ||
    normalised.endsWith("rawline") ||
    normalised.endsWith("internalpath") ||
    normalised.endsWith("path") ||
    normalised.includes("command") ||
    normalised.endsWith("commandstring") ||
    normalised.endsWith("filepath") ||
    normalised.endsWith("rootpath") ||
    normalised.endsWith("sessionid")
  );
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SanitizedOutboundEvent = { readonly [key: string]: JsonValue };

/**
 * Copy event data into JSON values while dropping internal fields.  A cycle,
 * getter failure, depth overflow, or size overflow returns null so callers can
 * report a safe structured failure instead of handing the renderer a partial
 * object or an exception with internal details.
 */
export function sanitizeOutboundEvent(value: unknown): SanitizedOutboundEvent | null {
  const active = new WeakSet<object>();
  let failed = false;
  const copy = (candidate: unknown, depth: number): JsonValue | undefined => {
    if (failed || depth > IPC_LIMITS.maxEventDepth) {
      failed = true;
      return undefined;
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      if (typeof candidate === "string" && candidate.length > IPC_LIMITS.maxStringLength)
        failed = true;
      return failed ? undefined : candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) failed = true;
      return failed ? undefined : candidate;
    }
    if (typeof candidate !== "object") {
      failed = true;
      return undefined;
    }
    if (active.has(candidate)) {
      failed = true;
      return undefined;
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > IPC_LIMITS.maxArrayLength) {
          failed = true;
          return undefined;
        }
        const result: JsonValue[] = [];
        for (const child of candidate) {
          const copied = copy(child, depth + 1);
          if (copied === undefined) return undefined;
          result.push(copied);
        }
        return result;
      }
      const result: { [key: string]: JsonValue } = {};
      const keys = objectKeys(candidate as PlainRecord);
      if (keys.length > IPC_LIMITS.maxObjectKeys) {
        failed = true;
        return undefined;
      }
      let isSidecarStatus = false;
      try {
        isSidecarStatus = (candidate as PlainRecord)["type"] === "sidecar_status";
      } catch {
        failed = true;
        return undefined;
      }
      for (const key of keys) {
        // setupCommand is allowed only on the explicitly typed sidecar event;
        // generic command/path fields remain denied everywhere else.
        if (deniedOutboundKey(key) && !(isSidecarStatus && key === "setupCommand")) continue;
        let child: unknown;
        try {
          child = (candidate as PlainRecord)[key];
        } catch {
          failed = true;
          return undefined;
        }
        if (child === undefined) continue;
        const copied = copy(child, depth + 1);
        if (copied === undefined) return undefined;
        result[key] = copied;
      }
      return result;
    } finally {
      active.delete(candidate);
    }
  };

  const copied = copy(value, 0);
  if (
    failed ||
    copied === undefined ||
    copied === null ||
    Array.isArray(copied) ||
    typeof copied !== "object"
  )
    return null;
  try {
    const encoded = JSON.stringify(copied);
    if (
      encoded === undefined ||
      new TextEncoder().encode(encoded).byteLength > IPC_LIMITS.maxEventBytes
    )
      return null;
  } catch {
    return null;
  }
  return copied as SanitizedOutboundEvent;
}

export function validateOutboundEvent(value: unknown): DesktopEvent {
  const sanitized = sanitizeOutboundEvent(value);
  if (sanitized === null) throw invalid(ERROR_CODES.eventRejected, "outbound event was rejected");
  if (sanitized["type"] === "sidecar_status") {
    const status = sanitized["status"];
    if (
      status !== "stopped" &&
      status !== "starting" &&
      status !== "ready" &&
      status !== "unhealthy" &&
      status !== "unavailable"
    )
      throw invalid(ERROR_CODES.eventRejected, "outbound sidecar status is invalid");
    return {
      type: "sidecar_status",
      status,
      ...(sanitized["reason"] === undefined
        ? {}
        : { reason: requiredString(sanitized["reason"], "reason") }),
      ...(sanitized["setupCommand"] === undefined
        ? {}
        : { setupCommand: requiredString(sanitized["setupCommand"], "setupCommand") }),
      ...(sanitized["capabilities"] === undefined
        ? {}
        : { capabilities: parseCapabilities(sanitized["capabilities"]) }),
    };
  }
  return parseRunEvent(sanitized, "outbound event");
}
