---
id: P5-04
phase: 5
title: Documentation
status: todo
assignee: ""
depends_on: [P5-03]
scope:
  - docs/getting-started.md
  - docs/runbook.md
  - docs/troubleshooting.md
  - README.md
estimate: M
commit: ""
---

## Why
The person running this six months from now will have forgotten every detail, and the most fragile step — capturing Roll20 before the session starts — has to happen at the table with no time to read.

## Do
1. `docs/getting-started.md` — from a fresh machine to a first `session.md`: install, sidecar setup, campaign registry, the Roll20 capture script, dropping the Craig download, running the pipeline.
2. `docs/runbook.md` — the per-session routine as a checklist, written to be followed at the table: start Craig, start the capture script, and what to do after the session ends. One page.
3. `docs/troubleshooting.md` — organised by symptom, not by component: unmapped player, missing rolls, wrong character attribution, sidecar will not start, ASR is slow, CLI not found, notes look thin.
4. Update `README.md` with real quickstart commands once they exist.
5. Every command in the docs is copy-pasteable and has actually been run.

## Acceptance
- [ ] Someone following getting-started on a clean machine produces notes without asking a question.
- [ ] The runbook fits on one page and is usable during a session.
- [ ] Every documented symptom has a cause and a fix.
- [ ] Every command block was executed as written.
