---
id: P4-02
phase: 4
title: IPC contracts and validation
status: todo
assignee: ""
depends_on: [P4-01]
scope:
  - app/desktop/src/shared/**
  - app/desktop/src/main/ipc.ts
  - app/desktop/src/preload/**
estimate: M
commit: ""
---

## Why

The preload bridge is the only hole in the sandbox. Every payload crossing it is untrusted in both directions, and one frozen contract file is what keeps main, preload and renderer from drifting apart.

## Do

1. `src/shared/contracts.ts` — one frozen object of namespaced channel names (`dnd/sessions/list`, `dnd/pipeline/run`, `dnd/runs/event`, …), the request and response DTOs, the event union, and every limit constant. This is the single source; nothing hard-codes a channel string.
2. All request/response traffic through `ipcMain.handle` / `ipcRenderer.invoke`, wrapped in a discriminated envelope `{ ok: true, value } | { ok: false, error: StructuredError }`. Errors carry a stable `code`, never a raw stack.
3. Validate three times: in preload before invoking, in main on receipt (including `event.sender` identity and frame-URL checks), and on the response before it crosses back. `assertOnlyKeys` rejects unknown request fields.
4. `contextBridge.exposeInMainWorld` exposes exactly one object, built from `ipcRenderer` inside the preload; `ipcRenderer` itself never leaks.
5. Sanitise outbound events: strip raw lines, internal paths, command strings and session ids from anything pushed to the renderer, with cycle- and depth-guarded serialisation.
6. Settings writes are key-allow-listed.

## Acceptance

- [ ] Every channel name comes from the frozen contract; a grep finds no literal channel strings elsewhere.
- [ ] An unknown request field is rejected.
- [ ] A forged sender or frame URL is rejected.
- [ ] Sanitisation removes every field on the deny list, proven by a test over a synthetic event with all of them.
- [ ] Cyclic or over-deep payloads fail safely.
- [ ] A rejected write of a non-allow-listed settings key returns a structured error.
