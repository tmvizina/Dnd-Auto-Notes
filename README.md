# D&D Auto Notes

Turns a recorded D&D session into a detailed, accurate markdown session log — automatically, locally, and mostly without an LLM in the loop.

Two inputs go in:

1. **Craig bot recording** — the per-participant multi-track audio from the Discord voice channel. Speaker separation is free (one file per person); what it does *not* tell you is whether a person is speaking as themselves or as their character, and the DM is a dozen characters at once. That is the hard problem this project solves.
2. **Roll20 log** — chat, rolls, roll templates, and turn-order changes, captured by a script pasted into the Chrome console on the Roll20 tab.

One deliverable comes out: `sessions/<session-id>/session.md` — a beat-by-beat outline of what happened, who said what (as player and as character), what was rolled, and what the party actually did in each fight and each negotiation.

## Design stance

- **Deterministic first.** Every stage is plain code with a testable contract. Where the evidence genuinely runs out, the pipeline *flags a span* with a reason instead of guessing, and only flagged spans are ever handed to an LLM.
- **Local first.** The heavy lifting (ASR, embeddings, adjudication) targets an M1 Max / 64 GB Mac via a Python sidecar. Frontier models are optional polish, never a dependency.
- **Resumable.** Stages read and write JSON in the session folder, keyed by content hash. Re-running a stage is always allowed and never destroys prior output.
- **Nothing hidden.** Every line of the final notes cites the timestamp (and where relevant, the roll) it came from.

## Status

Pre-implementation. The complete build is specified in [docs/PLAN.md](docs/PLAN.md) and broken into individually implementable tickets in [docs/tickets/](docs/tickets/).

| Phase | Theme | Tickets |
| --- | --- | --- |
| 0 | Foundations — scaffold, fixtures, contracts, CI | `P0-01`…`P0-06` |
| 1 | Acquisition & persistence — intake, Roll20 capture, DB | `P1-01`…`P1-10` |
| 2 | Transcript & persona — ASR, voice modes, in-character attribution | `P2-01`…`P2-12` |
| 3 | Outline & notes — beats, encounters, `session.md` | `P3-01`…`P3-08` |
| 4 | Desktop app — Electron shell, CLI runners, editor, PDF | `P4-01`…`P4-11` |
| 5 | Hardening & release | `P5-01`…`P5-05` |

Phase 3 is the first genuinely useful deliverable. Phases 0–3 are a command-line pipeline; phase 4 wraps it in a UI.

## Quickstart (once phase 1 lands)

```bash
npm install
npm run sidecar:setup          # uv-managed Python env for the ASR/embedding sidecar
npm run session:new -- "Session 42"
# drop the Craig download into sessions/<id>/input/craig/
# paste tools/roll20-capture.js into the Roll20 tab console, save the download into input/roll20/
npm run pipeline -- --session <id> --stage intake
```

## Repo map

```
app/desktop/       Electron main + preload + shared IPC contracts   (phase 4)
app/ui/            React + Vite renderer                            (phase 4)
packages/core/     SQLite, session contracts, stage runner, LLM providers
packages/cli/      `pipeline` — headless stage runner
sidecar/           Python FastAPI service: ASR, VAD, embeddings, audio adjudication
tools/             roll20-capture.js and other host-side helpers
campaign/          persistent, cross-session truth: players, NPCs, glossary, voice profiles
sessions/          one folder per session; inputs, stage outputs, session.md
docs/              plan, architecture, orchestration contract, tickets
```

## Documents

- [docs/PLAN.md](docs/PLAN.md) — the phased build plan, with acceptance criteria per phase
- [docs/architecture.md](docs/architecture.md) — target architecture and the reasoning behind it
- [docs/session-layout.md](docs/session-layout.md) — the on-disk data contract
- [docs/orchestration.md](docs/orchestration.md) — how agent orchestrators and workers run this backlog
- [docs/claude-orchestration.md](docs/claude-orchestration.md) — running it on Claude Code: model assignment, token economics, and the rules that keep it at cost parity with the Codex path
- [docs/tickets/README.md](docs/tickets/README.md) — ticket format and lifecycle
- [AGENTS.md](AGENTS.md) — rules every agent working in this repo must follow
