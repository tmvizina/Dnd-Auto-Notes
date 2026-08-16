---
id: P3-02
phase: 3
title: Beat segmentation
status: todo
assignee: ""
depends_on: [P3-01]
scope:
  - packages/core/src/outline/beats.ts
  - packages/core/src/outline/beats.test.ts
estimate: L
commit: ""
---

## Why
"What happened this session" is a sequence of scenes, not a transcript. Beat boundaries are what turn four hours of events into a readable outline, and they can be found from structure rather than from meaning.

## Do
1. Score candidate boundaries from deterministic signals, each contributing weighted evidence:
   - a silence gap over `BEAT_GAP_S`;
   - a turn-order transition — combat start and end are almost always beat boundaries;
   - a step change in roll density (CUSUM over a sliding window);
   - a change in the active speaker set (who is talking, by Jaccard distance between windows);
   - a shift in the active NPC set from `P2-08`;
   - first mention of a location or faction from the campaign glossary;
   - a long DM narration following silence, which is how scenes conventionally open.
2. Choose boundaries by peak-picking with a minimum beat duration, so a chatty stretch does not shatter into fragments.
3. Classify each beat: `combat`, `social`, `exploration`, `planning`, `table` (out-of-character overhead — breaks, rules arguments, recaps), `recap`.
4. Title each beat deterministically from its content: location plus NPC, or the encounter participants. The LLM pass may improve titles later; the deterministic title must stand alone.
5. Emit per beat: participants, dominant characters, roll count by kind, in-character speech ratio, and its constituent event ids.
6. `table` beats are retained and marked, not deleted. A twenty-minute rules argument belongs in the record as a line, not as a silently missing half hour.

## Acceptance
- [ ] Combat beats align to turn-order boundaries within one event.
- [ ] Beat count on the fixture is within 20 % of `truth.json`, with no beat under the minimum duration.
- [ ] Classification matches the fixture's labels.
- [ ] Every event belongs to exactly one beat and no event is lost.
- [ ] Deterministic titles are non-empty and distinguishable.
- [ ] Boundary evidence is recorded per beat so a wrong split is explainable.
