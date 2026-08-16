---
id: P0-06
phase: 0
title: Session contracts and the stage runner
status: todo
assignee: ""
depends_on: [P0-01]
scope:
  - packages/core/src/contracts/**
  - packages/core/src/session/**
  - packages/core/src/stage/**
estimate: L
commit: ""
---

## Why
Every later ticket reads and writes these shapes. Fixing them once, in one place, with runtime validation, is what lets three workers build different stages in parallel without integrating by hand.

## Do
1. `packages/core/src/contracts/` — one module per artifact in `docs/session-layout.md`: `manifest`, `utterances`, `features`, `attribution`, `timeline`, `events`, `qa`, `stageMeta`, plus `campaign` (players, npcs, lexicons, voice profiles). TypeScript types **and** runtime validators; pick one validation library and use it everywhere.
2. Freeze artifact paths in one constant object — `ARTIFACTS.transcript = "work/02-transcript/utterances.json"` and so on. No stage builds a path by concatenation.
3. `packages/core/src/session/` — `createSession`, `resolveSession(idOrPath)`, `readArtifact`, `writeArtifact` (atomic: temp file then rename), `sessionPaths`.
4. `packages/core/src/stage/runner.ts` — `runStage({ session, stage, version, inputs, params, force, onProgress }, fn)`:
   - sha256 every declared input file (streamed) and the params object;
   - read `_stage.json`; return `{ skipped: true }` when hashes, stage version and params hash all match and `force` is false;
   - otherwise run `fn`, write the artifact atomically, then write `_stage.json`;
   - on throw, write `_stage.json` with `status: "error"` and rethrow;
   - never delete a prior artifact before the replacement is safely written.
5. A `StageRegistry` mapping stage name to definition (inputs, output artifact, version) so the CLI and the app enumerate stages from one source.

## Acceptance
- [ ] Round-trip test per artifact: write, read, validator accepts; a mutated artifact is rejected with a useful message.
- [ ] Re-running an unchanged stage returns `skipped: true` and leaves the artifact mtime untouched.
- [ ] Changing one input byte causes a re-run.
- [ ] Changing the stage version causes a re-run.
- [ ] `force: true` always re-runs, including immediately after a successful run.
- [ ] A throwing stage leaves the previous artifact intact and records `status: "error"`.
- [ ] Artifact writes are atomic: a fault-injected kill mid-write leaves either the old file or the new one, never a truncated one.

## Notes
"Never blocks a re-run" is a hard project rule — see `AGENTS.md`. Model the stage-meta shape on Audio Forge's job record: `status`, `progress`, `message`, `error`, `created_at`, `finished_at`.
