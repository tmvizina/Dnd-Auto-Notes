---
id: P3-07
phase: 3
title: Grounded LLM prose pass
status: todo
assignee: ""
depends_on: [P3-06, P2-10]
scope:
  - packages/core/src/render/prose.ts
  - packages/core/src/render/prose.test.ts
estimate: M
commit: ""
---

## Why
Deterministic beat summaries are accurate and flat. A model can make them read well. It can also quietly invent a dragon, so it gets the narrowest possible job and a verifier on the way out.

## Do
1. Operate per beat, never over the whole session. Input: that beat's events, dialogue and rolls. Output: a two-to-four sentence summary and an improved title.
2. Hard prompt contract: use only the supplied events; every proper noun must appear in the input or the campaign registry; no outcomes beyond those stated; if the input is insufficient, return the deterministic summary unchanged.
3. **Verify the output mechanically.** Extract proper nouns, numbers and named entities from the generated prose and assert each appears in the beat's source material or the registry. On violation, keep the deterministic text and record the rejection with the offending token. This check is the ticket, not a nicety.
4. Store generated prose separately from deterministic content, so `--no-llm` re-renders the honest version and the difference is always visible.
5. Cache by beat content hash. Provider comes from `P2-10`; `none` means the deterministic text stands.
6. Record provider, model and token usage per beat in the run ledger.

## Acceptance
- [ ] A beat summary is generated and passes the entity check.
- [ ] An injected hallucination is caught and the deterministic text is kept, with the rejection logged.
- [ ] `--no-llm` reproduces the fully deterministic notes.
- [ ] Generated and deterministic content are separable in storage.
- [ ] Cache hits skip the provider.
- [ ] Usage is recorded per beat.
