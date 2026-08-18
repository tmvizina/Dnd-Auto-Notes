# Handoff

The living state of the build. The orchestrator appends to this after every integrated ticket. Anyone picking the project up reads this first.

## Current state

**Phase 0 is complete** and **phase 1 is over half done.** `P0-01`, `P0-02`, `P0-04`, `P0-05` and `P0-06` are done; `P0-03` (CI) is written and locally verified but **blocked** — its acceptance is a green CI run, which needs a push.

In phase 1, `P1-01` through `P1-09` are done. `P1-10` (intake QA report) is now ready.

In phase 4, `P4-01` through `P4-04` are done: the secure Electron shell, validated IPC boundary, React renderer shell and demand-driven sidecar supervision are in place. `P4-05` is now ready.

The committed repo builds, typechecks, tests and lints clean: 375 TypeScript tests and 40 Python tests after P4-03; `npm run tickets -- --check` is green across all 52 tickets.

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

| SHA       | Ticket  | Scope                                               | Validated                                                                                                                                                                                                      |
| --------- | ------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd93fd0` | —       | Planning docs, 52-ticket backlog, agent definitions | Root commit, 66 files. All 52 ticket-index links resolve; frontmatter complete; no dangling `depends_on`.                                                                                                      |
| `55541d9` | `P0-01` | Workspaces, TypeScript, `pipeline` bin              | From a clean checkout: `npm install`, `npm run typecheck`, `npm run build`, `npx pipeline --help` all succeed.                                                                                                 |
| `06dd168` | `P0-02` | Vitest, pytest, ESLint, Prettier, sidecar pyproject | 19 TS tests, 10 Python passed + 1 skipped, lint clean, format clean. Neither suite needs network.                                                                                                              |
| `ca6ee3f` | —       | Prettier over existing Markdown                     | Formatting only, no wording changed.                                                                                                                                                                           |
| `2dfc72b` | —       | Prettier over the P0-01 scaffold sources            | Formatting only.                                                                                                                                                                                               |
| `c5dba79` | `P0-04` | `tools/tickets.mjs`, root tsconfig for `test/`      | 21 tests. `--check` green on all 52 tickets; `--ready` lists exactly the unblocked set.                                                                                                                        |
| `ab2cf9f` | `P0-03` | CI workflow                                         | Ran the macOS job's exact sequence locally, `npm ci` included. Green run itself still unverified — needs a push.                                                                                               |
| `5104070` | `P0-06` | Contracts, session layer, stage runner              | 53 tests. Skip/re-run/force/error paths and write atomicity all proven by injected failures, not asserted.                                                                                                     |
| `5229b93` | `P0-05` | Synthetic fixture generator                         | 12 tests. Byte-identical across runs; exactly 3 defects under `--with-defects`; WAV headers checked byte-wise.                                                                                                 |
| `0223f88` | `P1-07` | Campaign registry and identity mapping              | Integrated by the previous session; no per-ticket numbers were recorded at the time. Covered by the suite green at `58bc17b`.                                                                                  |
| `da278f1` | `P1-08` | SQLite schema and run ledger                        | As above.                                                                                                                                                                                                      |
| `42d7e12` | `P1-01` | Python sidecar skeleton and job registry            | As above.                                                                                                                                                                                                      |
| `630bf36` | `P1-02` | Sidecar lifecycle from Node                         | As above. Its ticket was left open until `0ac84f7`, which is what held `P1-03` out of `--ready`.                                                                                                               |
| `58bc17b` | `P1-03` | Craig intake, and `/probe` extended to ffprobe      | 101 new TS tests, 14 new Python tests. Durations, speech ratios and hashes measured off real fixture WAV bytes with no ffmpeg and no sidecar process. Archive path proven end to end through a hand-built zip. |

| `e46664b` | `P4-01` | Secure Electron desktop scaffold | 5 targeted security/path tests, 289 TS tests and 40 Python tests passed; full typecheck, lint and format passed. An unpacked Windows package was built through electron-builder with the explicit native rebuild. No code blocker remains; an interactive visible-window smoke was not run during orchestration. |

| `f4dfd33` | `P1-04` | Roll20 live and post-hoc browser capture | Syntax, lint, format, full typecheck, 289 TS tests and 40 Python tests passed. Focused VM checks covered live mutation capture, reload restore, late/recreated turn order, cloned anonymous messages, JSON download and native d100 markup. No code blocker remains; validation in an actual Roll20 tab is still pending. |

| `25f969a` | `P1-05` | Pure Roll20 JSON/HTML capture parser | 8 parser/generator-backed tests passed, including semantic JSON/HTML equivalence, advantage, dropped dice, combat markers, unknown templates, sequence ordering and NPC-label rejection. Full validation over the combined disjoint worktree passed 318 TS tests and 40 Python tests plus typecheck/lint/format. No code blocker remains; real Roll20 markup is still unverified. |

| `5b0dbd9` | `P4-02` | Validated desktop IPC contracts and preload bridge | 21 focused IPC tests passed; the combined full gate passed 318 TS tests and 40 Python tests plus typecheck/lint/format. Sender/document identity, envelopes, request/response byte caps, channel literals, recursive sanitization, stack removal, settings allow-list and main-process registration were verified. No blocker remains. |
| `5dd325b` | `P1-06` | Roll20 timestamp recovery and evidence spike | 7 focused tests passed; independent review passed after the resolver was exported through the public Roll20 barrel. The combined full gate passed 331 TS tests and 40 Python tests plus typecheck/lint/format. Real archive evidence showed all 98 ids decodable but one backward step across a multi-session capture, so that capture honestly downgrades to `order_only`. |
| `f235a15` | `P4-04` | Demand-driven desktop sidecar supervision | Independent review passed after proving startup/restart shutdown races cannot orphan late-owned children. Focused review covered 49 tests; the combined full gate passed 345 TS tests and 40 Python tests plus typecheck/lint/format. Missing environments expose a validated setup command without installing, retries cap, adopted processes survive quit, logs are bounded, and accepted runs receive clear failure events. |
| `ee50c13` | `P1-09` | Canonical intake stage and pipeline CLI | Independent review passed after mapped and unmapped Roll20 rolls were persisted in the validated manifest, the duplicate CLI intake implementation was removed, and stage progress reached TTY/NDJSON output. 23 focused tests and the full 357 TS/40 Python gate passed with typecheck, build, lint and format. Skip completed under one second; force, defects, status, QA, latest and arbitrary-cwd paths were exercised. |
| `5cd657d` | `P4-03` | React renderer transport and app shell | Independent review passed 18 focused UI tests and the full 375 TS/40 Python gate. Desktop production build and an unpacked electron-builder package succeeded; asar and `resources/ui` contents were inspected. The 5,000-row benchmark rendered at most 19 rows in about 0.41 ms per sampled calculation, transport matches the preload bridge, browser operations fail explicitly, and the built bundle contains no external requests. |
| `edd2445` | `P2-01` | Per-track VAD segmentation and async sidecar route | Independent review returned two defects, then passed after Silero padding was made single-application and parameter aliases deterministic. Focused VAD passed 10 tests; the combined gate passed 388 TypeScript and 50 Python tests plus typecheck. Energy segmentation matched the canonical fixture within 150 ms, hard splits overlap, and source hashes remain unchanged. P2-02 is now ready. |
| `43dea94` | `P1-10` | Intake QA catalog, report artifact, CLI rendering and flag mirror | Independent review returned three integration defects, then passed after explicit empty-track rosters, deterministic unparsed-message samples and QA-artifact skip invalidation were covered. Focused QA passed 33 tests; the full gate passed 402 TypeScript and 50 Python tests plus typecheck and lint. The clean fixture has zero entries and the defect fixture exactly three; errors exit 2 and open flags mirror into SQLite. |
| `d140b8a` | `P2-02` | Deterministic ASR with absolute word timestamps and three reusable backends | Independent review returned timestamp overlap and model-reuse defects, then passed after faster-whisper offsets were corrected, global word monotonicity was enforced, MLX primed its model holder, and whisper.cpp moved to a persistent local server process. The final gate passed 407 TypeScript and 65 Python tests. Real-session performance remains measured by `P5-02`. |
| `c3ab684` | `P4-05` | Sessions list, intake workflow, mapping editor and secure desktop handlers | Independent security review returned path-containment defects three times, then passed after every session root, descendant artifact, copy/reveal target, campaign mapping and pipeline-run path was canonically constrained. The final implementation covered 60 scoped tests; the combined gate passed 407 TypeScript and 65 Python tests plus typecheck, lint and format. External sessions are indexed, large copies stream progress, QA fixes link to mappings, and intake always remains rerunnable. |

## Known risks

1. **Roll20 DOM is not an API.** `P1-04` retains raw `outerHTML` per message so a markup change only breaks parsing, not the recording, and its DOM behavior is covered by synthetic VM checks. P1-05 successfully parsed the supplied real saved page without dropping records, but validation of the live capture script in an actual Roll20 tab is still pending.
2. **Voice separability is unproven.** If a player's character voice is acoustically indistinguishable from their table voice, `P2-05` degrades to lexical evidence alone and the flagged fraction rises. The bake-off in `P2-05` measures this before the scorer is tuned.
3. **Craig track alignment is assumed, not guaranteed.** `P1-03` now verifies it against the median duration and sets `aligned: false` per track, with `TRACK_DURATION_MISMATCH` naming the outliers. The check is proven against a synthetic outlier only; whether real Craig downloads ever violate the shared t=0 is still unknown until `P5-01`.
4. **Mic bleed from co-located players** would silently double every line. `P2-03` detects it; it has not been tested against a real co-located table.
5. **Nothing is validated against real audio yet.** `P5-01` is the first contact with reality, and its findings will generate follow-up tickets.

## Exact next actions

Track A (audio) and track C (persistence) are finished. What remains in phase 1 is the Roll20 chain and the two tickets that consume everything:

1. **`P1-10`** (QA report) is ready now; read the carried items below before implementation.
2. **`P2-01`** (VAD) and **`P4-05`** (sessions/intake UI) are also ready and have disjoint scopes.

`P4-03` (renderer transport and shell) is ready and can proceed in parallel.

Run `npm run tickets -- --ready` rather than trusting this list.

### Carried into `P1-10`

`P1-03` emits three QA codes that `P1-10`'s documented list does not yet contain: `CRAIG_ARCHIVE_EXTRACTED` (info), `CRAIG_NO_TRACKS` (error) and `TRACK_NAME_UNPARSED` (warning). Fold them in when writing that ticket rather than inventing a second list.

`P1-03` also carries a deviation worth knowing about: step 1 asks for the extraction to be "recorded in the manifest", but the `Manifest` contract has no field for it and `contracts/manifest.ts` was outside scope. The archive's sha256 lives in a receipt file beside the extraction, and the fact of extraction surfaces as the `CRAIG_ARCHIVE_EXTRACTED` entry. If a first-class field is wanted, it is a contract change and belongs in its own ticket.

### Decision waiting on you

`P0-03` is blocked on a push. Nothing else depends on it, so phase 1 proceeds regardless.

## Environment notes

- **Node 24 on the dev box**, not the 22 in `.nvmrc`. `engines` is `>=22`, so both work; CI should still pin 22.
- **`uv` is not installed** and installing it needs the human's say-so. `npm run sidecar:setup` falls back to `py -3.12` and a virtualenv at `sidecar/.venv`; `npm run test:py` finds either. The documented `uv` path is untested here.
- **System `python` is 3.9**, below the sidecar's floor. The tooling probes for 3.11+ explicitly rather than trusting `python` on PATH.

## Repository location

The repository sits at the Rider project root, `RiderProjects/Dnd-Auto-Notes/`. It was previously nested one level deeper; the nesting was flattened while integrating `P1-03`. Git history is unaffected — it tracks paths relative to the repository root, which did not move.

One thing the flatten did break: `node_modules/@dnd/{core,cli}` are absolute symlinks, so they pointed at the old path until `npm install` rewrote them. If you ever move the checkout again, run `npm install` before trusting a typecheck. The sidecar virtualenv survives because the tooling invokes `.venv/Scripts/python.exe -m <module>` rather than the console-script shims, which do embed absolute paths.
