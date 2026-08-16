---
id: P2-05
phase: 2
title: Voice-mode clustering and the campaign profile bank
status: todo
assignee: ""
depends_on: [P2-04, P1-07]
scope:
  - packages/core/src/persona/voiceModes.ts
  - packages/core/src/persona/profileBank.ts
  - packages/core/src/persona/*.test.ts
estimate: L
commit: ""
---

## Why
This is the mechanism that makes the system improve over time. A player's table voice and their character voices are distinguishable clusters; once a cluster is labelled — by the user, once — every future session recognises it immediately. Without this, every session starts from zero.

## Do
1. **Bake-off first, then commit.** Measure whether raw speaker embeddings separate one person's assumed voices, or whether a concatenation of embedding plus z-scored prosody is required. Report cluster purity against `truth.json` for: embedding only, prosody only, and concatenated with a tuned weight. Record the numbers and the choice in `docs/calibration.md`. Do not skip this — the answer is not obvious and it determines the feature vector for everything after.
2. Per player, cluster their utterance feature vectors: agglomerative clustering with cosine distance and a distance threshold, not a fixed k — the number of voices a player uses is unknown and varies per session.
3. Identify the **table voice**: the cluster with the most airtime, weighted toward utterances with high out-of-character lexical evidence and roll proximity. This is the anchor everything else is measured against.
4. Profile bank at `campaign/voice-profiles/<player-id>/`: `table.json` and one file per character, each holding a centroid, a covariance summary or spread radius, an example utterance count, the sessions contributing, and a version.
5. Matching: `matchClusterToProfiles(cluster, bank)` returns ranked candidates with cosine similarity and a margin over the runner-up. Below `MATCH_MIN_SIM` or `MATCH_MIN_MARGIN` the cluster stays unlabelled — flagged, never guessed.
6. Updating: `updateProfile(profileId, utteranceIds)` folds new confirmed utterances into a centroid with a decay weight so a profile tracks a drifting voice without being hijacked by one bad session. Every update is journalled with its source session so it can be reverted.
7. Cold start: with an empty bank, every cluster is unlabelled and everything routes to the review UI. That is the correct behaviour for session one, and the QA report says so plainly.

## Acceptance
- [ ] The bake-off is run and its numbers are in `docs/calibration.md`, with the chosen representation justified by them.
- [ ] On the fixture, per-player clustering recovers the ground-truth voice count within one for each player.
- [ ] A populated bank labels clusters in a second synthetic session at above the recorded accuracy threshold.
- [ ] An ambiguous cluster returns unlabelled with the margin that caused it, and never a guess.
- [ ] `updateProfile` is journalled and revertible.
- [ ] A cold-start run completes with everything unlabelled and no errors.

## Notes
Deleting `campaign/voice-profiles/` must be safe: it costs accuracy, never correctness.
