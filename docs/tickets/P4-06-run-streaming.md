---
id: P4-06
phase: 4
title: Pipeline run streaming
status: in_progress
assignee: "luna-p4-06"
depends_on: [P4-05]
scope:
  - app/desktop/src/main/runs/**
  - app/ui/src/components/RunPanel.tsx
  - app/ui/src/components/runPanel.test.tsx
  - app/desktop/src/shared/contracts.ts
  - app/desktop/src/shared/contracts.test.ts
  - app/desktop/src/main/ipc.ts
  - app/desktop/src/main/ipc.test.ts
  - app/desktop/src/preload/index.ts
  - app/desktop/src/preload/index.test.ts
  - app/desktop/src/main/main.ts
  - app/desktop/src/main/main.test.ts
  - app/desktop/src/main/handlers/sessions.ts
  - app/desktop/src/main/handlers/sessions.test.ts
  - app/ui/src/transport.ts
  - app/ui/src/transport.test.ts
  - app/ui/src/App.tsx
  - packages/core/src/stage/runner.ts
  - packages/core/src/stage/runner.test.ts
  - packages/core/src/stages/intake.ts
  - packages/core/src/stages/intake.test.ts
estimate: L
commit: ""
---

## Why

Stages take minutes to hours. Progress has to be live, resumable across a window reload, and honest about failure — a stalled run that looks busy is the worst possible outcome for a four-hour job.

## Do

1. `RunManager` in main: owns run ids, assigns a monotonic `sequence` to every event, keeps a capped replay buffer, and finalises runs by synthesising a terminal event if the producer never emitted one.
2. Replay-safe subscription: `subscribe` registers live delivery **before** snapshotting the buffer, and returns `{ subscriptionId, replay, replayCursor, replayTruncated }`. The renderer de-dupes by sequence and detects gaps.
3. Events: `stage_started`, `stage_progress`, `stage_skipped`, `stage_completed`, `stage_failed`, `run_completed`, `run_failed`, `log`.
4. Cancellation from the UI propagates to the sidecar job and to any child process.
5. Persist every run to `stage_runs`; a run interrupted by a crash is resolved to `interrupted` on next launch, never left `running`.
6. `RunPanel` shows per-stage state, elapsed time, progress and the last log line, with cancel and a collapsible log.
7. Reloading the window mid-run reattaches and replays without duplicate or missing events.

## Acceptance

- [ ] A full pipeline run streams per-stage progress to completion.
- [ ] Reloading mid-run reattaches with no gaps and no duplicates.
- [ ] Cancel stops the run and the sidecar job within seconds.
- [ ] A crashed app leaves no run stuck in `running` after relaunch.
- [ ] Replay truncation is reported rather than silently dropping history.
- [ ] Two concurrent runs on different sessions do not interleave events.
