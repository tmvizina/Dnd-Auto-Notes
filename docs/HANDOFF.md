# Handoff

The living state of the build. The orchestrator appends to this after every integrated ticket. Anyone picking the project up reads this first.

## Current state

Planning complete, implementation not started. The repository contains documentation and the ticket backlog only — no application code yet.

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

Not yet decided, deliberately deferred to the tickets that carry the evidence:

- Whether Roll20 message ids still decode to wall-clock time (`P1-06`)
- Whether speaker embeddings alone separate one person's assumed voices (`P2-05`)
- Which audio-native model, if any, is worth running locally (`P2-11`)
- How the Python sidecar ships in a packaged app (`P5-03`)

## Commit checkpoints

| SHA | Ticket | Scope | Validated |
| --- | --- | --- | --- |
| `cd93fd0` | — | Planning docs, 52-ticket backlog, agent definitions | Root commit, 66 files. All 52 ticket-index links resolve; every ticket has complete frontmatter; no `depends_on` references a non-existent id. |

## Known risks

1. **Roll20 DOM is not an API.** The capture script retains raw `outerHTML` per message so a markup change only breaks the parser, not the recording. `P1-04` and `P1-05` depend on this.
2. **Voice separability is unproven.** If a player's character voice is acoustically indistinguishable from their table voice, `P2-05` degrades to lexical evidence alone and the flagged fraction rises. The bake-off in `P2-05` measures this before the scorer is tuned.
3. **Craig track alignment is assumed, not guaranteed.** `P1-03` verifies it rather than trusting it, because a violation invalidates every cross-track timestamp.
4. **Mic bleed from co-located players** would silently double every line. `P2-03` detects it; it has not been tested against a real co-located table.
5. **Nothing is validated against real audio yet.** `P5-01` is the first contact with reality, and its findings will generate follow-up tickets.

## Exact next actions

1. Read `docs/claude-orchestration.md` (Claude Code) or `docs/prompts/codex-orchestrator.md` (Codex) before the first session — the context-discipline rules are what keep the run affordable.
2. Run `P0-01` (repo scaffold) — it has no dependencies and everything else waits on it.
3. Run `P0-06` (contracts and stage runner) next; it unblocks all three parallel tracks in phase 1.
4. Then fan out: track A `P1-01`/`P1-02`/`P1-03`, track B `P1-04`/`P1-05`/`P1-07`, track C `P1-08`.

Open question for the human, not blocking: whether to flatten the nested repository path (below).

## Repository location

The git repository with the `origin` remote is nested one level down from the Rider project folder, at `Dnd-Auto-Notes/Dnd-Auto-Notes/`. If that nesting is unintended, flatten it before the first commit — moving files after history exists is more annoying than doing it now.
