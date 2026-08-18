---
id: P4-01
phase: 4
title: Electron scaffold
status: approved
assignee: "orchestrator"
depends_on: [P0-06]
scope:
  - app/desktop/**
  - electron-builder.yml
  - package.json
  - package-lock.json
estimate: M
commit: ""
---

## Why

The security posture of an Electron app is decided in the first hundred lines and is painful to retrofit. This app reads local files and spawns CLIs, so the shell is locked down before any feature lands.

## Do

1. `app/desktop` workspace: `src/main`, `src/preload`, `src/shared`. Main and shared build with `tsc` (ESM); preload bundles to a single CJS file with esbuild, external `electron`.
2. `BrowserWindow` with `contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true`, plus `requestSingleInstanceLock`, `will-navigate` and `will-redirect` guards, `setWindowOpenHandler` denying by default, `setPermissionCheckHandler(() => false)`, and `will-attach-webview` prevented.
3. Dev loads the renderer URL from an env var **only when `!app.isPackaged`**; packaged serves built assets over a registered privileged custom scheme with a CSP. A packaged build must never hand the preload bridge to env-selected content.
4. `app.getPath("userData")` layout: `data/` (SQLite), `logs/`, `sessions/` default root.
5. electron-builder config for dmg and nsis, `asar: true`, `asarUnpack` for `better-sqlite3`, explicit `electron-rebuild` step rather than implicit npmRebuild.
6. A window that opens, shows a version string, and exposes nothing else yet.

## Acceptance

- [x] `npm run dev` opens a window loading the Vite dev server.
- [x] A packaged build opens the same window from the custom scheme with the CSP applied.
- [x] `window.require` and `process` are undefined in the renderer.
- [x] Navigation to an external URL is blocked; `window.open` is denied.
- [x] A second launch focuses the existing window.
- [x] The packaged app starts with no network access.

## Notes

Mirror `Manuscript-Work/app/desktop/src/main/main.ts` and `uiProtocol.ts` — they already solve exactly this and have been through review.
