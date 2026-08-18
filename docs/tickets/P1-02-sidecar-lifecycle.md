---
id: P1-02
phase: 1
title: Sidecar lifecycle from Node
status: done
assignee: "orchestrator"
depends_on: [P1-01, P0-06]
scope:
  - packages/core/src/sidecar/**
estimate: M
commit: "630bf36"
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

- [x] `ensureRunning()` on a cold machine starts the sidecar and returns once `/health` answers.
- [x] Called twice, it reuses the running process and does not spawn a second one.
- [x] An externally started sidecar on the configured port is adopted, not duplicated.
- [x] `stop()` leaves no orphan process (verified by pid check).
- [x] Missing `uv` produces a message containing the literal command to fix it.
- [x] `runJob` surfaces progress and honours an `AbortSignal` by calling the cancel endpoint.

## Notes

Never restart or kill a sidecar the user started by hand without asking — the supervisor adopts, it does not evict.

## Delivered

`packages/core/src/sidecar/` — `client.ts` (typed HTTP wrapper with `runJob` polling to completion), `supervisor.ts` (spawn, adopt, health-wait, record, stop) and `errors.ts` (structured `SidecarError` carrying a remedy). 19 tests, four of which start the real sidecar.

One real bug, caught by a test rather than review: **aborting during submission left the job running.** The abort listener cannot be attached before `submit` resolves — there is no job id yet — so a caller who aborted in that window abandoned a live job on the sidecar, and an orphaned Whisper run holds the GPU gate against everything else. `runJob` now checks `signal.aborted` immediately after submit.

Design points worth keeping:

- **Adoption, not eviction.** A developer running `uvicorn --reload` in a terminal is adopted rather than duplicated or killed, and `stop()` refuses to touch a process it did not start. Tested: an adopting supervisor stops, and the original is still serving.
- **`uv` preferred, virtualenv accepted, nothing installed.** `resolveLauncher` reports the exact command instead of running it — installing `uv` is machine-wide software and needs the human's say-so.
- **Poll interval backs off** from 50 ms to 2 s, so a four-hour transcription is not polled forty thousand times while a two-second probe still returns promptly.

Verified: the supervisor starts the real sidecar and `/health` answers; a second `ensureRunning()` returns the same pid rather than spawning a rival; an externally started sidecar is adopted with `ownedByUs: false` and survives the adopter's `stop()`; after `stop()` the pid is gone (checked with `process.kill(pid, 0)`); the record lands on disk and the log file is created; and a missing environment produces a message containing a runnable command.
