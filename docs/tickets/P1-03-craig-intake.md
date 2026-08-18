---
id: P1-03
phase: 1
title: Craig recording intake
status: in_progress
assignee: "orchestrator"
depends_on: [P0-06, P1-02]
scope:
  - packages/core/src/intake/craig/**
  - packages/core/src/index.ts
  - sidecar/dnd_sidecar/probe.py
  - sidecar/dnd_sidecar/server.py
  - sidecar/tests/test_probe.py
estimate: M
commit: ""
---

## Why

Speaker identity is the one thing this project gets for free, and it comes entirely from parsing Craig's output correctly. If a track binds to the wrong player, every downstream attribution is wrong and nothing later will catch it.

## Do

1. Accept either an extracted folder or the downloaded archive in `input/craig/`. If it is an archive, extract to `input/craig/extracted/` once and record that in the manifest; never re-extract on a re-run unless the archive hash changed.
2. Discover tracks by extension (`.flac`, `.aac`, `.m4a`, `.mp3`, `.ogg`, `.wav`). Parse the Craig filename convention `<index>-<username>[_<discriminator>].<ext>` into `{ index, username, discriminator }`, tolerating unicode display names and unexpected separators — an unparseable name is a warning that falls back to the raw stem, not a crash.
3. Parse `info.txt` when present for recording start time, guild/channel, and the participant list; treat every field as optional.
4. Probe each track with `ffprobe` via the sidecar (`POST /probe`, synchronous) for duration, sample rate, channels, and codec. Add the endpoint to the sidecar as part of this ticket.
5. Compute a cheap `speech_ratio` per track (frame energy above an adaptive floor) so a muted or absent participant is visible without running VAD.
6. Alignment check: assert all track durations agree within `ALIGNMENT_TOLERANCE_S` (default 2.0). Set `aligned: false` and emit a QA warning naming the outliers if not — Craig's multi-track download is supposed to share a common t=0, and a violation invalidates every cross-track timestamp.
7. Bind each track to a `player_id` via the campaign registry. Exact Discord user id wins; then username; then a fuzzy match on display name above a threshold, recorded as `match: "fuzzy"` with the score. Below threshold, leave `player_id: null` and emit a QA error listing the top three candidates.
8. sha256 every track (streamed) into the manifest.

## Acceptance

- [ ] The synthetic fixture produces one manifest track per generated file with correct durations.
- [ ] Filename parsing covers the Craig convention plus three malformed cases without throwing.
- [ ] A duration outlier sets `aligned: false` and names the outlier track.
- [ ] The silent track from `--with-defects` is reported with a near-zero `speech_ratio`.
- [ ] An unmapped username yields `player_id: null` plus a candidate list — never a guess.
- [ ] Re-running with unchanged inputs re-extracts nothing and rewrites nothing.

## Scope amendment

Step 4 ("add the endpoint to the sidecar as part of this ticket") cannot be done
inside `packages/core/src/intake/craig/**`. The orchestrator widened `scope:` to
the sidecar probe module, its endpoint and its test, plus the one-line barrel
export in `packages/core/src/index.ts` — the same widening `P1-02` took. No other
ticket's scope overlaps these paths.

## Notes

Craig's multi-track download aligns all tracks to the recording start; that assumption is load-bearing, which is why step 6 verifies it rather than trusting it.
