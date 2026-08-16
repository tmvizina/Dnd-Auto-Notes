---
id: P4-03
phase: 4
title: Renderer transport and app shell
status: todo
assignee: ""
depends_on: [P4-02]
scope:
  - app/ui/**
estimate: M
commit: ""
---

## Why
The UI should not know or care that it is inside Electron. A transport abstraction keeps components testable in a plain browser and leaves a headless HTTP mode available later without a rewrite.

## Do
1. `app/ui` — React 18 plus Vite, hash routing, no router library.
2. `createTransport()` detects the preload bridge and returns the Electron transport; otherwise a stub that throws `unavailable("<operation>")` for every call. It must never silently fall back to `localhost`.
3. Shell: a left rail (Sessions, Review, Notes, Settings), a header with the current session, and a status strip showing sidecar health, active runs and provider availability.
4. Loading, empty and error states are designed as first-class, since most of this app's states are "nothing has been processed yet".
5. Keep it lightweight: no component library, no state-management framework, no CSS-in-JS runtime. Plain CSS with custom properties, and a theme that follows the OS.
6. Every list is virtualised past a few hundred rows — a session has thousands of utterances.

## Acceptance
- [ ] The app renders in the packaged shell and in a plain browser (with operations reporting unavailable).
- [ ] All four routes reachable; deep links restore on reload.
- [ ] The status strip reflects real sidecar health.
- [ ] A 5,000-row list scrolls at 60 fps.
- [ ] No external network requests are issued at any point.
