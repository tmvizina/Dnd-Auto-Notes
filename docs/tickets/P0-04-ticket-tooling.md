---
id: P0-04
phase: 0
title: Ticket status tooling and handoff doc
status: todo
assignee: ""
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
- [ ] `--ready` lists exactly the tickets with satisfied dependencies.
- [ ] `--check` detects an injected cycle and an unknown dependency id.
- [ ] Overlapping scope between two `in_progress` tickets is reported.
- [ ] `docs/HANDOFF.md` exists with all four sections.

## Verify
```bash
npm run tickets -- --check && npm run tickets -- --ready
```
