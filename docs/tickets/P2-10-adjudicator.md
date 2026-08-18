---
id: P2-10
phase: 2
title: Adjudicator interface and providers
status: in_progress
assignee: "luna-p2-10"
depends_on: [P2-07]
scope:
  - packages/core/src/llm/**
  - packages/core/src/persona/adjudicate.ts
  - packages/core/src/persona/adjudicate.test.ts
estimate: L
commit: ""
---

## Why

A few hundred spans per session will genuinely be ambiguous — a whispered aside, a player who barely changes voice, an NPC introduced by pronoun. An LLM given the surrounding minute of transcript and a closed set of candidate labels is good at exactly that, and useless at labelling four thousand utterances from scratch.

## Do

1. `LlmProvider` interface: `complete({ system, prompt, schema, signal })` returning parsed JSON plus usage, with a `capabilities()` probe. Implementations:
   - `cli-claude` — spawn `claude -p --output-format stream-json --verbose --permission-mode <mode>`, **prompt over stdin**, parse the NDJSON stream, take the `result` event;
   - `cli-codex` — `codex exec --json`, prompt over stdin, same normalisation;
   - `http-local` — OpenAI-compatible `/v1/chat/completions` against a configurable base URL, so LM Studio, Ollama or llama.cpp on the Mac all work, including over the LAN;
   - `none` — returns `unavailable`, and every caller must handle it.
2. Port the stream normaliser from `Manuscript-Work/packages/core/src/execution/normalize.ts` rather than rewriting it: it already folds both CLIs into one event union and turns malformed lines into `malformed` events instead of throwing.
3. CLI resolution probes platform-ordered candidates (`%APPDATA%\npm\claude.cmd`, `~/.local/bin/claude`, PATH with `PATHEXT`) and verifies with `--version`, once, cached.
4. `adjudicateSpans(flagged, context, provider)`: batch flagged spans, each with the surrounding transcript window, the speaker, the candidate labels, and the evidence that made it uncertain. Require a strict JSON response: `{ utterance_id, label, character_id | null, confidence, reason }`. Reject and retry once on schema violation, then give up and leave the span flagged.
5. Never let the adjudicator invent a label outside the candidate set, and never let it raise confidence on a span the deterministic scorer was confident about. Its output is recorded as `source: "llm"` and is separately revertible.
6. Cache by content hash so a re-run does not re-spend.
7. Cancellation propagates: killing the run kills the child process.

## Acceptance

- [ ] All four providers satisfy the interface; `none` is the default.
- [ ] The full pipeline completes with `none` and every flag intact.
- [ ] A malformed CLI stream produces a structured error, not a crash.
- [ ] Out-of-set labels are rejected.
- [ ] Adjudicated attributions are marked `source: "llm"` and can be reverted in bulk.
- [ ] Cache hits skip the provider entirely.
- [ ] Cancelling mid-batch leaves no orphan child process.
