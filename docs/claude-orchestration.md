# Claude Code orchestration

How to run this backlog with Claude Code — an Opus 5 orchestrator driving Sonnet 5 workers — at token cost comparable to the Codex path (5.6 Sol medium orchestrator, Luna Max implementers, Luna Max reviewer).

`docs/orchestration.md` is canonical for _what_ the loop is. This document is _how to run it on Claude Code without paying twice for the same result_.

## Role and model assignment

| Role                       | Model              | Effort  | Why                                                                                                                                                                                        |
| -------------------------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Orchestrator               | `claude-opus-5`    | `high`  | Holds the dependency graph, judges diffs, decides what to commit. Small context, high-stakes decisions — exactly where Opus pays for itself.                                               |
| Implementer                | `claude-sonnet-5`  | `xhigh` | Bounded scope, clear acceptance list, lots of tool calls. This is where the token volume is, so it runs on the cheaper model at high effort rather than the expensive model at low effort. |
| Reviewer                   | `claude-sonnet-5`  | `high`  | Reads a diff against a checklist. Judgment, not exploration.                                                                                                                               |
| Fixture / boilerplate work | `claude-haiku-4-5` | —       | Optional. `P0-05` and similar mechanical tickets don't need Sonnet.                                                                                                                        |

`.claude/agents/orchestrator.md`, `implementer.md`, and `reviewer.md` set `model:` in their frontmatter. The orchestrator inherits its model from the session; run it in an Opus 5 session.

## Where the money actually goes

Current list prices, per million tokens:

| Model     | Input | Output | Cache read | Cache write (5m) |
| --------- | ----: | -----: | ---------: | ---------------: |
| Opus 5    | $5.00 | $25.00 |      $0.50 |            $6.25 |
| Sonnet 5  | $3.00 | $15.00 |      $0.30 |            $3.75 |
| Haiku 4.5 | $1.00 |  $5.00 |      $0.10 |            $1.25 |

Sonnet 5 is at an introductory $2.00 / $10.00 through 2026-08-31, which makes the worker tier cheaper than the table above until then.

**The dominant cost is input tokens on the worker, not output tokens anywhere.** An agentic session resends its whole conversation on every turn, so cumulative input scales with turns × context size. A 30-turn implementer session whose context grows from 20K to 120K tokens sends roughly 2.1M cumulative input tokens — against maybe 25K output tokens. Input is ~80× the volume of output on that session, and only ~4× cheaper per token.

That arithmetic is why the rules below are about _context discipline_, not about picking cheaper models.

### One ticket, budgeted

Assumptions: a medium ticket, ~30 implementer turns, ~8 reviewer turns, ~6 orchestrator turns. Sonnet 5 at standard pricing.

|                      | Cumulative input | Output |  Uncached | With ~85% cache hits |
| -------------------- | ---------------: | -----: | --------: | -------------------: |
| Implementer (Sonnet) |             2.1M |    25K |     $6.68 |                $1.86 |
| Reviewer (Sonnet)    |            0.35M |     6K |     $1.14 |                $0.41 |
| Orchestrator (Opus)  |            0.20M |     8K |     $1.20 |                $0.53 |
| **Per ticket**       |                  |        | **$9.02** |            **$2.80** |

Caching is a ~3× difference, and it is the whole game. Fifty-two tickets is roughly **$150 run well, $470 run badly** — and the badly-run version also produces worse work, because the failure mode that wastes tokens (re-deriving context) is the same one that produces wrong code.

Measure your own numbers rather than trusting this table: `/cost` reports the session's spend, and the first three tickets will tell you whether your ratios match.

## The seven parity rules

These are what make the Claude path cost the same as the Codex path. Each one is a real behavior, not a setting.

### 1. The orchestrator never reads implementation files

Its working set is `docs/HANDOFF.md`, the ticket file, `git diff`, and test output. That is a few thousand tokens. The moment it starts opening `packages/core/src/...` to "check the work", its context balloons and every subsequent turn re-sends it at Opus prices.

If the orchestrator needs to know whether the code is right, that is what the reviewer is for. If the reviewer's verdict is not enough to decide, the ticket's acceptance list was too vague — fix the ticket.

### 2. A subagent spawn is a cold start — pay for it once, in the prompt

Every `Agent` call starts with zero context. It will reconstruct what it needs by reading files, and reading files is the expensive part. A spawn prompt that says "implement P2-05" costs far more than one that inlines the ticket, names the three files to read, and states the contract — because the vague version spends twenty turns finding what the specific version handed over in two thousand tokens.

Concretely, the orchestrator's spawn prompt should carry:

- the ticket file's full text (it's ~40 lines),
- the exact paths of the contracts and prior art it must read,
- the `scope:` boundary, restated as a hard rule,
- "do not commit",
- the Verify commands to run and report.

Inlining ~1,500 tokens to save ~30,000 of exploration is the single highest-leverage habit in this loop.

### 3. Don't spawn what you can do in three tool calls

Opus 5 delegates more readily than its predecessors — it will hand off work that costs more to brief and report than to just do. Each spawn pays a cold-start context tax, a report-writing tax, and a report-reading tax.

The orchestrator agent definition carries an explicit cap. Keep it there:

> Subagents multiply cost and time: each one re-establishes context, re-explores, and reports back, and you then re-read its report. Delegate one ticket at a time to one implementer. Do not spawn a subagent to read a file, run a test, check a status, or verify your own work — do those directly. Never run more than three implementers concurrently.

Two to three concurrent workers is the ceiling for a different reason too: review and integration are serial, so a fourth worker mostly produces merge conflicts.

### 4. Delete verification scaffolding — don't add it

Instructions telling Opus 5 to "double-check", "verify before responding", or "spawn a subagent to verify" now cause _over_-verification: it re-runs work it already did correctly, at Opus prices. It verifies on its own.

This inverts the usual prompting advice, so it's worth stating plainly: on this model, "ask it to self-check" is a cost bug. The orchestrator's real verification is mechanical — run the test suite, read the diff, check scope containment. That's a tool call, not a reasoning loop.

### 5. Keep the orchestrator session alive across tickets, `/clear` at phase boundaries

Prompt caching is a prefix match with a 1-hour TTL in this session. An orchestrator session that runs several tickets back to back reads its stable prefix — `AGENTS.md`, the orchestration contract, the ticket index — at 10% of input price every turn. Restarting the session after each ticket pays the full cold price again.

But context that grows without bound is worse: every turn re-sends it. The balance:

- **Keep going** through tickets within a phase — the shared prefix is doing real work.
- **`/clear` at phase boundaries**, and any time the transcript is mostly finished work. Update `docs/HANDOFF.md` _first_; that file is the handoff, so clearing costs nothing once it's current.
- **Prefer `/clear` over `/compact`** here. Compaction spends tokens summarizing a transcript whose durable content already lives in `HANDOFF.md` and the ticket files. This backlog is designed so that state lives on disk, which makes clearing cheap.

### 6. Don't switch the orchestrator's model mid-run

Prompt caches are model-scoped. Switching the orchestrator from Opus to Sonnet to "save money" discards the entire cached prefix and pays a full cold read on the next turn — often costing more than the switch saves. If you want cheaper work, spawn a cheaper _subagent_; the orchestrator's own session stays on one model start to finish.

The same applies to churning the context prefix: editing `CLAUDE.md` or `AGENTS.md` mid-session invalidates everything cached after it. Batch those edits to phase boundaries.

### 7. Fast mode is off for the orchestrator

`/fast` runs Opus 5 with faster output at $10/$50 per MTok — double the standard rate. The orchestrator is not latency-bound; it's waiting on workers and test runs. Leave it off. It's a reasonable choice for an interactive session where you're watching output scroll by, and a waste for a loop that runs unattended.

## Opus 5 behaviors to tune for this role

Beyond cost, three of Opus 5's defaults work against an orchestrator specifically. All three are already handled in `.claude/agents/orchestrator.md`; this is why those lines are there.

**Longer responses by default.** Opus 5 writes more user-facing text than its predecessors, and lowering `effort` does _not_ reliably shorten it — that's a prompting lever, not a configuration one. The orchestrator's job is a status line and a decision, not an essay. Keep the conciseness instruction.

**Task scope expansion.** It can quietly widen what it was asked to do — fixing an adjacent thing, improving a file it happened to open. In an orchestrator that means committing work outside the ticket's `scope:`, which is exactly the thing the review gate exists to catch. The scope-discipline instruction stays.

**Self-correction narration.** It flags and explains its own earlier mistakes at length, which reads as thrash across a 52-ticket run. Corrections that don't change what you'd do next should be made silently.

## Practical session shape

```
Session 1 (Opus 5)  — Phase 0
  read AGENTS.md, orchestration.md, HANDOFF.md, git status
  P0-01 → spawn implementer(Sonnet) → spawn reviewer(Sonnet) → commit
  P0-02 → …
  P0-06 → commit
  update HANDOFF.md
  /clear

Session 2 (Opus 5)  — Phase 1, three parallel tracks
  read HANDOFF.md, tickets --ready
  spawn implementer × 3 (tracks A/B/C, disjoint scope)
  as each reports: spawn reviewer, then integrate and commit — one ticket per commit
  update HANDOFF.md
  /clear
```

Start each session by running the ticket tooling rather than reading files:

```bash
npm run tickets -- --ready
```

## Cost parity with the Codex path

|              | Codex                                  | Claude Code                              |
| ------------ | -------------------------------------- | ---------------------------------------- |
| Orchestrator | 5.6 Sol, medium reasoning              | Opus 5, `high` effort                    |
| Implementer  | Luna, max reasoning                    | Sonnet 5, `xhigh` effort                 |
| Reviewer     | Luna, max reasoning, separate instance | Sonnet 5, separate agent                 |
| Cheap tier   | —                                      | Haiku 4.5 for mechanical tickets         |
| Main lever   | Keeping the orchestrator at medium     | Prompt-cache hit rate on worker sessions |

The two paths land in the same place for the same reason: a capable-but-expensive model making a small number of high-stakes decisions over a small context, and a cheaper model doing the bulk token work inside a tightly bounded scope. Neither path is cheap if the expensive model starts doing the exploring.

## Quick reference

| Symptom                                        | Cause                                 | Fix                                                   |
| ---------------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| Orchestrator session is huge after two tickets | It's reading implementation files     | Rule 1 — read the diff, not the tree                  |
| A worker takes 40 turns on an S ticket         | Spawn prompt didn't carry the ticket  | Rule 2 — inline the ticket and the paths              |
| Cost per ticket 3× the table                   | Cache misses; context prefix churning | Rules 5 and 6 — stop editing shared files mid-session |
| Orchestrator spawning agents to check things   | Opus 5's delegation default           | Rule 3 — the cap is in the agent definition           |
| Work committed outside `scope:`                | Scope expansion                       | Reviewer returns it; keep the scope instruction       |
