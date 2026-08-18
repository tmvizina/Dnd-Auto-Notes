# Handoff

The living state of the build. The orchestrator appends to this after every integrated ticket. Anyone picking the project up reads this first.

## Current state

**Phase 0 is complete** and **phase 1 is over half done.** `P0-01`, `P0-02`, `P0-04`, `P0-05` and `P0-06` are done; `P0-03` (CI) is written and locally verified but **blocked** — its acceptance is a green CI run, which needs a push.

In phase 1, `P1-01`, `P1-02`, `P1-03`, `P1-07` and `P1-08` are done. The whole Roll20 track (`P1-04` → `P1-05` → `P1-06`) is untouched, and `P1-09` (intake stage + CLI) waits on it.

In phase 4, `P4-01` is done: the Electron workspace, locked-down main/preload boundary, packaged custom protocol, static renderer, and dmg/nsis packaging configuration are in place. `P4-02` is now ready.

The repo builds, typechecks, tests and lints clean: 289 TypeScript tests, 40 Python tests, `npm run tickets -- --check` green across all 52 tickets.

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

## Known risks

1. **Roll20 DOM is not an API.** The capture script retains raw `outerHTML` per message so a markup change only breaks the parser, not the recording. `P1-04` and `P1-05` depend on this.
2. **Voice separability is unproven.** If a player's character voice is acoustically indistinguishable from their table voice, `P2-05` degrades to lexical evidence alone and the flagged fraction rises. The bake-off in `P2-05` measures this before the scorer is tuned.
3. **Craig track alignment is assumed, not guaranteed.** `P1-03` now verifies it against the median duration and sets `aligned: false` per track, with `TRACK_DURATION_MISMATCH` naming the outliers. The check is proven against a synthetic outlier only; whether real Craig downloads ever violate the shared t=0 is still unknown until `P5-01`.
4. **Mic bleed from co-located players** would silently double every line. `P2-03` detects it; it has not been tested against a real co-located table.
5. **Nothing is validated against real audio yet.** `P5-01` is the first contact with reality, and its findings will generate follow-up tickets.

## Exact next actions

Track A (audio) and track C (persistence) are finished. What remains in phase 1 is the Roll20 chain and the two tickets that consume everything:

1. **`P1-04` Roll20 browser capture script** — ready now, and the only thing standing between here and `P1-09`.
2. **`P1-05` capture parser**, then **`P1-06` timestamp recovery**.
3. **`P1-09`** (intake stage + CLI) needs the Roll20 half; **`P1-10`** (QA report) follows it.

`P4-02` (IPC contracts and validation) is now ready and can proceed in parallel after the active `P1-04` ticket is integrated.

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
