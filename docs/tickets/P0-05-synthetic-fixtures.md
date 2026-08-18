---
id: P0-05
phase: 0
title: Synthetic session fixture generator
status: approved
assignee: "orchestrator"
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

- [x] Two runs with the same seed produce byte-identical output.
- [x] No real names, no real audio; under 10 MB.
- [x] `truth.json` covers every generated utterance.
- [x] `--with-defects` produces exactly the three listed defects.
- [x] Works with ffmpeg absent from PATH.

## Verify

```bash
node tools/generate-fixture.mjs --out /tmp/f1 && node tools/generate-fixture.mjs --out /tmp/f2 && diff -r /tmp/f1 /tmp/f2
```

## Delivered

`tools/generate-fixture.mjs` plus two modules it composes: `fixture-script.mjs` (the scripted session — 20 utterances, 6 rolls, 2 turn-order transitions, fixed rather than random so tests assert exact boundaries) and `fixture-audio.mjs` (seeded PRNG, WAV encoder, no ffmpeg). 12 tests in `test/fixture.test.ts`.

Design choices worth recording:

- **Each speaker gets a distinct fundamental, and in-character lines a different one again.** One person with two voices on one track is precisely what `P2-05` has to separate, so the fixture contains that case rather than four uniform speakers. The two schedules partition the utterances, so the voices never sum into a third thing.
- **Silence is true digital silence.** Discord gates transmission, so a Craig track really is silent between utterances. Room tone here would teach the VAD the wrong lesson.
- **The fixture is generated, not committed.** `.gitignore` excludes `*.wav` deliberately, the output is ~3.8 MB per generation, and byte-identical output for a given seed makes generating equivalent to storing. `test/fixtures/README.md` says so, and the tests call the generator into a temp directory. This is a deviation from the ticket's implied `--out test/fixtures/session-synthetic` default, which remains available as `npm run fixture:generate`.
- **`--seconds 60` rather than `--minutes 6`.** Six minutes at four tracks is ~23 MB of uncompressed PCM, well past the ticket's own ceiling. Sixty seconds holds the whole script with room to spare; `--minutes` still works for anyone who wants a longer one.

Verified: two runs at the same seed are byte-identical file-for-file; a different seed changes the audio; the clean fixture has zero defects and uniform track durations; `--with-defects` produces exactly `ROLL20_ACCOUNT_UNMAPPED`, `TRACK_DURATION_MISMATCH` and `TRACK_SILENT` and nothing else; every roll links to the utterance that announces it; no two utterances overlap on one track; the capture carries all five message kinds with raw `outerHTML` retained; the archive page carries the same message ids; and the WAV headers are checked byte-wise, since ffmpeg is never invoked.
