# Tickets

One file per ticket, named `<id>-<slug>.md`. The file _is_ the state — there is no separate board. Status changes are ordinary edits and show up in `git log`.

## Format

```markdown
---
id: P1-03
phase: 1
title: Craig intake
status: todo # todo | in_progress | in_review | changes_requested | approved | done | blocked
assignee: ""
depends_on: [P0-06, P1-01]
scope:
  - packages/core/src/intake/**
  - packages/core/src/intake/*.test.ts
estimate: M # S (<2h) | M (half day) | L (1-2 days)
commit: "" # short SHA, filled by the orchestrator on done
---

## Why

One paragraph: what breaks or is impossible without this.

## Do

Numbered, specific implementation steps.

## Acceptance

Checklist of objectively verifiable statements.

## Verify

Exact commands to run, and what their output must show.

## Notes

Gotchas, references to prior art, links.
```

### Filling in `commit:`

A commit cannot contain its own SHA, so a ticket never lands as `done` in the same commit as its work. It lands as `approved`; the next commit flips it to `done` and records the short SHA. `npm run tickets -- --check` enforces the end state — a `done` ticket with an empty `commit` is an error — and stays green in between, because `approved` carries no such requirement.

`scope` is the worker's exclusive file boundary. Editing outside it is an automatic RETURN in review — see `docs/orchestration.md`.

## Dependency graph

```
P0-01 ─┬─ P0-02 ─ P0-03
       ├─ P0-04
       └─ P0-06 ─┬─ P0-05
                 │
                 ├─ P1-01 ─ P1-02 ──────────────┐
                 ├─ P1-03 ─┬─ P1-09 ─ P1-10     │
                 ├─ P1-04 ─ P1-05 ─ P1-06 ──────┤
                 ├─ P1-07 ─┘                    │
                 └─ P1-08 ─────────────────────┐│
                                               ││
   P2-01 ─ P2-02 ─ P2-03 ─┬─ P2-04 ─ P2-05 ────┴┴─┐
                          │                        │
                          ├─ P2-06 ─┐              │
                          └─ P2-09  ├─ P2-07 ─ P2-08 ─ P2-12
                                    │
                             P2-10 ─┴─ P2-11
                                       │
   P3-01 ─┬─ P3-02 ─┬─ P3-03 ─┬─ P3-06 ─ P3-07 ─ P3-08
          │         ├─ P3-04 ─┤
          │         └─ P3-05 ─┘
          │
   P4-01 ─ P4-02 ─ P4-03 ─┬─ P4-04
                          ├─ P4-05 ─ P4-06 ─┬─ P4-07
                          │                 ├─ P4-08
                          │                 └─ P4-09 ─ P4-10
                          └─ P4-11

   P5-01 ─ P5-02 ─ P5-03 ─ P5-04 ─ P5-05
```

## Parallel tracks

Once `P0-06` is in, three workers can run without colliding:

- **Track A — audio**: `P1-01`, `P1-02`, `P1-03`, then all of `P2-01`…`P2-05`
- **Track B — Roll20 & registry**: `P1-04`, `P1-05`, `P1-06`, `P1-07`
- **Track C — persistence & CLI**: `P1-08`, `P1-09`, `P1-10`

Phase 4 can start in parallel with phase 3 once `P3-01` fixes the event model, since the app reads the contracts rather than the implementations.

## Index

### Phase 0 — Foundations

- [P0-01](P0-01-repo-scaffold.md) — Repo scaffold, workspaces, TypeScript
- [P0-02](P0-02-test-harness.md) — Vitest, pytest, lint and format
- [P0-03](P0-03-ci.md) — CI: macOS primary, Windows smoke
- [P0-04](P0-04-ticket-tooling.md) — Ticket status tooling and handoff doc
- [P0-05](P0-05-synthetic-fixtures.md) — Synthetic session fixture generator
- [P0-06](P0-06-contracts-stage-runner.md) — Session contracts and the stage runner

### Phase 1 — Acquisition & persistence

- [P1-01](P1-01-sidecar-skeleton.md) — Python sidecar skeleton and job registry
- [P1-02](P1-02-sidecar-lifecycle.md) — Sidecar lifecycle from Node
- [P1-03](P1-03-craig-intake.md) — Craig recording intake
- [P1-04](P1-04-roll20-capture-script.md) — Roll20 browser capture script
- [P1-05](P1-05-roll20-parser.md) — Roll20 capture parser
- [P1-06](P1-06-roll20-timestamps.md) — Roll20 timestamp recovery
- [P1-07](P1-07-campaign-registry.md) — Campaign registry and identity mapping
- [P1-08](P1-08-sqlite-ledger.md) — SQLite schema and run ledger
- [P1-09](P1-09-intake-stage-cli.md) — Intake stage and `pipeline` CLI
- [P1-10](P1-10-intake-qa.md) — Intake QA report

### Phase 2 — Transcript & persona

- [P2-01](P2-01-vad.md) — VAD segmentation
- [P2-02](P2-02-asr.md) — ASR with word timestamps
- [P2-03](P2-03-timeline-merge.md) — Cross-track timeline merge
- [P2-04](P2-04-utterance-features.md) — Embeddings and prosody features
- [P2-05](P2-05-voice-profiles.md) — Voice-mode clustering and the profile bank
- [P2-06](P2-06-lexical-rules.md) — Lexical rule engine
- [P2-07](P2-07-persona-scorer.md) — Persona scorer and flagging
- [P2-08](P2-08-dm-npc.md) — DM to NPC assignment
- [P2-09](P2-09-roll-speech-align.md) — Roll ↔ speech time anchoring
- [P2-10](P2-10-adjudicator.md) — Adjudicator interface and providers
- [P2-11](P2-11-audio-adjudicator.md) — Audio-native adjudicator
- [P2-12](P2-12-labeling-calibration.md) — Labeling CLI and calibration

### Phase 3 — Outline & notes

- [P3-01](P3-01-event-model.md) — Event model and timeline assembly
- [P3-02](P3-02-beat-segmentation.md) — Beat segmentation
- [P3-03](P3-03-encounters.md) — Combat encounter reconstruction
- [P3-04](P3-04-checks-social.md) — Skill checks and social scenes
- [P3-05](P3-05-action-descriptions.md) — Action description extraction
- [P3-06](P3-06-notes-renderer.md) — Notes renderer
- [P3-07](P3-07-llm-prose-pass.md) — Grounded LLM prose pass
- [P3-08](P3-08-session-qa.md) — Session QA report

### Phase 4 — Desktop app

- [P4-01](P4-01-electron-scaffold.md) — Electron scaffold
- [P4-02](P4-02-ipc-contracts.md) — IPC contracts and validation
- [P4-03](P4-03-renderer-shell.md) — Renderer transport and shell
- [P4-04](P4-04-sidecar-supervision.md) — Sidecar supervision
- [P4-05](P4-05-sessions-intake-ui.md) — Sessions list and intake UI
- [P4-06](P4-06-run-streaming.md) — Pipeline run streaming
- [P4-07](P4-07-provider-runner.md) — Claude / Codex provider runner
- [P4-08](P4-08-review-page.md) — Flagged-span review page
- [P4-09](P4-09-notes-page.md) — Notes viewer and editor
- [P4-10](P4-10-pdf-export.md) — PDF export
- [P4-11](P4-11-settings.md) — Settings

### Phase 5 — Hardening & release

- [P5-01](P5-01-real-session-e2e.md) — Real-session end-to-end
- [P5-02](P5-02-performance.md) — Performance budgets
- [P5-03](P5-03-packaging.md) — Packaging and sidecar distribution
- [P5-04](P5-04-docs.md) — Documentation
- [P5-05](P5-05-release-qualification.md) — Release qualification
