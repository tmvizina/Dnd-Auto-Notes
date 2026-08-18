---
id: P2-04
phase: 2
title: Utterance embeddings and prosody features
status: todo
assignee: ""
depends_on: [P2-03]
scope:
  - sidecar/dnd_sidecar/features.py
  - sidecar/tests/test_features.py
  - packages/core/src/stages/features.ts
estimate: M
commit: ""
---

## Why

Text alone cannot tell you that a player just dropped into their character's voice. The acoustic evidence is the strongest single signal for in-character detection, and it is what makes the DM's dozen NPCs separable at all.

## Do

1. `POST /features` (job): `{ track_path, utterances }` returns per utterance an embedding plus prosody features.
2. Embedding: ECAPA-TDNN via speechbrain, or WavLM-based x-vectors if the bake-off in `P2-05` prefers it. L2-normalised, dimension recorded in the result.
3. Prosody, computed per utterance and also z-scored against that player's own session-wide baseline: F0 mean, F0 std, F0 range, speaking rate (words per second from ASR word times), mean intensity, intensity std, spectral tilt, jitter proxy, and pause ratio.
4. Skip utterances below `MIN_FEATURE_DURATION_S` (0.6) — embeddings from a quarter-second grunt are noise, and pretending otherwise pollutes every cluster. Mark them `features: null`.
5. Store as a compact binary sidecar file (`features.bin` plus an index in `features.json`) rather than tens of thousands of JSON float arrays.
6. `DND_FAKE_EMBED=1` produces deterministic pseudo-embeddings seeded per (player, character) from `truth.json`, so clustering logic is testable without models.
7. Batch on the GPU/MPS and report throughput.

## Acceptance

- [ ] Every utterance above the duration floor has an embedding and a full prosody vector.
- [ ] Embeddings are L2-normalised and deterministic for identical audio.
- [ ] Z-scoring is per player, not global.
- [ ] The binary store round-trips exactly and is under 30 MB for a four-hour session.
- [ ] Fake mode yields clusters that separate cleanly, so downstream tests are meaningful.
- [ ] Feature extraction for a four-hour session completes within the `P5-02` budget.
