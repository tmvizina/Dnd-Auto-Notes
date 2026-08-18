import type {
  DesktopEvent,
  IpcEnvelope,
  PipelineCancelRequest,
  PipelineCancelResponse,
  PipelineRunRequest,
  PipelineRunResponse,
  RunEvent,
  RunsSubscribeRequest,
  RunsSubscribeResponse,
  RunsUnsubscribeRequest,
  RunsUnsubscribeResponse,
  SessionSummary,
  SessionsCreateRequest,
  SessionsCreateResponse,
  SessionsGetRequest,
  SessionsGetResponse,
  SessionsListRequest,
  SessionsListResponse,
  SettingsGetResponse,
  SettingsSetRequest,
  SettingsSetResponse,
  SidecarLogsRequest,
  SidecarLogsResponse,
  SidecarStatusEvent,
  SidecarStatusResponse,
  StructuredError,
} from "../../desktop/src/shared/contracts.js";

export type { DesktopEvent, RunEvent, SessionSummary, SidecarStatusEvent };
export type SidecarStatus = Pick<SidecarStatusEvent, "status" | "reason" | "setupCommand">;

/** The operation names are part of the browser-mode error contract. */
export type TransportOperation =
  | "sessions.list"
  | "sessions.get"
  | "sessions.create"
  | "pipeline.run"
  | "pipeline.cancel"
  | "runs.subscribe"
  | "runs.unsubscribe"
  | "runs.onEvent"
  | "settings.get"
  | "settings.set"
  | "sidecar.status"
  | "sidecar.logs";

export type Unsubscribe = () => void;
export type TransportEventListener = (event: DesktopEvent) => void;

/** A renderer-safe view of the single object exposed by preload. */
export interface DesktopBridgeLike {
  readonly sessions: {
    readonly list: (request?: SessionsListRequest) => Promise<IpcEnvelope<SessionsListResponse>>;
    readonly get: (request: SessionsGetRequest) => Promise<IpcEnvelope<SessionsGetResponse>>;
    readonly create: (
      request: SessionsCreateRequest,
    ) => Promise<IpcEnvelope<SessionsCreateResponse>>;
  };
  readonly pipeline: {
    readonly run: (request: PipelineRunRequest) => Promise<IpcEnvelope<PipelineRunResponse>>;
    readonly cancel: (
      request: PipelineCancelRequest,
    ) => Promise<IpcEnvelope<PipelineCancelResponse>>;
  };
  readonly runs: {
    readonly subscribe: (
      request: RunsSubscribeRequest,
    ) => Promise<IpcEnvelope<RunsSubscribeResponse>>;
    readonly unsubscribe: (
      request: RunsUnsubscribeRequest,
    ) => Promise<IpcEnvelope<RunsUnsubscribeResponse>>;
    readonly onEvent: (listener: TransportEventListener) => Unsubscribe;
  };
  readonly settings: {
    readonly get: () => Promise<IpcEnvelope<SettingsGetResponse>>;
    readonly set: (request: SettingsSetRequest) => Promise<IpcEnvelope<SettingsSetResponse>>;
  };
  readonly sidecar: {
    readonly status: () => Promise<IpcEnvelope<SidecarStatusResponse>>;
    readonly logs: (request?: SidecarLogsRequest) => Promise<IpcEnvelope<SidecarLogsResponse>>;
  };
}

export interface RendererTransport {
  readonly kind: "electron" | "browser";
  readonly sessions: {
    readonly list: (request?: SessionsListRequest) => Promise<SessionsListResponse>;
    readonly get: (request: SessionsGetRequest) => Promise<SessionsGetResponse>;
    readonly create: (request: SessionsCreateRequest) => Promise<SessionsCreateResponse>;
  };
  readonly pipeline: {
    readonly run: (request: PipelineRunRequest) => Promise<PipelineRunResponse>;
    readonly cancel: (request: PipelineCancelRequest) => Promise<PipelineCancelResponse>;
  };
  readonly runs: {
    readonly subscribe: (request: RunsSubscribeRequest) => Promise<RunsSubscribeResponse>;
    readonly unsubscribe: (request: RunsUnsubscribeRequest) => Promise<RunsUnsubscribeResponse>;
    readonly onEvent: (listener: TransportEventListener) => Unsubscribe;
  };
  readonly settings: {
    readonly get: () => Promise<SettingsGetResponse>;
    readonly set: (request: SettingsSetRequest) => Promise<SettingsSetResponse>;
  };
  readonly sidecar: {
    readonly status: () => Promise<SidecarStatusResponse>;
    readonly logs: (request?: SidecarLogsRequest) => Promise<SidecarLogsResponse>;
  };
}

/** Structured browser-mode failure. It is safe to show directly in the UI. */
export class UnavailableOperationError extends Error {
  readonly code = "unavailable" as const;
  readonly operation: TransportOperation;
  readonly details: Readonly<{ operation: TransportOperation }>;

  constructor(operation: TransportOperation) {
    super(`unavailable("${operation}")`);
    this.name = "UnavailableOperationError";
    this.operation = operation;
    this.details = { operation };
  }
}

/** Structured failure returned by a validated preload response. */
export class TransportOperationError extends Error {
  readonly code: StructuredError["code"];
  readonly operation: TransportOperation;
  readonly details?: StructuredError["details"];

  constructor(operation: TransportOperation, error: StructuredError) {
    super(error.message);
    this.name = "TransportOperationError";
    this.code = error.code;
    this.operation = operation;
    if (error.details !== undefined) this.details = error.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/**
 * Check the complete public shape before trusting the global. The preload
 * validates every request and response; this guard only prevents a random
 * page global named `dnd` from being mistaken for that bridge.
 */
export function isDesktopBridge(value: unknown): value is DesktopBridgeLike {
  if (!isRecord(value)) return false;
  const sessions = value["sessions"];
  const pipeline = value["pipeline"];
  const runs = value["runs"];
  const settings = value["settings"];
  const sidecar = value["sidecar"];
  if (!isRecord(sessions) || !isRecord(pipeline) || !isRecord(runs)) return false;
  if (!isRecord(settings) || !isRecord(sidecar)) return false;
  return (
    isFunction(sessions["list"]) &&
    isFunction(sessions["get"]) &&
    isFunction(sessions["create"]) &&
    isFunction(pipeline["run"]) &&
    isFunction(pipeline["cancel"]) &&
    isFunction(runs["subscribe"]) &&
    isFunction(runs["unsubscribe"]) &&
    isFunction(runs["onEvent"]) &&
    isFunction(settings["get"]) &&
    isFunction(settings["set"]) &&
    isFunction(sidecar["status"]) &&
    isFunction(sidecar["logs"])
  );
}

function bridgeFromScope(scope: unknown): DesktopBridgeLike | null {
  if (!isRecord(scope)) return null;
  const candidate = scope["dnd"];
  return isDesktopBridge(candidate) ? candidate : null;
}

async function unwrap<T>(
  operation: TransportOperation,
  call: () => Promise<IpcEnvelope<T>>,
): Promise<T> {
  const envelope = await call();
  if (!envelope.ok) throw new TransportOperationError(operation, envelope.error);
  return envelope.value;
}

function electronTransport(bridge: DesktopBridgeLike): RendererTransport {
  return {
    kind: "electron",
    sessions: {
      list: (request = {}) => unwrap("sessions.list", () => bridge.sessions.list(request)),
      get: (request) => unwrap("sessions.get", () => bridge.sessions.get(request)),
      create: (request) => unwrap("sessions.create", () => bridge.sessions.create(request)),
    },
    pipeline: {
      run: (request) => unwrap("pipeline.run", () => bridge.pipeline.run(request)),
      cancel: (request) => unwrap("pipeline.cancel", () => bridge.pipeline.cancel(request)),
    },
    runs: {
      subscribe: (request) => unwrap("runs.subscribe", () => bridge.runs.subscribe(request)),
      unsubscribe: (request) => unwrap("runs.unsubscribe", () => bridge.runs.unsubscribe(request)),
      onEvent: (listener) => bridge.runs.onEvent(listener),
    },
    settings: {
      get: () => unwrap("settings.get", bridge.settings.get),
      set: (request) => unwrap("settings.set", () => bridge.settings.set(request)),
    },
    sidecar: {
      status: () => unwrap("sidecar.status", bridge.sidecar.status),
      logs: (request = {}) => unwrap("sidecar.logs", () => bridge.sidecar.logs(request)),
    },
  };
}

function unavailableCall<T>(operation: TransportOperation): () => Promise<T> {
  return async () => {
    throw new UnavailableOperationError(operation);
  };
}

function unavailableTransport(): RendererTransport {
  const list = unavailableCall<SessionsListResponse>("sessions.list");
  const get = unavailableCall<SessionsGetResponse>("sessions.get");
  const create = unavailableCall<SessionsCreateResponse>("sessions.create");
  const run = unavailableCall<PipelineRunResponse>("pipeline.run");
  const cancel = unavailableCall<PipelineCancelResponse>("pipeline.cancel");
  const subscribe = unavailableCall<RunsSubscribeResponse>("runs.subscribe");
  const unsubscribe = unavailableCall<RunsUnsubscribeResponse>("runs.unsubscribe");
  const settingsGet = unavailableCall<SettingsGetResponse>("settings.get");
  const settingsSet = unavailableCall<SettingsSetResponse>("settings.set");
  const sidecarStatus = unavailableCall<SidecarStatusResponse>("sidecar.status");
  const sidecarLogs = unavailableCall<SidecarLogsResponse>("sidecar.logs");
  return {
    kind: "browser",
    sessions: { list, get, create },
    pipeline: { run, cancel },
    runs: {
      subscribe,
      unsubscribe,
      onEvent: () => {
        throw new UnavailableOperationError("runs.onEvent");
      },
    },
    settings: { get: settingsGet, set: settingsSet },
    sidecar: { status: sidecarStatus, logs: sidecarLogs },
  };
}

/** Detect the preload bridge without probing a network endpoint or localhost. */
export function createTransport(scope: unknown = globalThis): RendererTransport {
  const bridge = bridgeFromScope(scope);
  return bridge === null ? unavailableTransport() : electronTransport(bridge);
}

export function isUnavailableOperation(error: unknown): error is UnavailableOperationError {
  return error instanceof UnavailableOperationError;
}

export function errorMessage(error: unknown, fallback = "The operation failed"): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}
