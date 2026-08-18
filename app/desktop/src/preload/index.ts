import { contextBridge, ipcRenderer } from "electron";
import {
  CHANNELS,
  ContractValidationError,
  ERROR_CODES,
  IPC_LIMITS,
  assertSerializedBytes,
  errorFromUnknown,
  failure,
  success,
  validateOutboundEvent,
  validateRequest,
  validateResponseEnvelope,
  type DesktopEvent,
  type IpcEnvelope,
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
  type SidecarStatusEvent,
  type SidecarLogsRequest,
  type SidecarLogsResponse,
} from "../shared/contracts.js";

/** Minimal renderer transport, allowing the bridge to be tested without Electron. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export type EventListener = (event: DesktopEvent) => void;
export type Unsubscribe = () => void;

export interface DesktopBridge {
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
    readonly onEvent: (listener: EventListener) => Unsubscribe;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invoke<TRequest, TResponse>(
  renderer: IpcRendererLike,
  channel: string,
  request: TRequest,
): Promise<IpcEnvelope<TResponse>> {
  return (async () => {
    try {
      // Validate before structured-cloning into Electron. The main process
      // validates again because preload code is not an authority boundary.
      const checked = validateRequest(channel, request);
      const requestEnvelope = success(checked);
      assertSerializedBytes(requestEnvelope, IPC_LIMITS.maxRequestBytes, "IPC request");
      const raw = await renderer.invoke(channel, requestEnvelope);
      try {
        assertSerializedBytes(raw, IPC_LIMITS.maxResponseBytes, "IPC response");
        const response = validateResponseEnvelope(channel, raw);
        return response as unknown as IpcEnvelope<TResponse>;
      } catch (error) {
        if (error instanceof ContractValidationError && error.code === ERROR_CODES.payloadTooLarge)
          return failure(errorFromUnknown(error, ERROR_CODES.payloadTooLarge));
        return failure({ code: ERROR_CODES.invalidResponse, message: "IPC response was invalid" });
      }
    } catch (error) {
      const fallback =
        error instanceof ContractValidationError
          ? ERROR_CODES.invalidRequest
          : ERROR_CODES.internal;
      return failure(errorFromUnknown(error, fallback));
    }
  })();
}

function freezeBridge(bridge: DesktopBridge): DesktopBridge {
  Object.freeze(bridge.sessions);
  Object.freeze(bridge.pipeline);
  Object.freeze(bridge.runs);
  Object.freeze(bridge.settings);
  Object.freeze(bridge.sidecar);
  return Object.freeze(bridge);
}

/** Build the sole object that is exposed to the untrusted renderer. */
export function buildBridge(renderer: IpcRendererLike): DesktopBridge {
  const bridge: DesktopBridge = {
    sessions: {
      list: (request: SessionsListRequest = {}) =>
        invoke<SessionsListRequest, SessionsListResponse>(
          renderer,
          CHANNELS.sessions.list,
          request,
        ),
      get: (request) =>
        invoke<SessionsGetRequest, SessionsGetResponse>(renderer, CHANNELS.sessions.get, request),
      create: (request) =>
        invoke<SessionsCreateRequest, SessionsCreateResponse>(
          renderer,
          CHANNELS.sessions.create,
          request,
        ),
    },
    pipeline: {
      run: (request) =>
        invoke<PipelineRunRequest, PipelineRunResponse>(renderer, CHANNELS.pipeline.run, request),
      cancel: (request) =>
        invoke<PipelineCancelRequest, PipelineCancelResponse>(
          renderer,
          CHANNELS.pipeline.cancel,
          request,
        ),
    },
    runs: {
      subscribe: (request) =>
        invoke<RunsSubscribeRequest, RunsSubscribeResponse>(
          renderer,
          CHANNELS.runs.subscribe,
          request,
        ),
      unsubscribe: (request) =>
        invoke<RunsUnsubscribeRequest, RunsUnsubscribeResponse>(
          renderer,
          CHANNELS.runs.unsubscribe,
          request,
        ),
      onEvent: (listener) => {
        const receive = (_event: unknown, payload: unknown): void => {
          try {
            const candidate =
              isRecord(payload) && payload["ok"] === true ? payload["value"] : payload;
            listener(validateOutboundEvent(candidate));
          } catch {
            // An event is best effort. Invalid or over-deep data is dropped at
            // the last hop rather than becoming a renderer exception.
          }
        };
        renderer.on(CHANNELS.runs.event, receive);
        return () => renderer.removeListener(CHANNELS.runs.event, receive);
      },
    },
    settings: {
      get: () =>
        invoke<Record<string, never>, SettingsGetResponse>(renderer, CHANNELS.settings.get, {}),
      set: (request) =>
        invoke<SettingsSetRequest, SettingsSetResponse>(renderer, CHANNELS.settings.set, request),
    },
    sidecar: {
      status: () =>
        invoke<Record<string, never>, SidecarStatusResponse>(renderer, CHANNELS.sidecar.status, {}),
      logs: (request: SidecarLogsRequest = {}) =>
        invoke<SidecarLogsRequest, SidecarLogsResponse>(renderer, CHANNELS.sidecar.logs, request),
    },
  };
  return freezeBridge(bridge);
}

/** The one global name; no Electron object is reachable from this value. */
export const BRIDGE_NAME = "dnd";

const bridge = buildBridge(ipcRenderer as unknown as IpcRendererLike);
contextBridge.exposeInMainWorld(BRIDGE_NAME, bridge);

export type SidecarEvent = SidecarStatusEvent;
