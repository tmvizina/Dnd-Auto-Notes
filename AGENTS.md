# AGENTS.md

Rules for any agent (Codex, Claude Code, or otherwise) working in this repository. Read this before your first edit, then read the ticket you were assigned and `docs/orchestration.md`.

## Read order before editing

1. This file.
2. `docs/orchestration.md` — role, loop, hard rules.
3. `docs/HANDOFF.md` — current state, last commit, exact next action.
4. Your ticket in `docs/tickets/`.
5. `git status` and `git log --oneline -10`. Confirm the branch. Do not switch branches.

## Authority boundaries

- **Do not commit** unless you are the orchestrator.
- **Do not push, open PRs, publish, or install machine-wide software** without asking the human.
- **Do not run paid provider prompts** (frontier API calls) without asking.
- **Do not delete or overwrite unrelated working-tree changes.** Never `git clean`, `git reset --hard`, or `git checkout --` to make a tree look clean.
- **Do not start, stop, or restart services the human is using.** Ask first.

## Scope discipline

Your ticket lists `scope:` paths. That is your boundary. If the work genuinely requires a file outside it, stop and report — do not widen the scope yourself. Cross-cutting edits are how two workers silently overwrite each other.

## Code conventions

- **TypeScript**: ESM, `strict`, Node 22. No `any` in exported signatures. Errors are typed and structured, never bare strings thrown across a boundary.
- **Python**: 3.11+, `from __future__ import annotations`, type hints on public functions, `ruff` clean. Pure logic separated from model glue — model imports are lazy so the pure functions stay unit-testable on a machine with no GPU and no models installed. Follow the shape of `Audio-Forge-/worker/audioforge_worker/diarize.py`.
- **Paths**: always `path.join` / `pathlib.Path`. No hard-coded `/` or `C:\`. The primary target is macOS; Windows must not break.
- **Determinism**: given identical inputs, a stage produces byte-identical output. Fixed seeds, sorted iteration, no wall-clock in output payloads except the explicit timestamp fields.
- **Comments** explain _why_, not _what_. Match the density of the surrounding file.

## Testing

- TypeScript: Vitest, tests next to sources as `*.test.ts`.
- Python: pytest under `sidecar/tests/`.
- Every stage gets a fixture-driven end-to-end test that runs with **no models installed** — the sidecar exposes deterministic fake backends for exactly this (`DND_FAKE_ASR=1`, `DND_FAKE_EMBED=1`).
- Never commit real campaign audio, real player names, or real Roll20 exports. Fixtures are generated (`P0-05`).

## Git on Windows

Git mutations must be separate tool invocations — never chained with `;`, `&&`, `||`, or pipes, and never wrapped in an explicit `powershell` / `cmd.exe` call. Use:

```bash
git add -- <files>
```

```bash
git diff --cached --check
```

```bash
git diff --cached --stat
```

```bash
git commit -m "P1-03: craig intake"
```

Commit messages start with the ticket id.

## Domain rules that are easy to get wrong

- **A Craig track is one Discord user, not one character.** Never label a track with a character name.
- **The DM is many characters.** Any code path that assumes one speaker → one persona is wrong.
- **Never invent attribution.** If evidence is insufficient, emit a flag with a code. Guessing quietly is the single worst failure mode in this project, because it is invisible in the output.
- **Never let a re-run be blocked.** Stages skip when nothing changed; `--force` always overrides. Refusing to re-run because work "is already done" is a bug.
- **Audio in the UI is lazy.** An `<audio>` element gets no `src` until the user presses play. An eagerly-loaded list of clips will exhaust memory and lock the machine.
- **The sidecar never opens the database.** It reads audio, writes JSON, returns results. Node owns persistence.
