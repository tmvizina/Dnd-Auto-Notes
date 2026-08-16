---
id: P1-08
phase: 1
title: SQLite schema and run ledger
status: todo
assignee: ""
depends_on: [P0-06]
scope:
  - packages/core/src/db/**
estimate: M
commit: ""
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
- [ ] Opening a fresh database creates the schema; opening it again is a no-op.
- [ ] An additive migration applies to an older database without data loss.
- [ ] `reindexSession` reproduces identical rows after the database file is deleted.
- [ ] Orphaned runs are resolved on the next open.
- [ ] Concurrent read while a write is in flight does not fail (WAL is actually on).
- [ ] No table is ever the only home of a piece of information.

## Notes
Exactly one process opens this file. A second writer silently loses rows and makes reads report corruption — this is a scar from Audio Forge, not a theory. The sidecar never touches it.
