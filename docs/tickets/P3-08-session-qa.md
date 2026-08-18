---
id: P3-08
phase: 3
title: Session QA report and the notes stage
status: todo
assignee: ""
depends_on: [P3-06]
scope:
  - packages/core/src/qa/session.ts
  - packages/core/src/stages/notes.ts
  - packages/cli/src/commands/notes.ts
estimate: M
commit: ""
---

## Why

The notes look equally confident whether the pipeline understood 95 % of the session or 60 % of it. The QA report is the only thing that tells the difference, and it is what makes the output trustworthy rather than merely plausible.

## Do

1. Compute and report:
   - transcript coverage — speech seconds transcribed over speech seconds detected;
   - attribution coverage — in-character utterances with a character over all in-character utterances;
   - flagged fraction by code;
   - roll anchoring — matched, interpolated, extrapolated;
   - unmapped rolls and unmapped tracks carried forward from intake;
   - beats with no dialogue and beats with no rolls, both of which usually mean a segmentation problem;
   - per-player speech time, as a sanity check that a track was not silently empty.
2. A single headline `confidence` grade (A–D) from those numbers, with the rule that produces it written next to it. No opaque score.
3. Write `work/07-notes/qa.json`, print a terminal summary, and embed the headline plus the uncertainties list into `session.md`.
4. `pipeline notes --session <id> [--no-llm] [--open]` runs the outline and notes stages and prints where the file landed.
5. Exit code 2 when the grade is D, so automation notices.

## Acceptance

- [ ] Every metric is computed and reported on the fixture.
- [ ] The grading rule is documented and reproducible by hand.
- [ ] The headline and uncertainties appear in `session.md`.
- [ ] A deliberately degraded run grades D and exits 2.
- [ ] `pipeline notes` runs end to end from a fresh session folder.
