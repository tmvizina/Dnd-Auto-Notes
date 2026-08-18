---
id: P0-04
phase: 0
title: Ticket status tooling and handoff doc
status: approved
assignee: "orchestrator"
depends_on: [P0-01]
scope:
  - tools/tickets.mjs
  - docs/HANDOFF.md
estimate: S
commit: ""
---

## Why

The orchestrator needs to answer "what is ready to assign" mechanically rather than by reading forty files, and needs one place where the state of the build is written down truthfully between sessions.

## Do

1. `tools/tickets.mjs` parses the YAML frontmatter of every `docs/tickets/P*.md` and supports:
   - `--status` — table of id, phase, status, assignee, blocked reason.
   - `--ready` — `status: todo` tickets whose `depends_on` are all `done`.
   - `--check` — validates: unknown status value, unknown dependency id, dependency cycle, a `done` ticket with an empty `commit`, and overlapping `scope` globs between two `in_progress` tickets. Non-zero exit on any problem.
2. Wire `npm run tickets`.
3. Create `docs/HANDOFF.md` with: current state, a commit checkpoint table (`| SHA | Ticket | Scope | Validated |`), known risks, and **exact next actions** as a numbered list.

## Acceptance

- [x] `--ready` lists exactly the tickets with satisfied dependencies.
- [x] `--check` detects an injected cycle and an unknown dependency id.
- [x] Overlapping scope between two `in_progress` tickets is reported.
- [x] `docs/HANDOFF.md` exists with all four sections.

## Verify

```bash
npm run tickets -- --check && npm run tickets -- --ready
```

## Delivered

`tools/tickets.mjs`, dependency-free, exporting its logic so it is testable: `--status` (default), `--ready`, `--check`. 21 tests in `test/tickets.test.ts` cover the frontmatter parser, readiness, every validation, and the real backlog.

`--check` validates more than the ticket asked for, because each extra case is one an orchestrator would otherwise hit at 2am: malformed frontmatter, missing or duplicate id, unknown status, `done` with no commit, `blocked` with no reason, empty scope, unknown dependency, dependency cycle, and overlapping scope between two `in_progress` tickets.

Two notes:

- **Scope overlap is deliberately conservative.** It compares the fixed path prefix each glob can never escape, so it can over-report a pair a full glob intersection would clear, and can never miss a real collision. For a boundary check that is the safe direction to be wrong in.
- **A commit cannot contain its own SHA**, so `status: done` plus a filled `commit:` can never land in the same commit as the work. The ladder already has the answer: a ticket lands as `approved`, and the next commit flips it to `done` with the SHA. `--check` stays green throughout, and `docs/tickets/README.md` now says so.

`docs/HANDOFF.md` already had all four required sections from the planning commit; it gains the P0-01/P0-02/P0-04 checkpoints here.
