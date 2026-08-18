---
id: P1-09
phase: 1
title: Intake stage and the pipeline CLI
status: todo
assignee: ""
depends_on: [P1-03, P1-05, P1-06, P1-07, P1-08]
scope:
  - packages/core/src/stages/intake.ts
  - packages/cli/src/**
estimate: M
commit: ""
---

## Why

This is the first end-to-end path: two dropped files become a validated manifest. It is also the command every later stage plugs into, so its argument surface and progress reporting set the pattern.

## Do

1. `packages/core/src/stages/intake.ts` composes Craig intake, Roll20 parsing and timestamp resolution, and the campaign join into `work/01-intake/manifest.json` through `runStage`.
2. Join rolls to players via the registry, producing `rolls[].player_id`. Rolls whose Roll20 account is unmapped keep `player_id: null` and raise a QA error.
3. `pipeline` CLI:
   - `pipeline session new "<title>" [--date] [--number]` scaffolds the folder and prints where to drop the inputs.
   - `pipeline run --session <id> [--stage <name>|all] [--from <stage>] [--force] [--json]`
   - `pipeline status --session <id>` prints per-stage state, hashes, and last run time.
   - `pipeline qa --session <id>` prints the QA report.
4. Progress rendering: a plain readable line per stage on a TTY, NDJSON events on `--json` so the desktop app consumes the same runner.
5. Exit codes: `0` ok, `1` stage error, `2` QA errors present (the run completed but the result is not trustworthy).
6. Resolve a session by id, by folder path, or `--latest`.

## Acceptance

- [ ] `pipeline session new` then `pipeline run --stage intake` on the synthetic fixture produces a valid manifest.
- [ ] A second identical run reports `skipped` for intake and finishes in under a second.
- [ ] `--force` re-runs it.
- [ ] The `--with-defects` fixture exits 2 and names all three defects.
- [ ] `--json` emits parseable NDJSON with one terminal event.
- [ ] The CLI works from any working directory.

## Verify

```bash
node tools/generate-fixture.mjs --out sessions/fixture-a && npx pipeline run --session fixture-a --stage intake --json
```
