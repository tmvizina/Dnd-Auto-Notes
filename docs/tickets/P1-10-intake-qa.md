---
id: P1-10
phase: 1
title: Intake QA report
status: in_progress
assignee: "luna-p1-10"
depends_on: [P1-09]
scope:
  - packages/core/src/qa/**
  - packages/core/src/index.ts
  - packages/core/src/stages/intake.ts
  - packages/core/src/stages/intake.test.ts
  - packages/cli/src/cli.ts
  - packages/cli/src/config.ts
  - packages/cli/src/config.test.ts
  - packages/cli/src/pipeline.test.ts
estimate: S
commit: ""
---

## Why

Every failure mode in this project is silent. A wrong track binding, a missing player, a Roll20 capture from the wrong evening — none of these throw, they just produce confident nonsense four stages later. The QA report is where they surface while they are still cheap to fix.

## Do

1. A `QaReport` of `{ code, severity: "error"|"warning"|"info", message, subject, hint }` entries, with stable codes.
2. Intake checks:
   - `TRACK_UNMAPPED` (error) — a Craig track with no player, listing top candidates.
   - `ROLL20_ACCOUNT_UNMAPPED` (error) — rolls attributed to nobody.
   - `PLAYER_NO_TRACK` (warning) — a registry player active this session with no audio.
   - `TRACK_SILENT` (warning) — `speech_ratio` under 0.5 %.
   - `TRACK_DURATION_MISMATCH` (error) — outside the alignment tolerance.
   - `ROLL20_WINDOW_MISMATCH` (warning) — events outside the recording window.
   - `TIME_BASIS_ORDER_ONLY` (info) — alignment will rely on `P2-09`.
   - `ROLL20_UNPARSED_MESSAGES` (warning) — count and a sample.
3. Render as a terminal table and as `work/01-intake/qa.json`; every entry carries a `hint` naming the concrete fix ("add `roll20.account_name: \"Maddie R.\"` to `pl_maddie` in campaign/players.json").
4. Mirror open entries into the `flags` table for the desktop app.
5. Errors set exit code 2 for the whole run; warnings do not.

## Acceptance

- [ ] Each code above fires on a purpose-built fixture and on none of the clean ones.
- [ ] Every entry has an actionable hint naming a file and a field.
- [ ] The clean synthetic fixture produces zero errors.
- [ ] `--with-defects` produces exactly its three defects and no false positives.
- [ ] Codes are stable and documented in one place.
