# Handoff

The living state of the build. The orchestrator appends to this after every integrated ticket. Anyone picking the project up reads this first.

## Current state

Phase 0 is three tickets in. `P0-01`, `P0-02` and `P0-04` are done; `P0-03`, `P0-05` and `P0-06` remain.

The repo builds, typechecks, tests and lints clean: 40 TypeScript tests, 10 Python tests (1 skipped until `P1-01`), `npm run tickets -- --check` green across all 52 tickets.

In place:

- `docs/PLAN.md` — six phases with per-phase acceptance criteria
- `docs/architecture.md` — target architecture and the reasoning behind each choice
- `docs/session-layout.md` — the on-disk data contract every stage reads and writes
- `docs/orchestration.md` — orchestrator/implementer/reviewer loop and hard rules
- `docs/claude-orchestration.md` — the Claude Code path: Opus 5 orchestrator + Sonnet 5 workers, token economics, and the context-discipline rules that hold it at parity with the Codex path
- `docs/tickets/` — 52 tickets, `P0-01` through `P5-05`, with a dependency graph in its README
- `AGENTS.md` — rules for every agent working here
- `.claude/agents/` — Claude Code adapters for the three roles
- `docs/prompts/codex-orchestrator.md` — the Codex session bootstrap
- `packages/core` + `packages/cli` — ESM workspaces, strict TS, `pipeline` CLI stub
- `sidecar/` — installable Python package, pytest wired, model stack opt-in
- `tools/tickets.mjs` — backlog as data; `tools/setup-sidecar.mjs`, `tools/run-pytest.mjs`

Not yet decided, deliberately deferred to the tickets that carry the evidence:

- Whether Roll20 message ids still decode to wall-clock time (`P1-06`)
- Whether speaker embeddings alone separate one person's assumed voices (`P2-05`)
- Which audio-native model, if any, is worth running locally (`P2-11`)
- How the Python sidecar ships in a packaged app (`P5-03`)

## Commit checkpoints

| SHA       | Ticket  | Scope                                               | Validated                                                                                                      |
| --------- | ------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cd93fd0` | —       | Planning docs, 52-ticket backlog, agent definitions | Root commit, 66 files. All 52 ticket-index links resolve; frontmatter complete; no dangling `depends_on`.      |
| `55541d9` | `P0-01` | Workspaces, TypeScript, `pipeline` bin              | From a clean checkout: `npm install`, `npm run typecheck`, `npm run build`, `npx pipeline --help` all succeed. |
| `06dd168` | `P0-02` | Vitest, pytest, ESLint, Prettier, sidecar pyproject | 19 TS tests, 10 Python passed + 1 skipped, lint clean, format clean. Neither suite needs network.              |
| `ca6ee3f` | —       | Prettier over existing Markdown                     | Formatting only, no wording changed.                                                                           |
| `2dfc72b` | —       | Prettier over the P0-01 scaffold sources            | Formatting only.                                                                                               |
| `c5dba79` | `P0-04` | `tools/tickets.mjs`, root tsconfig for `test/`      | 21 tests. `--check` green on all 52 tickets; `--ready` lists exactly the unblocked set.                        |

## Known risks

1. **Roll20 DOM is not an API.** The capture script retains raw `outerHTML` per message so a markup change only breaks the parser, not the recording. `P1-04` and `P1-05` depend on this.
2. **Voice separability is unproven.** If a player's character voice is acoustically indistinguishable from their table voice, `P2-05` degrades to lexical evidence alone and the flagged fraction rises. The bake-off in `P2-05` measures this before the scorer is tuned.
3. **Craig track alignment is assumed, not guaranteed.** `P1-03` verifies it rather than trusting it, because a violation invalidates every cross-track timestamp.
4. **Mic bleed from co-located players** would silently double every line. `P2-03` detects it; it has not been tested against a real co-located table.
5. **Nothing is validated against real audio yet.** `P5-01` is the first contact with reality, and its findings will generate follow-up tickets.

## Exact next actions

1. `P0-06` (contracts and stage runner, size L) — the critical path. It unblocks `P0-05` and all three parallel tracks in phase 1.
2. `P0-05` (synthetic fixtures) once `P0-06` fixes the artifact shapes.
3. `P0-03` (CI) any time — it depends only on `P0-02`, and is worth landing before the backlog gets wide.
4. Phase 1 then fans out: track A `P1-01`/`P1-02`/`P1-03`, track B `P1-04`/`P1-05`/`P1-07`, track C `P1-08`.

Run `npm run tickets -- --ready` rather than trusting this list.

## Environment notes

- **Node 24 on the dev box**, not the 22 in `.nvmrc`. `engines` is `>=22`, so both work; CI should still pin 22.
- **`uv` is not installed** and installing it needs the human's say-so. `npm run sidecar:setup` falls back to `py -3.12` and a virtualenv at `sidecar/.venv`; `npm run test:py` finds either. The documented `uv` path is untested here.
- **System `python` is 3.9**, below the sidecar's floor. The tooling probes for 3.11+ explicitly rather than trusting `python` on PATH.

Open question for the human, not blocking: whether to flatten the nested repository path (below).

## Repository location

The git repository with the `origin` remote is nested one level down from the Rider project folder, at `Dnd-Auto-Notes/Dnd-Auto-Notes/`. If that nesting is unintended, flatten it before the first commit — moving files after history exists is more annoying than doing it now.
