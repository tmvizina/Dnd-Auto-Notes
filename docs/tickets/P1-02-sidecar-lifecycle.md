---
id: P1-02
phase: 1
title: Sidecar lifecycle from Node
status: todo
assignee: ""
depends_on: [P1-01, P0-06]
scope:
  - packages/core/src/sidecar/**
estimate: M
commit: ""
---

## Why
The CLI and the desktop app both need the sidecar up, and neither should care how. A half-started sidecar that reports healthy is worse than one that is plainly down.

## Do
1. `SidecarClient` — typed wrapper over the HTTP API: `health()`, `submit(kind, payload)` returning a job id, `poll(jobId)`, `cancel(jobId)`, and `runJob(kind, payload, { onProgress, signal })` that polls to completion with backoff and rejects on `error`/`cancelled`.
2. `SidecarSupervisor` — `ensureRunning()`: reuse an already-listening sidecar (probe `/health` first), otherwise spawn `uv run uvicorn ...` with the repo's `sidecar/` as cwd; wait for health with a timeout; write `.dnd/sidecar.json` with `{ pid, port, version, startedAt }`; `stop()` sends SIGTERM then SIGKILL after a grace period.
3. Port selection: honour `DND_SIDECAR_PORT`, else pick a free port and record it.
4. Env bootstrap check: if `uv` is missing or the venv is absent, fail with an actionable message naming the exact command to run — never attempt a silent install.
5. Capability gating: expose `requireCapability("mlx_whisper")` that throws a structured error naming the missing dependency and the install command, so a stage fails informatively instead of deep inside Python.
6. Stream sidecar stdout into `.dnd/logs/sidecar.log` with rotation.

## Acceptance
- [ ] `ensureRunning()` on a cold machine starts the sidecar and returns once `/health` answers.
- [ ] Called twice, it reuses the running process and does not spawn a second one.
- [ ] An externally started sidecar on the configured port is adopted, not duplicated.
- [ ] `stop()` leaves no orphan process (verified by pid check).
- [ ] Missing `uv` produces a message containing the literal command to fix it.
- [ ] `runJob` surfaces progress and honours an `AbortSignal` by calling the cancel endpoint.

## Notes
Never restart or kill a sidecar the user started by hand without asking — the supervisor adopts, it does not evict.
