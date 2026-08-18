# Ticket progress

Single-page status snapshot for the full backlog. Ticket frontmatter remains authoritative; update this file whenever a ticket changes status or records its implementation commit.

**Last updated:** 2026-08-18
**Overall:** 18 done, 3 in progress, 1 blocked, 30 todo - 52 total (34.6% done)

## Phase 0 — Foundations

| Ticket                                           | Status  | Assignee     | Commit    | Title                                                                       |
| ------------------------------------------------ | ------- | ------------ | --------- | --------------------------------------------------------------------------- |
| [P0-01](tickets/P0-01-repo-scaffold.md)          | done    | orchestrator | `55541d9` | Repo scaffold, workspaces, TypeScript                                       |
| [P0-02](tickets/P0-02-test-harness.md)           | done    | orchestrator | `06dd168` | Vitest, pytest, lint and format                                             |
| [P0-03](tickets/P0-03-ci.md)                     | blocked | orchestrator | `ab2cf9f` | CI: macOS primary, Windows smoke — needs an approved push for a real CI run |
| [P0-04](tickets/P0-04-ticket-tooling.md)         | done    | orchestrator | `c5dba79` | Ticket status tooling and handoff doc                                       |
| [P0-05](tickets/P0-05-synthetic-fixtures.md)     | done    | orchestrator | `5229b93` | Synthetic session fixture generator                                         |
| [P0-06](tickets/P0-06-contracts-stage-runner.md) | done    | orchestrator | `5104070` | Session contracts and the stage runner                                      |

## Phase 1 — Acquisition and persistence

| Ticket                                          | Status      | Assignee     | Commit    | Title                                    |
| ----------------------------------------------- | ----------- | ------------ | --------- | ---------------------------------------- |
| [P1-01](tickets/P1-01-sidecar-skeleton.md)      | done        | orchestrator | `42d7e12` | Python sidecar skeleton and job registry |
| [P1-02](tickets/P1-02-sidecar-lifecycle.md)     | done        | orchestrator | `630bf36` | Sidecar lifecycle from Node              |
| [P1-03](tickets/P1-03-craig-intake.md)          | done        | orchestrator | `58bc17b` | Craig recording intake                   |
| [P1-04](tickets/P1-04-roll20-capture-script.md) | done        | luna-p1-04b  | `f4dfd33` | Roll20 browser capture script            |
| [P1-05](tickets/P1-05-roll20-parser.md)         | done        | orchestrator | `25f969a` | Roll20 capture parser                    |
| [P1-06](tickets/P1-06-roll20-timestamps.md)     | done        | luna-p1-06   | `5dd325b` | Roll20 timestamp recovery                |
| [P1-07](tickets/P1-07-campaign-registry.md)     | done        | orchestrator | `0223f88` | Campaign registry and identity mapping   |
| [P1-08](tickets/P1-08-sqlite-ledger.md)         | done        | orchestrator | `da278f1` | SQLite schema and run ledger             |
| [P1-09](tickets/P1-09-intake-stage-cli.md)      | done        | luna-p1-09   | `ee50c13` | Intake stage and the pipeline CLI        |
| [P1-10](tickets/P1-10-intake-qa.md)             | in_progress | luna-p1-10   | -         | Intake QA report                         |

## Phase 2 — Transcript and persona

| Ticket                                         | Status      | Assignee   | Commit | Title                                           |
| ---------------------------------------------- | ----------- | ---------- | ------ | ----------------------------------------------- |
| [P2-01](tickets/P2-01-vad.md)                  | in_progress | luna-p2-01 | -      | VAD segmentation                                |
| [P2-02](tickets/P2-02-asr.md)                  | todo        | —          | —      | ASR with word timestamps                        |
| [P2-03](tickets/P2-03-timeline-merge.md)       | todo        | —          | —      | Cross-track timeline merge                      |
| [P2-04](tickets/P2-04-utterance-features.md)   | todo        | —          | —      | Utterance embeddings and prosody features       |
| [P2-05](tickets/P2-05-voice-profiles.md)       | todo        | —          | —      | Voice-mode clustering and campaign profile bank |
| [P2-06](tickets/P2-06-lexical-rules.md)        | todo        | —          | —      | Lexical rule engine                             |
| [P2-07](tickets/P2-07-persona-scorer.md)       | todo        | —          | —      | Persona scorer and flagging                     |
| [P2-08](tickets/P2-08-dm-npc.md)               | todo        | —          | —      | DM-to-NPC assignment                            |
| [P2-09](tickets/P2-09-roll-speech-align.md)    | todo        | —          | —      | Roll-to-speech time anchoring                   |
| [P2-10](tickets/P2-10-adjudicator.md)          | todo        | —          | —      | Adjudicator interface and providers             |
| [P2-11](tickets/P2-11-audio-adjudicator.md)    | todo        | —          | —      | Audio-native adjudicator                        |
| [P2-12](tickets/P2-12-labeling-calibration.md) | todo        | —          | —      | Labeling CLI and calibration                    |

## Phase 3 — Outline and notes

| Ticket                                        | Status | Assignee | Commit | Title                             |
| --------------------------------------------- | ------ | -------- | ------ | --------------------------------- |
| [P3-01](tickets/P3-01-event-model.md)         | todo   | —        | —      | Event model and timeline assembly |
| [P3-02](tickets/P3-02-beat-segmentation.md)   | todo   | —        | —      | Beat segmentation                 |
| [P3-03](tickets/P3-03-encounters.md)          | todo   | —        | —      | Combat encounter reconstruction   |
| [P3-04](tickets/P3-04-checks-social.md)       | todo   | —        | —      | Skill checks and social scenes    |
| [P3-05](tickets/P3-05-action-descriptions.md) | todo   | —        | —      | Action description extraction     |
| [P3-06](tickets/P3-06-notes-renderer.md)      | todo   | —        | —      | Notes renderer                    |
| [P3-07](tickets/P3-07-llm-prose-pass.md)      | todo   | —        | —      | Grounded LLM prose pass           |
| [P3-08](tickets/P3-08-session-qa.md)          | todo   | —        | —      | Session QA report and notes stage |

## Phase 4 — Desktop app

| Ticket                                        | Status      | Assignee     | Commit    | Title                                     |
| --------------------------------------------- | ----------- | ------------ | --------- | ----------------------------------------- |
| [P4-01](tickets/P4-01-electron-scaffold.md)   | done        | orchestrator | `e46664b` | Electron scaffold                         |
| [P4-02](tickets/P4-02-ipc-contracts.md)       | done        | orchestrator | `5b0dbd9` | IPC contracts and validation              |
| [P4-03](tickets/P4-03-renderer-shell.md)      | done        | luna-p4-03   | `5cd657d` | Renderer transport and app shell          |
| [P4-04](tickets/P4-04-sidecar-supervision.md) | done        | luna-p4-04   | `f235a15` | Sidecar supervision from the main process |
| [P4-05](tickets/P4-05-sessions-intake-ui.md)  | in_progress | luna-p4-05   | -         | Sessions list and intake UI               |
| [P4-06](tickets/P4-06-run-streaming.md)       | todo        | —            | —         | Pipeline run streaming                    |
| [P4-07](tickets/P4-07-provider-runner.md)     | todo        | —            | —         | Claude and Codex provider runner          |
| [P4-08](tickets/P4-08-review-page.md)         | todo        | —            | —         | Flagged-span review page                  |
| [P4-09](tickets/P4-09-notes-page.md)          | todo        | —            | —         | Notes viewer and editor                   |
| [P4-10](tickets/P4-10-pdf-export.md)          | todo        | —            | —         | PDF export                                |
| [P4-11](tickets/P4-11-settings.md)            | todo        | —            | —         | Settings                                  |

## Phase 5 — Hardening and release

| Ticket                                          | Status | Assignee | Commit | Title                              |
| ----------------------------------------------- | ------ | -------- | ------ | ---------------------------------- |
| [P5-01](tickets/P5-01-real-session-e2e.md)      | todo   | —        | —      | Real-session end-to-end            |
| [P5-02](tickets/P5-02-performance.md)           | todo   | —        | —      | Performance budgets                |
| [P5-03](tickets/P5-03-packaging.md)             | todo   | —        | —      | Packaging and sidecar distribution |
| [P5-04](tickets/P5-04-docs.md)                  | todo   | —        | —      | Documentation                      |
| [P5-05](tickets/P5-05-release-qualification.md) | todo   | —        | —      | Release qualification              |
