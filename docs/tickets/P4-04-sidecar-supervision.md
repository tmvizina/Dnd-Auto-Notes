---
id: P4-04
phase: 4
title: Sidecar supervision from the main process
status: in_progress
assignee: "luna-p4-04"
depends_on: [P4-02, P1-02]
scope:
  - app/desktop/src/main/sidecar/**
  - app/desktop/src/main/main.ts
  - app/desktop/src/main/main.test.ts
  - app/desktop/src/main/ipc.ts
  - app/desktop/src/main/ipc.test.ts
  - app/desktop/src/shared/contracts.ts
  - app/desktop/src/shared/contracts.test.ts
  - app/desktop/src/preload/index.ts
  - app/desktop/src/preload/index.test.ts
  - packages/core/src/sidecar/supervisor.ts
  - packages/core/src/sidecar/supervisor.test.ts
estimate: M
commit: ""
---

## Why

In the CLI the user starts the sidecar knowingly. In the app it has to be invisible when it works and obvious when it does not — including the very common case where the Python environment simply is not set up yet.

## Do

1. Wrap `SidecarSupervisor` from `P1-02`: start on demand rather than at launch (a user who only wants to read notes should not pay for a model host), stop on quit, and restart on repeated health failure with backoff and a cap.
2. Surface state to the renderer as a push event: `stopped | starting | ready | unhealthy | unavailable`, with the reason and, where relevant, the exact command to fix it.
3. First-run onboarding path: detect a missing `uv` or venv and present the setup command with a copy button. **Never install anything without explicit confirmation.**
4. Tail sidecar logs into the app's log directory and expose the last N lines in the UI for troubleshooting.
5. Adopt an externally running sidecar rather than starting a second one, and never terminate a sidecar the app did not start.
6. Health polling backs off when idle so an open, unused app is not busy.

## Acceptance

- [ ] Starting a pipeline run with the sidecar stopped starts it and proceeds.
- [ ] Killing the sidecar mid-run surfaces `unhealthy` and fails the run with a clear message rather than hanging.
- [ ] A missing venv produces the setup command in the UI and installs nothing.
- [ ] Quitting the app leaves no orphan Python process.
- [ ] An externally started sidecar is adopted and is still running after the app quits.
- [ ] Idle polling costs under 1 % CPU.
