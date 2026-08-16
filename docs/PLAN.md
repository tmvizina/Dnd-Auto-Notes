# Build plan

## Context

We record D&D sessions two ways and neither one alone is usable as a record of what happened.

Craig gives a per-participant multi-track recording of the Discord call. That solves *who made the sound* for free — one file per person, all tracks sharing a common start. It does not solve the question that actually matters for notes: **was this person speaking as themselves or as their character, and if in character, which one?** The DM is a dozen characters over the course of an evening, switching between them mid-sentence. A transcript that labels four hours of audio with Discord usernames is not a session log.

Roll20 holds the other half: every roll, every roll template, whispers, emotes, and the turn-order changes that mark where combat starts and ends. It is behind a browser and has no export worth using, so it comes out through a script pasted into the Chrome console.

The goal is a `session.md` per session that reads like notes a careful player took: a beat-by-beat outline, in-character dialogue attributed to characters, out-of-character table talk kept separate, combat reconstructed round by round with the rolls that decided it, and the verbal descriptions of what people actually *did*.

The constraint that shapes every decision below: **this must work deterministically.** LLMs are for the ambiguous minority, not the pipeline. The machine that runs it is an M1 Max with 64 GB of unified memory, which can hold a Whisper large-v3, a speaker-embedding model, and a mid-size local chat model at once — so the fallback for ambiguity is a *local* model, and frontier CLIs are optional polish.

## Success criteria for the whole project

1. A four-hour session goes from two dropped files to `session.md` with one command and no manual intervention.
2. Speaker attribution (which player) is correct essentially always — it is a filename join, so anything less is a bug.
3. Persona attribution (player vs. character, and which character) is right for the large majority of utterances, and where it is not confident it says so rather than guessing. The QA report states the uncertain fraction explicitly.
4. Every claim in the notes is traceable to a timestamp and, where mechanical, to a roll.
5. The whole pipeline runs with no network access. Adjudication degrades to "still flagged", never to a crash.
6. Corrections made once in the review UI make the *next* session better.

## Phase 0 — Foundations

Get a repo where every later ticket can be built and tested without real data or real models.

- `P0-01` Repo scaffold, npm workspaces, TypeScript, Node 22
- `P0-02` Test harness: Vitest + pytest + lint/format
- `P0-03` CI: macOS primary, Windows smoke
- `P0-04` Ticket tooling — status report, dependency check, handoff doc
- `P0-05` Synthetic fixture generator: a fake Craig session and a fake Roll20 capture
- `P0-06` Session contracts, JSON schemas, and the hashing stage runner

**Acceptance:** `npm test` and `pytest` pass on a clean checkout with no models installed; the fixture generator produces a complete synthetic session; the stage runner correctly skips unchanged stages and re-runs on `--force`.

## Phase 1 — Data acquisition and persistence

Everything up to "we know who is in this session, what they rolled, and where their audio is". No ASR yet.

- `P1-01` Python sidecar skeleton: FastAPI, `/health` capability probe, job registry, cancel
- `P1-02` Sidecar lifecycle from Node: uv env bootstrap, spawn, health wait, shutdown
- `P1-03` Craig intake: track discovery, filename → Discord user, `info.txt`, ffprobe, alignment check
- `P1-04` Roll20 capture script (`tools/roll20-capture.js`) — live and post-hoc modes
- `P1-05` Roll20 parser: messages, rolls, roll templates, whispers, emotes, turn order
- `P1-06` Roll20 timestamp recovery (spike + implementation), `time_basis` determination
- `P1-07` Campaign registry: `players.json`, `npcs.json`, glossary, fuzzy mapping assistant
- `P1-08` SQLite schema, migrations, run/stage ledger
- `P1-09` `intake` stage + `pipeline` CLI
- `P1-10` Intake QA report: unmapped accounts, missing tracks, duration mismatch, silent tracks

**Acceptance:** dropping a Craig download and a Roll20 capture into a session folder and running `pipeline --stage intake` produces a `manifest.json` in which every roll is attributed to a player and every player is bound to an audio track — or a QA report that names exactly what is missing. Runs against the synthetic fixture in CI.

## Phase 2 — Transcript and persona attribution

The core of the project.

- `P2-01` VAD segmentation per track
- `P2-02` ASR with word timestamps; pluggable backend (`mlx-whisper` | `faster-whisper` | `whisper.cpp`)
- `P2-03` Cross-track merge into one ordered timeline; overlap and mic-bleed detection
- `P2-04` Per-utterance speaker embedding + prosody features
- `P2-05` Per-player voice-mode clustering and the persistent campaign voice-profile bank
- `P2-06` Deterministic lexical rule engine (out-of-character vs. in-character markers)
- `P2-07` Persona scorer: feature fusion, thresholds, confidence, flagging
- `P2-08` DM → NPC assignment (name-introduction windows, voice bank, Roll20 mentions)
- `P2-09` Roll ↔ speech time anchoring (monotonic alignment)
- `P2-10` Adjudicator interface + providers (`cli-claude`, `cli-codex`, `http-local`, `none`)
- `P2-11` Optional audio-native adjudicator for flagged clips
- `P2-12` Labeling CLI and calibration report

**Acceptance:** on a hand-labeled 15-minute slice, in-character/out-of-character classification reports precision and recall per class, character assignment reports accuracy, and the flagged fraction is stated. Numbers are recorded in `docs/calibration.md` — the target is set *after* the first measurement, not guessed now. The pipeline completes end to end with the adjudicator set to `none`.

## Phase 3 — Outline and notes

The first genuinely useful deliverable.

- `P3-01` Event model and timeline assembly
- `P3-02` Beat / scene segmentation
- `P3-03` Combat encounter reconstruction: initiative, rounds, turns, attacks, damage, saves
- `P3-04` Skill-check and social-scene detection
- `P3-05` Action-description extraction — the verbal account of what a character did
- `P3-06` Notes renderer → `session.md`
- `P3-07` Optional LLM prose pass, strictly grounded
- `P3-08` Session QA report and `pipeline notes`

**Acceptance:** a real recorded session produces a `session.md` that a player who was there confirms is an accurate account, with combat rounds matching the rolls and no invented events. The grounding test proves every rendered statement traces to a referenced utterance or roll id.

## Phase 4 — Desktop app

- `P4-01` Electron scaffold: secure window, custom scheme, CSP
- `P4-02` Shared contracts + IPC envelope + validation at every hop
- `P4-03` Renderer transport abstraction and React shell
- `P4-04` Sidecar supervision from the main process
- `P4-05` Sessions list and new-session intake page
- `P4-06` Pipeline run streaming with replay-safe subscriptions
- `P4-07` Provider runner: headless `claude` / `codex`, NDJSON transcripts, run ledger
- `P4-08` Review page: flagged spans, lazy audio playback, corrections write back to the voice bank
- `P4-09` Notes page: view, edit, request LLM changes, undo
- `P4-10` PDF export
- `P4-11` Settings: provider, model, local endpoint, paths

**Acceptance:** a packaged app launches, lists sessions, runs a full pipeline with live progress, lets the user resolve flagged spans with audio playback that does not balloon memory, edits and exports the notes as PDF — with the CLI provider unavailable, everything except the LLM features still works.

## Phase 5 — Hardening and release

- `P5-01` End-to-end run on a real session with an accuracy report
- `P5-02` Performance budgets and a repeatable measurement protocol on the M1 Max
- `P5-03` Packaging, including how the Python sidecar ships
- `P5-04` Documentation: getting started, runbook, troubleshooting
- `P5-05` Release qualification checklist

**Acceptance:** a fresh machine can install the packaged app and process a session without touching a terminal, and the measured numbers for a four-hour session (wall-clock per stage, peak memory) are recorded.

## Decisions already made

| Decision | Rationale |
| --- | --- |
| macOS/M1 Max primary, Windows functional | The models live where the unified memory is; Windows is where the repo is edited. |
| Python HTTP sidecar, not per-stage subprocesses | Model load dominates; a long-lived process makes re-runs cheap during review. |
| Sidecar never touches SQLite | Proven in Audio Forge: a second writer silently loses rows and corrupts reads. |
| Stage output is JSON on disk; SQLite is an index | Inspectable, diffable, replaceable, and survives a database rebuild. |
| One markdown file per ticket | Parallel workers editing one checklist file conflict constantly. |
| Deterministic scoring with explicit flags | An LLM asked to attribute 4,000 utterances will confabulate; asked to adjudicate 150 flagged ones with context, it is useful. |
| Corrections persist per campaign, not per session | This is the only mechanism by which accuracy improves over time without training anything. |

## Open questions

Tracked, not blocking; each has a spike ticket or a fallback.

- Do current Roll20 message ids still decode to a wall-clock timestamp? (`P1-06`; fallback is the live-capture MutationObserver, which stamps its own.)
- Does ECAPA separate one person's *assumed voices* well enough to cluster them, or is a prosody-weighted feature set required? (`P2-05` measures both before choosing.)
- Which audio-native model is worth running locally for adjudication on 64 GB? (`P2-11` is a bake-off, not a commitment.)
- How does the Python sidecar ship in a packaged app — bundled interpreter, or a first-run `uv` bootstrap? (`P5-03`.)
