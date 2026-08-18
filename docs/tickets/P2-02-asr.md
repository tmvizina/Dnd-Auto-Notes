---
id: P2-02
phase: 2
title: ASR with word timestamps
status: todo
assignee: ""
depends_on: [P2-01]
scope:
  - sidecar/dnd_sidecar/asr.py
  - sidecar/tests/test_asr.py
estimate: L
commit: ""
---

## Why

Everything textual downstream — lexical rules, roll anchoring, quotes in the notes — is only as good as the transcript. Word-level timestamps specifically are what let a roll announcement be matched to the moment it was said.

## Do

1. `POST /transcribe` (job): `{ track_path, segments, backend, model, params }` returns `[{ start_s, end_s, text, words: [{t, s, e}], avg_logprob, no_speech_prob }]` with times in **track-absolute seconds**, not segment-relative.
2. Pluggable backends behind one interface, selected by config and gated on `/health` capabilities:
   - `mlx-whisper` — the M1 Max path, Metal-accelerated;
   - `faster-whisper` — CTranslate2, CPU or CUDA, the Windows and CI path;
   - `whisper.cpp` — subprocess fallback.
3. Deterministic settings: `temperature=0`, fixed beam size, `condition_on_previous_text=False`. Identical audio must produce an identical transcript across runs.
4. Model singleton reused across jobs, loaded lazily under the job gate, with the model name and backend recorded in every result.
5. Domain bias: pass an initial prompt built from the campaign glossary and character/NPC names so proper nouns transcribe consistently. Cap its length and log what was used.
6. `DND_FAKE_ASR=1` returns a deterministic transcript derived from the fixture's `truth.json` so CI never needs a model.
7. Per-segment failures are recorded and skipped, never fatal to the job.

## Acceptance

- [ ] Word timestamps are track-absolute and monotonically increasing.
- [ ] The same audio transcribed twice is byte-identical.
- [ ] All three backends produce the same schema; a missing backend fails with a message naming the install command.
- [ ] Glossary biasing measurably improves proper-noun accuracy on a fixture containing invented names.
- [ ] `DND_FAKE_ASR=1` completes the full stage with no model installed.
- [ ] A four-hour session's speech transcribes within the budget recorded in `P5-02`.

## Notes

Audio Forge's `worker/audioforge_worker/asr.py` is the reference for the deterministic settings and the lazy singleton; extend it with backend selection rather than reinventing it.
