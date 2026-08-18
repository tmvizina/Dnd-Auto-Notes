---
id: P2-07
phase: 2
title: Persona scorer and flagging
status: in_progress
assignee: "luna-p2-07"
depends_on: [P2-05, P2-06, P2-09]
scope:
  - packages/core/src/persona/scorer.ts
  - packages/core/src/stages/persona.ts
  - packages/core/src/persona/scorer.test.ts
estimate: L
commit: ""
---

## Why

This is the decision the whole project exists to make. It has to be explainable, tunable, and honest about what it does not know — a confident wrong label is worse than an admitted uncertainty, because only one of those gets fixed.

## Do

1. Assemble a feature vector per utterance from the earlier stages: `voice_sim_table`, `voice_sim_best_character`, `voice_margin`, `prosody_z`, `lex_ooc`, `lex_ic`, `roll_prox` (a roll by this player within the anchoring window), `chat_prox`, `addressee`, `duration`, `is_backchannel`, `overlap`.
2. `score_ic = sigmoid(w · f)` with weights in a versioned config file, not in code. Ship hand-set initial weights derived from the signal strengths, and make the file the thing `P2-12` tunes.
3. Decision bands: `>= hi` in character, `<= lo` out of character, otherwise `uncertain` — with the specific reason recorded (`voice_margin_low`, `lex_conflict`, `too_short`, `no_profile_match`, `overlapped`).
4. Character assignment for in-character utterances: nearest labelled profile subject to `MATCH_MIN_MARGIN`; below it, `mode: in_character, character_id: null` plus flag `character_unknown`. Restrict candidates to characters active in this session (`charactersActiveAt`).
5. Quoted-speech spans from `P2-06` produce **child attributions** — the frame stays with the speaker as narration, the quoted span is attributed separately. The contract already allows sub-utterance spans; use them.
6. Smoothing: an isolated one-utterance flip inside a run of the same mode, with a weak score, is pulled toward its neighbours by a bounded amount. Log every smoothing correction; a smoother that silently rewrites strong evidence is a bug.
7. Write `work/04-persona/attribution.json` with full evidence per utterance and a summary block, and mirror open flags into the `flags` table.

## Acceptance

- [ ] Weights and thresholds live in a versioned config file; changing them requires no code edit and bumps the stage version.
- [ ] Every attribution carries the evidence that produced it.
- [ ] Every uncertain attribution carries a specific reason code.
- [ ] Quoted speech produces a child attribution with correct time bounds.
- [ ] Smoothing never overrides a score outside the uncertain band, and every correction is logged.
- [ ] On the fixture, in-character/out-of-character accuracy against `truth.json` is reported per class in the stage result.
- [ ] The stage completes with an empty profile bank, flagging everything, without error.
