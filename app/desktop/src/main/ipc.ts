import { ipcMain } from "electron";
import {
  CHANNELS,
  ContractValidationError,
  ERROR_CODES,
  IPC_LIMITS,
  assertSerializedBytes,
  type FailureEnvelope,
  errorFromUnknown,
  failure,
  sanitizeOutboundEvent,
  success,
  structuredError,
  validateRequestEnvelope,
  validateResponse,
  validateResponseEnvelope,
  validateOutboundEvent,
  type IpcEnvelope,
  type IpcRequest,
  type IpcResponse,
  type PipelineCancelRequest,
  type PipelineCancelResponse,
  type PipelineRunRequest,
  type PipelineRunResponse,
  type RunsSubscribeRequest,
  type RunsSubscribeResponse,
  type RunsUnsubscribeRequest,
  type RunsUnsubscribeResponse,
  type SessionsCreateRequest,
  type SessionsCreateResponse,
  type SessionsGetRequest,
  type SessionsGetResponse,
  type SessionsListRequest,
  type SessionsListResponse,
  type SettingsSetRequest,
  type SettingsSetResponse,
  type SettingsGetResponse,
  type SidecarStatusResponse,
  type SidecarLogsRequest,
  type SidecarLogsResponse,
  type DesktopEvent,
} from "../shared/contracts.js";

/** The subset of Electron's ipcMain used here, kept injectable for tests. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcInvokeEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface IpcSenderFrame {
  readonly url: string;
  readonly parent?: IpcSenderFrame | null;
}

export interface IpcSender {
  readonly id: number;
}

/** Only these fields are read from an Electron invoke event. */
export interface IpcInvokeEvent {
  readonly sender: IpcSender;
  readonly senderFrame?: IpcSenderFrame | null;
}

export interface IpcHandlerContext {
  readonly event: IpcInvokeEvent;
  readonly senderId: number;
}

export interface IpcHandlerMap {
  sessionsList?: (
    request: SessionsListRequest,
    context: IpcHandlerContext,
  ) => SessionsListResponse | Promise<SessionsListResponse>;
  sessionsGet?: (
    request: SessionsGetRequest,
    context: IpcHandlerContext,
  ) => SessionsGetResponse | Promise<SessionsGetResponse>;
  sessionsCreate?: (
    request: SessionsCreateRequest,
    context: IpcHandlerContext,
  ) => SessionsCreateResponse | Promise<SessionsCreateResponse>;
  pipelineRun?: (
    request: PipelineRunRequest,
    context: IpcHandlerContext,
  ) => PipelineRunResponse | Promise<PipelineRunResponse>;
  pipelineCancel?: (
    request: PipelineCancelRequest,
    context: IpcHandlerContext,
  ) => PipelineCancelResponse | Promise<PipelineCancelResponse>;
  runsSubscribe?: (
    request: RunsSubscribeRequest,
    context: IpcHandlerContext,
  ) => RunsSubscribeResponse | Promise<RunsSubscribeResponse>;
  runsUnsubscribe?: (
    request: RunsUnsubscribeRequest,
    context: IpcHandlerContext,
  ) => RunsUnsubscribeResponse | Promise<RunsUnsubscribeResponse>;
  settingsGet?: (context: IpcHandlerContext) => SettingsGetResponse | Promise<SettingsGetResponse>;
  settingsSet?: (
    request: SettingsSetRequest,
    context: IpcHandlerContext,
  ) => SettingsSetResponse | Promise<SettingsSetResponse>;
  sidecarStatus?: (
    context: IpcHandlerContext,
  ) => SidecarStatusResponse | Promise<SidecarStatusResponse>;
  sidecarLogs?: (
    request: SidecarLogsRequest,
    context: IpcHandlerContext,
  ) => SidecarLogsResponse | Promise<SidecarLogsResponse>;
}

export interface IpcRegistrationOptions {
  /** The BrowserWindow webContents id captured at composition time. */
  readonly expectedSenderId: number;
  /** The exact renderer origin, e.g. dnd-auto-notes://app or a local dev origin. */
  readonly expectedOrigin: string | (() => string);
  /** Exact URL of the trusted top-level document, including its path/query. */
  readonly expectedFrameUrl: string | (() => string);
  readonly handlers?: IpcHandlerMap;
  readonly ipcMain?: IpcMainLike;
}

const ipcMainLike = (): IpcMainLike => ipcMain as unknown as IpcMainLike;

function originKey(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (!parsed.protocol || !parsed.hostname || parsed.username || parsed.password) return null;
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function canonicalUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (!parsed.protocol || !parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Return null only when both webContents identity and frame origin are trusted. */
export function validateIpcSender(
  event: IpcInvokeEvent,
  expectedSenderId: number,
  expectedOrigin: string | (() => string),
  expectedFrameUrl?: string | (() => string),
): ReturnType<typeof structuredError> | null {
  try {
    if (!event.sender || event.sender.id !== expectedSenderId)
      return structuredError(
        ERROR_CODES.forbiddenSender,
        "IPC sender is not the application window",
      );
  } catch {
    return structuredError(ERROR_CODES.forbiddenSender, "IPC sender could not be verified");
  }

  let frameUrl: string | undefined;
  try {
    frameUrl = event.senderFrame?.url;
  } catch {
    frameUrl = undefined;
  }
  if (frameUrl === undefined || frameUrl.length === 0)
    return structuredError(ERROR_CODES.forbiddenFrame, "IPC frame is not available");

  // ipcMain's senderFrame can be a child frame even when its origin matches
  // the app. The bridge belongs only to the trusted top-level document.
  try {
    if (
      event.senderFrame !== undefined &&
      event.senderFrame !== null &&
      event.senderFrame.parent !== undefined &&
      event.senderFrame.parent !== null
    )
      return structuredError(ERROR_CODES.forbiddenFrame, "IPC frame is not the main frame");
  } catch {
    return structuredError(ERROR_CODES.forbiddenFrame, "IPC frame hierarchy could not be verified");
  }

  let allowedOrigin: string | null;
  try {
    allowedOrigin = originKey(
      typeof expectedOrigin === "function" ? expectedOrigin() : expectedOrigin,
    );
  } catch {
    allowedOrigin = null;
  }
  if (allowedOrigin === null || originKey(frameUrl) !== allowedOrigin)
    return structuredError(ERROR_CODES.forbiddenFrame, "IPC frame origin is not trusted");

  let trustedFrameUrl: string | undefined;
  try {
    trustedFrameUrl =
      typeof expectedFrameUrl === "function" ? expectedFrameUrl() : expectedFrameUrl;
  } catch {
    trustedFrameUrl = undefined;
  }
  if (trustedFrameUrl === undefined || canonicalUrl(frameUrl) !== canonicalUrl(trustedFrameUrl))
    return structuredError(
      ERROR_CODES.forbiddenFrame,
      "IPC frame URL is not the trusted main document",
    );
  return null;
}

const isFailureEnvelope = (value: unknown): value is FailureEnvelope =>
  typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

function handlerUnavailable(): FailureEnvelope {
  return failure(
    structuredError(ERROR_CODES.unavailable, "This desktop operation is not available yet"),
  );
}

function boundedFailure(error: unknown, fallbackCode: string): FailureEnvelope {
  const candidate = failure(errorFromUnknown(error, fallbackCode));
  try {
    assertSerializedBytes(candidate, IPC_LIMITS.maxResponseBytes, "IPC response");
    return candidate;
  } catch {
    return failure(
      structuredError(ERROR_CODES.payloadTooLarge, "IPC error response exceeds its byte limit"),
    );
  }
}

async function dispatch(
  operation: keyof IpcHandlerMap,
  request: IpcRequest,
  context: IpcHandlerContext,
  handlers: IpcHandlerMap,
): Promise<unknown> {
  switch (operation) {
    case "sessionsList":
      return handlers.sessionsList === undefined
        ? handlerUnavailable()
        : handlers.sessionsList(request as SessionsListRequest, context);
    case "sessionsGet":
      return handlers.sessionsGet === undefined
        ? handlerUnavailable()
        : handlers.sessionsGet(request as SessionsGetRequest, context);
    case "sessionsCreate":
      return handlers.sessionsCreate === undefined
        ? handlerUnavailable()
        : handlers.sessionsCreate(request as SessionsCreateRequest, context);
    case "pipelineRun":
      return handlers.pipelineRun === undefined
        ? handlerUnavailable()
        : handlers.pipelineRun(request as PipelineRunRequest, context);
    case "pipelineCancel":
      return handlers.pipelineCancel === undefined
        ? handlerUnavailable()
        : handlers.pipelineCancel(request as PipelineCancelRequest, context);
    case "runsSubscribe":
      return handlers.runsSubscribe === undefined
        ? handlerUnavailable()
        : handlers.runsSubscribe(request as RunsSubscribeRequest, context);
    case "runsUnsubscribe":
      return handlers.runsUnsubscribe === undefined
        ? handlerUnavailable()
        : handlers.runsUnsubscribe(request as RunsUnsubscribeRequest, context);
    case "settingsGet":
      return handlers.settingsGet === undefined
        ? handlerUnavailable()
        : handlers.settingsGet(context);
    case "settingsSet":
      return handlers.settingsSet === undefined
        ? handlerUnavailable()
        : handlers.settingsSet(request as SettingsSetRequest, context);
    case "sidecarStatus":
      return handlers.sidecarStatus === undefined
        ? handlerUnavailable()
        : handlers.sidecarStatus(context);
    case "sidecarLogs":
      return handlers.sidecarLogs === undefined
        ? handlerUnavailable()
        : handlers.sidecarLogs(request as SidecarLogsRequest, context);
  }
}

const CHANNEL_OPERATIONS: ReadonlyArray<readonly [string, keyof IpcHandlerMap]> = [
  [CHANNELS.sessions.list, "sessionsList"],
  [CHANNELS.sessions.get, "sessionsGet"],
  [CHANNELS.sessions.create, "sessionsCreate"],
  [CHANNELS.pipeline.run, "pipelineRun"],
  [CHANNELS.pipeline.cancel, "pipelineCancel"],
  [CHANNELS.runs.subscribe, "runsSubscribe"],
  [CHANNELS.runs.unsubscribe, "runsUnsubscribe"],
  [CHANNELS.settings.get, "settingsGet"],
  [CHANNELS.settings.set, "settingsSet"],
  [CHANNELS.sidecar.status, "sidecarStatus"],
  [CHANNELS.sidecar.logs, "sidecarLogs"],
];

/**
 * Register every request channel with the same identity, request, and response
 * checks. The returned function is useful when a test or a window is rebuilt.
 */
export function registerIpcHandlers(options: IpcRegistrationOptions): () => void {
  const target = options.ipcMain ?? ipcMainLike();
  const handlers = options.handlers ?? {};

  for (const [channel, operation] of CHANNEL_OPERATIONS) {
    target.handle(channel, async (event, ...args) => {
      const senderError = validateIpcSender(
        event,
        options.expectedSenderId,
        options.expectedOrigin,
        options.expectedFrameUrl,
      );
      if (senderError !== null) return failure(senderError);

      try {
        if (args.length !== 1)
          throw new ContractValidationError(
            ERROR_CODES.invalidRequest,
            "IPC request must contain exactly one envelope",
          );
        assertSerializedBytes(args[0], IPC_LIMITS.maxRequestBytes, "IPC request");
        const request = validateRequestEnvelope(channel, args[0]);
        const rawResponse = await dispatch(operation, request, eventContext(event), handlers);
        if (isFailureEnvelope(rawResponse)) {
          // Validate injected errors as well; an accidental stack field must
          // never be forwarded just because a handler supplied the envelope.
          try {
            const bounded = validateResponseEnvelope(channel, rawResponse);
            assertSerializedBytes(bounded, IPC_LIMITS.maxResponseBytes, "IPC response");
            return bounded;
          } catch (error) {
            if (
              error instanceof ContractValidationError &&
              error.code === ERROR_CODES.payloadTooLarge
            )
              return boundedFailure(error, ERROR_CODES.payloadTooLarge);
            return failure(
              structuredError(ERROR_CODES.invalidResponse, "IPC handler returned an invalid error"),
            );
          }
        }
        try {
          const response = validateResponse(channel, rawResponse);
          const bounded = success(response);
          assertSerializedBytes(bounded, IPC_LIMITS.maxResponseBytes, "IPC response");
          return bounded;
        } catch {
          try {
            assertSerializedBytes(rawResponse, IPC_LIMITS.maxResponseBytes, "IPC response");
          } catch (error) {
            return boundedFailure(error, ERROR_CODES.invalidResponse);
          }
          return failure(
            structuredError(
              ERROR_CODES.invalidResponse,
              "IPC handler returned an invalid response",
            ),
          );
        }
      } catch (error) {
        return boundedFailure(error, ERROR_CODES.internal);
      }
    });
  }

  return () => {
    for (const [channel] of CHANNEL_OPERATIONS) target.removeHandler(channel);
  };
}

export const installIpcHandlers = registerIpcHandlers;

function eventContext(event: IpcInvokeEvent): IpcHandlerContext {
  return { event, senderId: event.sender.id };
}

export interface WebContentsLike {
  send(channel: string, payload: unknown): void;
}

/** Sanitise and envelope push events before they are sent to a renderer. */
export function sendOutboundEvent(target: WebContentsLike, event: DesktopEvent | unknown): boolean {
  const sanitized = sanitizeOutboundEvent(event);
  if (sanitized === null) return false;
  try {
    const canonical = validateOutboundEvent(sanitized);
    target.send(CHANNELS.runs.event, success(canonical));
    return true;
  } catch {
    return false;
  }
}

/** Convert a local error to a response without exposing its stack. */
export function rejectedResponse(error: unknown): IpcEnvelope<IpcResponse> {
  if (error instanceof ContractValidationError) return failure(errorFromUnknown(error, error.code));
  return failure(errorFromUnknown(error, ERROR_CODES.internal));
}
