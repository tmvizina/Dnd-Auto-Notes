---
id: P2-03
phase: 2
title: Cross-track timeline merge
status: in_progress
assignee: "luna-p2-03"
depends_on: [P2-02]
scope:
  - packages/core/src/stages/transcript.ts
  - packages/core/src/transcript/**
estimate: M
commit: ""
---

## Why

Per-track transcripts are not a session. The merged, ordered timeline is the object every later stage reasons over, and how overlaps are handled decides whether a crosstalk-heavy table reads as a conversation or as mush.

## Do

1. Compose VAD and ASR across all tracks into `work/02-transcript/utterances.json` through `runStage`.
2. Assign stable ids (`u000412`) ordered by start time, with track id as the tiebreaker so ids are reproducible.
3. Overlap detection: mark utterances that overlap another track's utterance by more than `OVERLAP_MIN_S`, recording `overlap_ids`. Do not drop or merge them — simultaneous speech is real, and combat tables do it constantly.
4. Mic-bleed detection: when two players are in the same physical room, one voice appears on both tracks. Detect near-duplicate text within a small time window across tracks, keep the higher-energy copy as primary, mark the other `bleed_of: <id>`, and raise a QA warning naming the track pair. Bleed silently doubling every line is a realistic and very damaging failure.
5. Backchannel handling: very short utterances that are pure acknowledgement ("yeah", "mhm") get `is_backchannel: true` so the notes renderer can suppress them without losing them.
6. Sentence splitting inside long utterances at word-timestamp gaps, so a two-minute DM monologue becomes addressable spans rather than one blob.
7. Emit counts and total speech per player.

## Acceptance

- [ ] Merged order matches `truth.json` ordering exactly on the fixture.
- [ ] Overlaps are marked on both sides and never dropped.
- [ ] A synthesised bleed case is detected, the primary kept, and a QA warning raised.
- [ ] Utterance ids are stable across re-runs.
- [ ] Long monologues split at pause boundaries, never mid-word.
- [ ] Total speech per player matches the sum of its VAD segments within 1 %.
