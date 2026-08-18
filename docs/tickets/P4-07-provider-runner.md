---
id: P4-07
phase: 4
title: Claude and Codex provider runner
status: todo
assignee: ""
depends_on: [P4-06, P2-10]
scope:
  - app/desktop/src/main/providers/**
estimate: L
commit: ""
---

## Why

The app's LLM features — adjudication, prose, notes editing — all go through one seam. Making that seam an injectable interface with a deterministic fake means the whole app is testable without ever spending a token.

## Do

1. `ProviderRunner` interface: `start(request) -> RunHandle` where the handle exposes an event stream, `cancel(reason)` and `wait()`. Inject it at composition; nothing constructs a runner inline.
2. `CliProviderRunner` spawns `claude` or `codex` headlessly:
   - Claude: `-p --output-format stream-json --verbose --permission-mode <mode>`;
   - Codex: `exec --json`;
   - prompt over **stdin**, never argv;
   - cwd is the repo root so project skills and slash commands resolve;
   - cancel means SIGTERM then SIGKILL after a grace period.
3. Discovery: resolve each CLI by walking PATH with PATHEXT plus known install locations, `realpath`, then `--version` with a short timeout, ANSI-stripped and truncated. Report `not_installed | auth_required | ready`, and never claim `ready` without a successful probe.
4. Normalise both CLIs' JSONL into the shared event union via the ported normaliser; malformed lines become `malformed` events plus a parse issue, never an exception.
5. Persist: raw NDJSON per run under `logs/runs/<run_id>.ndjson`, plus an `agent_runs` row with status, result, turns, duration, tokens and cost. A run that finishes after the window closed is still recorded.
6. `DeterministicFakeRunner` exercises the whole lifecycle offline, and is excluded from the packaged bundle.

## Acceptance

- [ ] Both CLIs are discovered when installed and reported precisely when not.
- [ ] A real headless run streams events and records a complete `agent_runs` row.
- [ ] Prompts containing quotes, newlines and unicode survive intact via stdin.
- [ ] Cancel terminates the child; no orphan remains.
- [ ] A truncated or malformed stream yields `malformed` events and a failed run, not a crash.
- [ ] The full test suite passes with the fake runner and no CLI installed.
- [ ] The fake is absent from the packaged app bundle.
