---
id: P0-05
phase: 0
title: Synthetic session fixture generator
status: todo
assignee: ""
depends_on: [P0-06]
scope:
  - tools/generate-fixture.mjs
  - test/fixtures/**
estimate: M
commit: ""
---

## Why

Every stage needs an end-to-end test and real campaign audio can never be committed — it is large, private, and full of real people's voices and names. A deterministic generator gives every ticket the same reproducible session.

## Do

1. `tools/generate-fixture.mjs --out <dir> [--minutes 6] [--seed 1]` writes a complete fake session folder.
2. Audio: four short tracks generated as tone/noise bursts at scripted times, written directly as WAV (no ffmpeg dependency), each with a known speech-activity schedule and silence elsewhere. Low sample rate, short duration, under 5 MB total.
3. `truth.json` beside it: ground-truth utterance boundaries, player, in-character or not, which character, and the roll each announcement corresponds to. Stage tests assert against this.
4. A Roll20 capture in both accepted shapes — `roll20-capture.json` (live, wall-clock stamped) and `chat-archive.html` (post-hoc DOM) — covering plain chat, `/em`, whisper, an inline roll, a 5e attack roll template, a damage roll, an initiative roll, and two turn-order changes.
5. A `campaign/` fixture: three players plus a DM, PCs, two NPCs, a small glossary.
6. `--with-defects` adds exactly three defects for `P1-10` to detect: an unmapped Roll20 account, a track 3 s shorter than the rest, and a fully silent track.

## Acceptance

- [ ] Two runs with the same seed produce byte-identical output.
- [ ] No real names, no real audio; under 10 MB.
- [ ] `truth.json` covers every generated utterance.
- [ ] `--with-defects` produces exactly the three listed defects.
- [ ] Works with ffmpeg absent from PATH.

## Verify

```bash
node tools/generate-fixture.mjs --out /tmp/f1 && node tools/generate-fixture.mjs --out /tmp/f2 && diff -r /tmp/f1 /tmp/f2
```
