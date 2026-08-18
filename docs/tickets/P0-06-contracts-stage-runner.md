---
id: P0-06
phase: 0
title: Session contracts and the stage runner
status: done
assignee: "orchestrator"
depends_on: [P0-01]
scope:
  - packages/core/src/contracts/**
  - packages/core/src/session/**
  - packages/core/src/stage/**
estimate: L
commit: "5104070"
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

- [x] Round-trip test per artifact: write, read, validator accepts; a mutated artifact is rejected with a useful message.
- [x] Re-running an unchanged stage returns `skipped: true` and leaves the artifact mtime untouched.
- [x] Changing one input byte causes a re-run.
- [x] Changing the stage version causes a re-run.
- [x] `force: true` always re-runs, including immediately after a successful run.
- [x] A throwing stage leaves the previous artifact intact and records `status: "error"`.
- [x] Artifact writes are atomic: a fault-injected kill mid-write leaves either the old file or the new one, never a truncated one.

## Notes

"Never blocks a re-run" is a hard project rule — see `AGENTS.md`. Model the stage-meta shape on Audio Forge's job record: `status`, `progress`, `message`, `error`, `created_at`, `finished_at`.

## Delivered

Zod for both types and runtime validation, one schema per artifact in `packages/core/src/contracts/`, paths frozen in `ARTIFACTS`, and `ARTIFACT_SCHEMAS` binding name to contract so `readArtifact`/`writeArtifact` are generic over the artifact name and still fully typed. 53 tests across contracts, session and stage; 90 in the suite overall.

`writeArtifact` validates **before** writing, so an artifact that violates its contract never reaches disk — the failure lands where it was caused rather than three stages later.

Two things the ticket did not ask for but the work demanded:

- **`persona` depended on a stage that ran after it.** The registry test "never requires an artifact no earlier stage produces" failed on the ordering taken straight from `docs/PLAN.md`: persona scores `roll_prox`, which needs anchored rolls from `align`. The real order is intake → transcript → features → **align → persona** → outline → notes. Artifact directories were renumbered to match (`work/04-align`, `work/05-persona`) and `docs/session-layout.md` corrected, which is outside the stated scope but leaving the contract and the doc contradicting each other would be worse.
- **`sessionIdFrom` mangled accented titles.** NFKD splits `é` into `e` plus a combining mark; the mark is neither Letter nor Number, so it became a separator and "Séance" slugged to `se-ance`. Combining marks are now stripped after normalisation.

Also: `src/testing/fixtures.ts` is excluded from `tsconfig.build.json`, so test-support code does not ship in `dist` — the same rule P4-07 applies to the deterministic fake runner.

Acceptance evidence, all from actual runs: round-trip and corruption tests are parameterised over every artifact; a re-run with nothing changed returns `skipped: true` and leaves the artifact's mtime untouched; one changed input byte, a bumped version, changed params, a deleted artifact, an unreadable `_stage.json`, and `force: true` each cause a re-run; params hashing ignores key order but respects array order; a throwing stage leaves the previous artifact byte-identical and records `status: "error"`; and injected `writeFile`/`rename` failures leave the old file intact with no temp file left behind.
