# Orchestration contract

This backlog is designed to be executed by an orchestrator agent driving a pool of worker agents. It works with either CLI. Codex is the primary target.

## Role assignment

### Codex (primary)

| Role         | Model / effort                                        | Owns                                                                                                                                  |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator | GPT-5.6 **Sol**, medium reasoning                     | Architecture, ticket boundaries, integration, final approval, **all commits**, keeping `docs/tickets/` and `docs/HANDOFF.md` truthful |
| Implementer  | GPT-5.6 **Luna**, max reasoning                       | One ticket at a time, inside an exclusive file scope                                                                                  |
| Reviewer     | GPT-5.6 **Luna**, max reasoning, _different instance_ | Reviews an implementer's diff against the ticket's acceptance criteria and returns a binary verdict                                   |

### Claude Code

| Role         | Model                  | Owns                      |
| ------------ | ---------------------- | ------------------------- |
| Orchestrator | Opus 5                 | Same as Sol above         |
| Implementer  | Sonnet                 | Same as Luna above        |
| Reviewer     | Sonnet, separate agent | Same as the Luna reviewer |

Agent definitions live in `.claude/agents/`. They are adapters over this document — this document is canonical. If they disagree, this file wins and the adapter gets fixed.

**Running the Claude Code path:** [claude-orchestration.md](claude-orchestration.md) covers effort settings per role, where the tokens actually go, and the seven context-discipline rules that keep it at cost parity with the Codex path. Read it before the first session, not after the bill.

## The loop

```
        ┌──────────────────────────────────────────────────────────┐
        │ Orchestrator picks the next ticket whose depends_on are   │
        │ all `done`. Sets status: in_progress, assignee: <worker>. │
        └───────────────────────┬──────────────────────────────────┘
                                ▼
        ┌──────────────────────────────────────────────────────────┐
        │ Implementer works ONLY inside the ticket's `scope:` paths.│
        │ Writes code + tests. Runs the ticket's Verify commands.   │
        │ Does NOT commit. Does NOT touch other tickets' files.     │
        │ Reports: files changed, test output, deviations.          │
        └───────────────────────┬──────────────────────────────────┘
                                ▼
        ┌──────────────────────────────────────────────────────────┐
        │ Reviewer reads the actual diff (not the summary) against  │
        │ the ticket's Acceptance list. Verdict is binary:          │
        │   PASS  → forward to orchestrator                         │
        │   RETURN → numbered, specific, actionable defects         │
        │ A RETURN goes back to the implementer. Max 2 rounds, then │
        │ the orchestrator takes it over itself.                    │
        └───────────────────────┬──────────────────────────────────┘
                                ▼
        ┌──────────────────────────────────────────────────────────┐
        │ Orchestrator: re-reads the diff, runs typecheck + the full│
        │ test suite, confirms scope containment, commits ONE ticket│
        │ per commit, sets status: done + records the short SHA in  │
        │ the ticket, then assigns the next ticket.                 │
        └──────────────────────────────────────────────────────────┘
```

## Hard rules

1. **Workers never commit.** Only the orchestrator commits, and only after its own review pass. One reviewable ticket per commit.
2. **Exclusive scope.** A ticket's `scope:` list is the worker's boundary. Touching a file outside it is an automatic RETURN. If a ticket genuinely needs a file outside its scope, the worker stops and reports; the orchestrator amends the ticket or splits it.
3. **Never destroy working-tree state.** No `git clean`, `git reset --hard`, `git checkout --`, or branch switching to "get a clean tree". Unrelated uncommitted changes are someone else's work.
4. **Windows git discipline** (applies when running on the Windows box): git mutations are _separate_ tool invocations, never chained with `;`, `&&`, `||` or pipes, and never wrapped in an explicit `powershell`/`cmd.exe` call. Sequence: `git add -- <files>` → `git diff --cached --check` → `git diff --cached --stat` → `git commit -m "…"`.
5. **No pushing, no PRs, no publishing, no installing machine-wide software, and no paid provider runs without asking the human first.**
6. **Tests are part of the ticket, not a follow-up.** A ticket without its tests is not `done`. "I'll add tests in a later ticket" is a RETURN.
7. **Fixtures are synthetic.** No real campaign audio, no real player names, no real Roll20 exports in `test/fixtures/`. Generators produce them deterministically (`P0-05`).
8. **A stage may never refuse to re-run.** Idempotence means "skips when nothing changed", never "blocks because it already completed". `--force` always works.
9. **Flag, don't guess.** If a deterministic stage cannot decide, it emits a flag with a machine-readable code. Silently picking the most likely answer is a defect.
10. **Update the handoff.** After each integrated ticket the orchestrator appends to `docs/HANDOFF.md`: short SHA, ticket, what was validated with real numbers, blockers, and the precise next action.

## Ticket status values

`todo` → `in_progress` → `in_review` → (`changes_requested` → `in_progress`)* → `approved` → `done`

`blocked` is valid from any state and requires a `blocked_reason`. The orchestrator is responsible for unblocking or resequencing.

## Parallelism

Tickets whose `scope:` lists are disjoint and whose `depends_on` are satisfied may run concurrently. In practice this means 2–3 workers, not more: integration and review are the bottleneck, and a fourth worker mostly produces merge conflicts. The dependency graph in `docs/tickets/README.md` marks the natural parallel tracks.

## Definition of done for a ticket

- Every line of the Acceptance list is objectively true.
- The Verify commands were actually run and their output was reported (not predicted).
- Typecheck and the full test suite pass.
- The diff contains only files in `scope:`.
- The ticket file has `status: done` and the commit's short SHA.
