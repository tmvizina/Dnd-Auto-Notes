---
id: P2-09
phase: 2
title: Roll to speech time anchoring
status: done
assignee: "luna-p2-09"
depends_on: [P2-03, P1-06]
scope:
  - packages/core/src/align/**
  - packages/core/src/stages/align.ts
estimate: L
commit: "45041cc"
---

## Why

Rolls carry the mechanical truth of the session and speech carries the narrative truth. They are only useful together, and joining them needs a shared time axis. When Roll20 gives no wall clock, that axis has to be recovered from what people said.

## Do

1. Both sequences are monotonic in time, which is the whole leverage. Align them with a Needleman-Wunsch style dynamic program under a strict monotonicity constraint, producing anchors, not a fuzzy nearest-neighbour join.
2. Candidate match score between roll `r` and utterance `u`:
   - **number agreement** — the roll total, or a die face, spoken in `u` (spoken-number normalisation from `P2-06`). This is the dominant term; people announce their results.
   - **speaker agreement** — `u` was spoken by the player who owns `r`.
   - **lexical cue** — attack, damage, save, initiative, or check vocabulary near the roll's kind.
   - **temporal prior** — when `time_basis` is `wallclock` or `messageid`, distance from the expected time, with a wide tolerance since announcements trail rolls.
3. Fit a piecewise-linear map from Roll20 sequence position to audio time through the high-confidence anchors, with a robust fit that rejects outliers. Interpolate unanchored rolls and extrapolate at the ends with a widening uncertainty band.
4. Emit per roll `{ t_audio_s, t_uncertainty_s, anchor: "matched"|"interpolated"|"extrapolated", matched_utterance_id }`.
5. In `wallclock` mode, still run the alignment and report the residual against the declared times — a systematic offset means the clocks disagree, and knowing that is worth more than trusting either.
6. Turn-order events get the same treatment; combat boundaries are load-bearing for `P3-03`.
7. Emit an alignment quality report: anchored fraction, median residual, largest unanchored gap.

## Acceptance

- [x] On the fixture, rolls anchor to the utterances that announce them, matching `truth.json`.
- [x] `order_only` captures still anchor above the recorded fraction using number and speaker agreement alone.
- [x] Monotonicity is never violated in the output.
- [x] A deliberately misdeclared wall clock is detected as a systematic residual and reported.
- [x] Interpolated rolls carry an uncertainty that widens with distance from the nearest anchor.
- [x] The quality report is written to the alignment artifact.
