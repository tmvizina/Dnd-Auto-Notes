import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session, shell } from "electron";
import { registerIpcHandlers, sendOutboundEvent, type IpcHandlerMap } from "./ipc.js";
import {
  asIpcSessionHandlers,
  createSessionHandlers,
  resolvePipelineSessionRoot,
  runSessionIntake,
  type SessionHandlers,
} from "./handlers/sessions.js";
import {
  asIpcSettingsHandlers,
  createSettingsHandlers,
  type SettingsMap,
  type SettingsHandlers,
} from "./handlers/settings.js";
import { getUiRoot, getUserDataPaths, type DesktopUserDataPaths } from "./paths.js";
import { DesktopSidecarSupervisor, type SidecarState } from "./sidecar/index.js";
import { structuredError, type DesktopEvent, type RunEvent } from "../shared/contracts.js";
import { createUiUrl, isAllowedUiUrl, registerUiProtocol, registerUiScheme } from "./uiProtocol.js";
import { openDb, type Db } from "@dnd/core";
import { RunManager } from "./runs/index.js";

const DEV_URL_ENV = ["DND_DEV_SERVER_URL", "VITE_DEV_SERVER_URL", "ELECTRON_RENDERER_URL"] as const;
const UI_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let mainWindow: BrowserWindow | null = null;
let rendererOrigin: string | undefined;
let rendererUrl: string | undefined;
let removeIpcHandlers: (() => void) | null = null;
let networkBlockInstalled = false;
let sidecar: DesktopSidecarSupervisor | null = null;
let eventSequence = 0;
let quitStopPromise: Promise<void> | null = null;
let quitRequested = false;
let sessionHandlers: SessionHandlers | null = null;
let desktopPaths: DesktopUserDataPaths | null = null;
let settingsHandlers: SettingsHandlers | null = null;
let runtimeSettings: SettingsMap = {};
let desktopDb: Db | null = null;
let runManager: RunManager | null = null;
const mainDirectory = dirname(fileURLToPath(import.meta.url));

function localDevUrl(): string | null {
  for (const key of DEV_URL_ENV) {
    const raw = process.env[key];
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        !UI_ORIGIN_HOSTS.has(url.hostname)
      ) {
        continue;
      }
      return url.toString();
    } catch {
      console.error(`[desktop] ignoring invalid renderer URL from ${key}`);
    }
  }
  return null;
}

function configureUserDataPaths(): DesktopUserDataPaths {
  const paths = getUserDataPaths(app.getPath("userData"));
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.sessions, { recursive: true });
  app.setAppLogsPath(paths.logs);
  return paths;
}

function desktopRepoRoot(): string {
  return (
    process.env["DND_REPO_ROOT"] ??
    (app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "..", ".."))
  );
}

function sidecarEvent(state: SidecarState): Record<string, unknown> {
  return {
    type: "sidecar_status",
    status: state.status,
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    ...(state.setupCommand === undefined ? {} : { setupCommand: state.setupCommand }),
  };
}

export function createAcceptedPipelineRunTracker(emit: (event: DesktopEvent) => void) {
  const runs = new Map<string, AbortController>();
  return {
    accept(runId: string, controller: AbortController): void {
      runs.set(runId, controller);
    },
    cancel(runId: string): boolean {
      const controller = runs.get(runId);
      if (controller === undefined) return false;
      controller.abort();
      runs.delete(runId);
      return true;
    },
    complete(runId: string): void {
      runs.delete(runId);
    },
    fail(reason: string, code: "unhealthy" | "unavailable"): void {
      const error = structuredError(code, `Pipeline run failed because the sidecar ${reason}`);
      for (const [runId, controller] of runs) {
        controller.abort();
        emit({ type: "run_failed", sequence: ++eventSequence, runId, error });
        runs.delete(runId);
      }
    },
  };
}

const acceptedPipelineRuns = createAcceptedPipelineRunTracker((event) => {
  if (mainWindow !== null) sendOutboundEvent(mainWindow.webContents, event);
});

function failAcceptedPipelineRuns(reason: string, code: "unhealthy" | "unavailable"): void {
  acceptedPipelineRuns.fail(reason, code);
}

function handleSidecarState(state: SidecarState): void {
  if (state.status === "unhealthy" || state.status === "unavailable") {
    failAcceptedPipelineRuns(state.status, state.status);
  }
  if (mainWindow !== null) sendOutboundEvent(mainWindow.webContents, sidecarEvent(state));
}

function stopSidecarOnce(): Promise<void> {
  if (quitStopPromise !== null) return quitStopPromise;
  quitStopPromise = sidecar?.stop() ?? Promise.resolve();
  return quitStopPromise;
}

export function createQuitStopper(
  supervisor: Pick<DesktopSidecarSupervisor, "stop">,
): () => Promise<void> {
  let stopPromise: Promise<void> | null = null;
  return () => {
    if (stopPromise === null) stopPromise = supervisor.stop();
    return stopPromise;
  };
}

export function sidecarRepoRootForSetting(
  configuredPath: string | undefined,
  fallback: string,
): string {
  if (configuredPath === undefined || configuredPath.trim() === "") return fallback;
  const configured = resolve(configuredPath);
  return basename(configured).toLowerCase() === "sidecar" ? dirname(configured) : configured;
}

export function runtimeRootsForSettings(
  settings: SettingsMap,
  defaults: Readonly<{
    readonly sessionsRoot: string;
    readonly campaignRoot: string;
    readonly sidecarRepoRoot: string;
  }>,
): {
  readonly sessionsRoot: string;
  readonly campaignRoot: string;
  readonly sidecarRepoRoot: string;
} {
  return {
    sessionsRoot: settings.sessionsRoot ?? defaults.sessionsRoot,
    campaignRoot: settings.campaignRoot ?? defaults.campaignRoot,
    sidecarRepoRoot: sidecarRepoRootForSetting(settings.sidecarPath, defaults.sidecarRepoRoot),
  };
}

function setupSidecar(paths: DesktopUserDataPaths, settings: SettingsMap): void {
  const roots = runtimeRootsForSettings(settings, {
    sessionsRoot: paths.sessions,
    campaignRoot: campaignRootForDesktop(settings),
    sidecarRepoRoot: desktopRepoRoot(),
  });
  sidecar = new DesktopSidecarSupervisor({
    repoRoot: roots.sidecarRepoRoot,
    stateDir: paths.userData,
    logDir: paths.logs,
  });
  sidecar.onState(handleSidecarState, false);
}

function campaignRootForDesktop(settings: SettingsMap = runtimeSettings): string {
  return (
    settings.campaignRoot ?? process.env["DND_CAMPAIGN_ROOT"] ?? join(desktopRepoRoot(), "campaign")
  );
}

function setupSessionHandlers(paths: DesktopUserDataPaths, settings: SettingsMap): void {
  const roots = runtimeRootsForSettings(settings, {
    sessionsRoot: paths.sessions,
    campaignRoot: campaignRootForDesktop(settings),
    sidecarRepoRoot: desktopRepoRoot(),
  });
  desktopDb?.close();
  desktopDb = openDb(join(paths.data, "notes.db"));
  runManager = new RunManager({ db: desktopDb });
  sessionHandlers = createSessionHandlers({
    sessionsRoot: roots.sessionsRoot,
    db: desktopDb,
    campaignRoot: roots.campaignRoot,
    emitCopyProgress: (event) => {
      if (mainWindow !== null)
        sendOutboundEvent(mainWindow.webContents, {
          ...event,
          sequence: ++eventSequence,
        });
    },
    revealPath: async (path) => {
      const failure = await shell.openPath(path);
      if (failure !== "") throw new Error(failure);
      return true;
    },
  });
}

async function setupSettingsHandlers(paths: DesktopUserDataPaths): Promise<SettingsMap> {
  settingsHandlers = createSettingsHandlers({
    settingsPath: join(paths.data, "settings.json"),
    revealPath: async (path) => {
      const failure = await shell.openPath(path);
      if (failure !== "") throw new Error(failure);
      return true;
    },
  });
  return (await settingsHandlers.settingsGet()).settings;
}

interface PipelineRuntimeOptions {
  readonly sessionsRoot: string;
  readonly campaignRoot: string;
  readonly emit?: (event: DesktopEvent) => void;
  readonly manager?: RunManager;
}

function runtimeEmitter(options: PipelineRuntimeOptions): (event: DesktopEvent) => void {
  return (
    options.emit ??
    ((event: DesktopEvent) => {
      if (mainWindow !== null) sendOutboundEvent(mainWindow.webContents, event);
    })
  );
}

type RunEventPayload = {
  [Kind in RunEvent["type"]]: Omit<Extract<RunEvent, { type: Kind }>, "sequence">;
}[RunEvent["type"]];

function emitRunEvent(emit: (event: DesktopEvent) => void, event: RunEventPayload): void {
  emit({ ...event, sequence: ++eventSequence } as DesktopEvent);
}

function startPipelineRun(
  runId: string,
  request: {
    readonly sessionId: string;
    readonly stages?: readonly string[];
    readonly force?: boolean;
  },
  controller: AbortController,
  options: PipelineRuntimeOptions,
): void {
  const emit = runtimeEmitter(options);
  const stage = request.stages?.[0] ?? "intake";
  void (async () => {
    emitRunEvent(emit, {
      type: "stage_started",
      runId,
      stage,
      at: new Date().toISOString(),
    });
    try {
      if (stage !== "intake" || (request.stages?.length ?? 1) !== 1) {
        throw new Error(`stage ${stage} is not implemented yet`);
      }
      const sessionRoot = await resolvePipelineSessionRoot(options.sessionsRoot, request.sessionId);
      const result = await runSessionIntake({
        sessionRoot,
        campaignRoot: options.campaignRoot,
        force: request.force === true,
        onProgress: (fraction, message) => {
          if (controller.signal.aborted) return;
          emitRunEvent(emit, { type: "stage_progress", runId, stage, progress: fraction, message });
        },
      });
      if (controller.signal.aborted) throw new Error("pipeline run was cancelled");
      if (result.skipped) emitRunEvent(emit, { type: "stage_skipped", runId, stage });
      else
        emitRunEvent(emit, {
          type: "stage_completed",
          runId,
          stage,
          durationS: Math.max(0, Math.round(result.meta.duration_s)),
        });
      emitRunEvent(emit, { type: "run_completed", runId });
    } catch (error) {
      const message =
        error instanceof Error && error.message !== "" ? error.message : "pipeline run failed";
      const failure = structuredError(
        controller.signal.aborted ? "cancelled" : "internal_error",
        message,
      );
      emitRunEvent(emit, { type: "stage_failed", runId, stage, error: failure });
      emitRunEvent(emit, { type: "run_failed", runId, error: failure });
    } finally {
      acceptedPipelineRuns.complete(runId);
    }
  })();
}

function startManagedPipelineRun(
  runId: string,
  request: {
    readonly sessionId: string;
    readonly stages?: readonly string[];
    readonly force?: boolean;
  },
  controller: AbortController,
  options: PipelineRuntimeOptions,
): string {
  const manager = options.manager;
  if (manager === undefined) throw new Error("run manager is unavailable");
  const stages =
    request.stages === undefined || request.stages.length === 0 ? ["intake"] : request.stages;
  const handle = manager.run({
    runId,
    sessionId: request.sessionId,
    stages,
    signal: controller.signal,
    onCancel: () => controller.abort(),
    producer: async (context) => {
      for (const stage of stages) {
        context.stageStarted(stage);
        if (stage !== "intake" || stages.length !== 1)
          throw new Error(`stage ${stage} is not implemented yet`);
        const sessionRoot = await resolvePipelineSessionRoot(
          options.sessionsRoot,
          request.sessionId,
        );
        const result = await runSessionIntake({
          sessionRoot,
          campaignRoot: options.campaignRoot,
          force: request.force === true,
          signal: context.signal,
          onProgress: (fraction, message) => {
            if (!context.signal.aborted) context.stageProgress(stage, fraction, message);
          },
        });
        if (context.signal.aborted) throw new Error("pipeline run was cancelled");
        if (result.skipped) context.emit({ type: "stage_skipped", stage });
        else
          context.emit({
            type: "stage_completed",
            stage,
            durationS: Math.max(0, Math.round(result.meta.duration_s)),
          });
      }
    },
  });
  manager.subscribe({ runId: handle.runId }, (event) => {
    const emit = runtimeEmitter(options);
    emit(event);
  });
  void handle.done.finally(() => acceptedPipelineRuns.complete(handle.runId));
  return handle.runId;
}

export function createSidecarHandlers(
  supervisor: Pick<DesktopSidecarSupervisor, "state" | "ensureRunning" | "getLogTail"> & {
    readonly client?: () => {
      readonly health: () => Promise<{ readonly capabilities?: Readonly<Record<string, boolean>> }>;
    };
  },
  pipelineOptions?: PipelineRuntimeOptions,
): IpcHandlerMap {
  return {
    sidecarStatus: async () => {
      const state = supervisor.state;
      let capabilities: Readonly<Record<string, boolean>> | undefined;
      if (state.status === "ready" && supervisor.client !== undefined) {
        try {
          capabilities = (await supervisor.client().health()).capabilities;
        } catch {
          // The status still remains useful when a health refresh races a restart.
        }
      }
      return {
        status: state.status,
        ...(state.reason === undefined ? {} : { reason: state.reason }),
        ...(state.setupCommand === undefined ? {} : { setupCommand: state.setupCommand }),
        ...(capabilities === undefined ? {} : { capabilities }),
      };
    },
    sidecarLogs: async ({ maxLines }: { maxLines?: number }) => ({
      lines: await supervisor.getLogTail(maxLines),
    }),
    pipelineRun: async (request: {
      sessionId: string;
      stages?: readonly string[];
      force?: boolean;
    }) => {
      await supervisor.ensureRunning();
      const runId = randomUUID();
      const controller = new AbortController();
      acceptedPipelineRuns.accept(runId, controller);
      if (pipelineOptions?.manager !== undefined) {
        startManagedPipelineRun(runId, request, controller, pipelineOptions);
        return { runId };
      }
      if (pipelineOptions !== undefined)
        startPipelineRun(runId, request, controller, pipelineOptions);
      return { runId };
    },
    pipelineCancel: async ({ runId }: { runId: string }) => {
      if (pipelineOptions?.manager !== undefined) {
        try {
          return {
            cancelled: await pipelineOptions.manager.cancel(runId, "pipeline run cancelled"),
          };
        } catch {
          return { cancelled: false };
        }
      }
      return { cancelled: acceptedPipelineRuns.cancel(runId) };
    },
    runsSubscribe: (request) => {
      if (pipelineOptions?.manager === undefined) throw new Error("run manager is unavailable");
      return pipelineOptions.manager.subscribe(request, (event) => {
        if (mainWindow !== null) sendOutboundEvent(mainWindow.webContents, event);
      });
    },
    runsUnsubscribe: ({ subscriptionId }) => ({
      unsubscribed: pipelineOptions?.manager?.unsubscribe(subscriptionId) ?? false,
    }),
  };
}

function sidecarHandlers(): IpcHandlerMap {
  const sessions = sessionHandlers === null ? {} : asIpcSessionHandlers(sessionHandlers);
  const settings = settingsHandlers === null ? {} : asIpcSettingsHandlers(settingsHandlers);
  const pipeline =
    sidecar === null || desktopPaths === null
      ? {}
      : createSidecarHandlers(sidecar, {
          sessionsRoot: runtimeSettings.sessionsRoot ?? desktopPaths.sessions,
          campaignRoot: campaignRootForDesktop(),
          ...(runManager === null ? {} : { manager: runManager }),
        });
  return { ...sessions, ...settings, ...pipeline };
}

function installNetworkBlock(): void {
  if (!app.isPackaged || networkBlockInstalled) return;
  networkBlockInstalled = true;
  session.defaultSession.webRequest.onBeforeRequest(
    {
      urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
    },
    (details, callback) => {
      console.error(`[desktop] blocked packaged network request: ${details.url}`);
      callback({ cancel: true });
    },
  );
}

function installNavigationGuards(window: BrowserWindow): void {
  const guard = (event: Electron.Event, url: string): void => {
    if (isAllowedUiUrl(url, rendererOrigin)) return;
    event.preventDefault();
    console.error(`[desktop] blocked renderer navigation: ${url}`);
  };

  window.webContents.on("will-navigate", guard);
  window.webContents.on("will-redirect", guard);
  window.webContents.setWindowOpenHandler(({ url }) => {
    console.error(`[desktop] blocked renderer window-open: ${url}`);
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

async function loadRenderer(window: BrowserWindow, uiRoot: string): Promise<void> {
  // A packaged build must never grant the preload bridge to content selected
  // through a mutable development environment variable.
  const devUrl = app.isPackaged ? null : localDevUrl();
  if (devUrl) {
    rendererOrigin = new URL(devUrl).origin;
    rendererUrl = devUrl;
    removeIpcHandlers?.();
    removeIpcHandlers = registerIpcHandlers({
      expectedSenderId: window.webContents.id,
      expectedOrigin: () => rendererOrigin ?? "",
      expectedFrameUrl: () => rendererUrl ?? "",
      handlers: sidecarHandlers(),
    });
    await window.loadURL(devUrl);
    return;
  }

  rendererOrigin = "dnd-auto-notes://app";
  registerUiProtocol(uiRoot);
  rendererUrl = createUiUrl(`index.html?version=${encodeURIComponent(app.getVersion())}`);
  removeIpcHandlers?.();
  removeIpcHandlers = registerIpcHandlers({
    expectedSenderId: window.webContents.id,
    expectedOrigin: () => rendererOrigin ?? "",
    expectedFrameUrl: () => rendererUrl ?? "",
    handlers: sidecarHandlers(),
  });
  await window.loadURL(rendererUrl);
}

export async function createMainWindow(): Promise<BrowserWindow> {
  const uiRoot = getUiRoot({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });

  const window = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: join(mainDirectory, "..", "preload", "index.cjs"),
    },
  });

  installNavigationGuards(window);
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      removeIpcHandlers?.();
      removeIpcHandlers = null;
    }
  });

  mainWindow = window;
  try {
    await loadRenderer(window, uiRoot);
    if (sidecar !== null) sendOutboundEvent(window.webContents, sidecarEvent(sidecar.state));
  } catch (error) {
    console.error("[desktop] renderer failed to load", error);
  }
  return window;
}

// Custom schemes must be registered before app.ready.
registerUiScheme();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  void app
    .whenReady()
    .then(async () => {
      const paths = configureUserDataPaths();
      desktopPaths = paths;
      const settings = await setupSettingsHandlers(paths);
      runtimeSettings = settings;
      setupSidecar(paths, settings);
      setupSessionHandlers(paths, settings);
      installNetworkBlock();
      console.error(`[desktop] userData=${paths.userData}`);
      void createMainWindow();
    })
    .catch((error: unknown) => {
      console.error("[desktop] application startup failed", error);
      app.quit();
    });

  app.on("activate", () => {
    if (!mainWindow) {
      void createMainWindow();
      return;
    }
    mainWindow.show();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitRequested) return;
    quitRequested = true;
    event.preventDefault();
    void stopSidecarOnce().finally(() => {
      sessionHandlers?.dispose();
      sessionHandlers = null;
      desktopDb?.close();
      desktopDb = null;
      runManager = null;
      app.quit();
    });
  });
}
