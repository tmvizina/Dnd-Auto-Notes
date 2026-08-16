---
id: P2-11
phase: 2
title: Audio-native adjudicator
status: todo
assignee: ""
depends_on: [P2-10]
scope:
  - sidecar/dnd_sidecar/audio_judge.py
  - packages/core/src/persona/audioAdjudicate.ts
estimate: L
commit: ""
---

## Why
Some ambiguity is not in the words at all. "Fine. We go." can be a resigned character or a player agreeing to a plan, and only the delivery distinguishes them. A model that hears the clip can settle cases a text model cannot.

## Do
1. **Bake-off, not a commitment.** Evaluate the candidates that fit in 64 GB of unified memory on the M1 Max — an audio-capable Qwen Omni variant, an Ultravox-style speech-LLM, and a plain "no audio model, text only" control. Score each on a hand-labelled ambiguous set from `P2-12`: accuracy, latency per clip, and memory. Record the numbers and the recommendation in `docs/calibration.md`. A negative result is a valid outcome and should be written down as one.
2. `POST /audio-judge` (job): `{ clip_path, prompt, candidates }` returns `{ label, confidence, reason }`. Clips are extracted from the source track with padding, cached by utterance id, and cleaned up on a retention policy.
3. Same guardrails as `P2-10`: closed candidate set, strict JSON, `source: "audio-llm"`, revertible, cached by content hash.
4. Gate on `/health` capability. Absent, the text adjudicator handles it and the QA report says which spans could have benefited.
5. Route by flag code: `voice_margin_low` and `unknown_npc` go to audio; `lex_conflict` goes to text. Do not send everything everywhere.

## Acceptance
- [ ] The bake-off is run and its numbers, including the control, are in `docs/calibration.md`.
- [ ] Clip extraction is exact to the utterance bounds with the configured padding.
- [ ] Missing capability degrades to the text adjudicator with no error.
- [ ] Routing sends each flag code to the configured adjudicator only.
- [ ] Audio adjudications are marked and revertible.
- [ ] Clip cache respects its retention policy and never grows unbounded.
