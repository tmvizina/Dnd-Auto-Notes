---
id: P2-01
phase: 2
title: VAD segmentation per track
status: todo
assignee: ""
depends_on: [P1-01, P1-09]
scope:
  - sidecar/dnd_sidecar/vad.py
  - sidecar/tests/test_vad.py
estimate: M
commit: ""
---

## Why

A four-hour track is mostly silence. Segmenting first means ASR runs on minutes of speech rather than hours of nothing, and it gives us utterance boundaries that are acoustic rather than invented by the transcriber.

## Do

1. `POST /vad` (job) takes `{ track_path, params }` and returns speech segments `[{ start_s, end_s, mean_rms }]`.
2. Backend: Silero VAD when available, else an energy-based fallback with an adaptive noise floor. Report which was used in the job result. The fallback must be good enough that the pipeline works on a bare machine.
3. Segment shaping parameters, all overridable: `min_speech_s` (0.30), `min_silence_s` (0.40), `pad_s` (0.15), `max_segment_s` (30, hard-split with overlap so ASR never sees an unbounded clip).
4. Discord-specific handling: Craig tracks are silence-gated by Discord's own transmission, so silence is _true_ silence, not room tone. Do not apply aggressive noise-floor adaptation that would swallow quiet speech after a long gap.
5. Downmix to 16 kHz mono in a temp file for analysis; never modify the source.
6. Report `speech_ratio` and total speech seconds per track in the job result.

## Acceptance

- [ ] Segments on the synthetic fixture match `truth.json` boundaries within 200 ms at both edges.
- [ ] The energy fallback produces usable segments with Silero absent.
- [ ] A 30-minute track segments in under 30 s on the M1 Max with the fallback.
- [ ] `max_segment_s` splits produce overlapping windows so no word is cut in half.
- [ ] Source files are byte-identical after the run.
