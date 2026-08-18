import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";
import { registerIpcHandlers } from "./ipc.js";
import { getUiRoot, getUserDataPaths, type DesktopUserDataPaths } from "./paths.js";
import { createUiUrl, isAllowedUiUrl, registerUiProtocol, registerUiScheme } from "./uiProtocol.js";

const DEV_URL_ENV = ["DND_DEV_SERVER_URL", "VITE_DEV_SERVER_URL", "ELECTRON_RENDERER_URL"] as const;
const UI_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let mainWindow: BrowserWindow | null = null;
let rendererOrigin: string | undefined;
let rendererUrl: string | undefined;
let removeIpcHandlers: (() => void) | null = null;
let networkBlockInstalled = false;
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
    .then(() => {
      const paths = configureUserDataPaths();
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
}
