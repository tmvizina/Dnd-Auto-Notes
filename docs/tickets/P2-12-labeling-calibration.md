---
id: P2-12
phase: 2
title: Labeling CLI and calibration
status: todo
assignee: ""
depends_on: [P2-08]
scope:
  - packages/cli/src/commands/label.ts
  - packages/core/src/persona/calibrate.ts
  - docs/calibration.md
estimate: M
commit: ""
---

## Why

Thresholds guessed in code are thresholds that are wrong. Twenty minutes of hand labelling per campaign turns every weight in the scorer from a guess into a measurement, and gives the profile bank its first real anchors.

## Do

1. `pipeline label --session <id> [--minutes 15] [--strategy uncertain|stratified|sequential]` walks utterances in the terminal, playing each clip through the platform audio player, and records `{ utterance_id, mode, character_id, labeller, at }` to `campaign/labels/<session>.jsonl`, append-only.
2. Sampling strategies: `uncertain` (highest-entropy first, best value per minute), `stratified` (proportional across players and modes, best for unbiased metrics), `sequential` (a contiguous slice, best for the profile bank).
3. Resumable and interruptible: the file is append-only, and a re-run skips what is already labelled unless `--relabel`.
4. `pipeline calibrate --campaign` fits the scorer weights against all accumulated labels — logistic regression on the feature vectors, regularised, with k-fold cross-validation — and writes a new versioned weights file. Never overwrite the previous version; write a new one and record which is active.
5. Report precision, recall and F1 per class, character-assignment accuracy, the flagged fraction at the current thresholds, and a threshold sweep showing the trade-off between flagged volume and error rate. Append every run to `docs/calibration.md` with the date, session, label count and numbers.
6. Seed the profile bank from labelled utterances, since labelled data is exactly what a centroid wants.
7. Refuse to fit below a minimum label count, and say how many more are needed.

## Acceptance

- [ ] Labelling 50 utterances and re-running skips them.
- [ ] All three sampling strategies work and are documented for when to use which.
- [ ] Calibration produces a new weights file and never mutates the old one.
- [ ] The report includes per-class precision and recall and a threshold sweep.
- [ ] `docs/calibration.md` gains an appended, dated entry per run.
- [ ] Fitting below the minimum label count refuses with the shortfall stated.
- [ ] Labelled utterances measurably improve the profile bank on a held-out session.
