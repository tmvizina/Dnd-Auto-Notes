---
id: P1-08
phase: 1
title: SQLite schema and run ledger
status: done
assignee: "orchestrator"
depends_on: [P0-06]
scope:
  - packages/core/src/db/**
estimate: M
commit: "da278f1"
---

## Why

JSON on disk is the source of truth, but the app needs to list sessions, show run history, and query flagged spans without opening every artifact. The database is an index and a ledger — and it must never become a second source of truth.

## Do

1. `better-sqlite3`, WAL, `foreign_keys = ON`, idempotent `schema.sql` of `CREATE TABLE IF NOT EXISTS`, plus additive-only `ALTER TABLE ADD COLUMN` migrations. Ids are prefixed (`run_ab12cd34`).
2. Tables:
   - `sessions` — id, title, number, date, folder path, status, counts, timestamps.
   - `stage_runs` — id, session id, stage, version, status, started/finished, duration, skipped, error, params hash.
   - `agent_runs` — id, session id, provider, model, prompt, permission mode, status, result text, error, transcript path, turns, duration, cost, tokens. Modelled on Manuscript-Work's `agent_runs`.
   - `flags` — id, session id, utterance id, code, reason, status (`open`|`resolved`|`dismissed`), resolution, resolved_by, resolved_at.
   - `settings` — key/value.
3. `resolveOrphanedRuns()` at startup flips any `queued`/`running` row to `interrupted`, so a crash does not leave a run pinned forever.
4. `reindexSession(sessionDir)` rebuilds every row for a session from its artifacts. Deleting the database must cost nothing but time.
5. Never store secrets; provider credentials are env or keychain references only.

## Acceptance

- [x] Opening a fresh database creates the schema; opening it again is a no-op.
- [x] An additive migration applies to an older database without data loss.
- [x] `reindexSession` reproduces identical rows after the database file is deleted.
- [x] Orphaned runs are resolved on the next open.
- [x] Concurrent read while a write is in flight does not fail (WAL is actually on).
- [x] No table is ever the only home of a piece of information.

## Notes

Exactly one process opens this file. A second writer silently loses rows and makes reads report corruption — this is a scar from Audio Forge, not a theory. The sidecar never touches it.

## Delivered

`packages/core/src/db/` — schema, migrations, prefixed ids, record writers for sessions / stage runs / agent runs / flags / settings, orphan resolution, and `reindexSession` / `reindexAll`. 27 tests.

`better-sqlite3` 13.0.3 ships prebuilds for Node 24 on Windows, so the ticket's choice works as written — no fallback to `node:sqlite` needed. `@types/better-sqlite3` added.

Two deliberate departures:

- **The schema is `schema.ts`, not `schema.sql`.** A loose `.sql` file needs a copy step in the build, and a missed copy is a runtime failure typechecking cannot catch — the database opens and then fails on first query. Embedding makes it impossible to ship a build without its schema.
- **`flags` has a unique index on `(session_id, stage, code, COALESCE(utterance_id, ''))`.** The ticket did not ask for it, but stages re-run constantly and the review UI must not sprout duplicates. More importantly it makes re-running safe for _resolutions_: `upsertFlag` updates the reason and leaves `status` alone, so re-running persona never undoes a human's decision. That is tested directly.

Verified: a fresh database creates the schema and re-opening is a no-op with data intact; WAL and foreign keys are read back from the pragmas rather than assumed; a stage run for a non-existent session is rejected and deleting a session cascades to its stage runs while agent runs survive with a null session; `resolveOrphanedRuns` converts `running` rows to `interrupted` and leaves finished ones alone; `reindexSession` after deleting the database file produces byte-identical rows; reindexing twice does not double the history; a stale stage row with no `_stage.json` is dropped rather than merged; and a read on a second connection succeeds while a write transaction is open, which is what WAL is for.

The disposability test is the important one: if a rebuild ever produced different rows, the database would be holding a fact that lives nowhere else — which is the bug this design exists to prevent.
