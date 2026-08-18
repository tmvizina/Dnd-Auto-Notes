---
id: P3-03
phase: 3
title: Combat encounter reconstruction
status: in_progress
assignee: "luna-p3-03"
depends_on: [P3-02]
scope:
  - packages/core/src/outline/encounter.ts
  - packages/core/src/outline/encounter.test.ts
estimate: L
commit: ""
---

## Why

Combat is the most mechanically legible part of a session and the part players most want a record of. It is also almost entirely reconstructable from rolls and turn order, with speech only supplying the colour.

## Do

1. For each `combat` beat, build an encounter from the turn-order tracker: participants in initiative order with their values, PCs resolved to characters and NPCs to registry entries where possible.
2. Rounds from turn-order cycling: a wrap back to the top of the order starts a new round. Handle mid-combat insertions, removals and delays without losing the round count.
3. Assign each roll to a `(round, turn)` by its anchored time and the actor's ownership, and classify: attack (with advantage state and target where recoverable), damage, save, check, death save.
4. Attach the speech in each turn's window to that turn — this is where "I disengage and move behind the pillar" ends up next to the roll it belongs to.
5. Outcome inference, strictly bounded: damage totals per target where the target is stated, hit or miss where an AC comparison is actually available, and death-save tracking. **Never infer HP totals or a monster's death from silence.** Unknown is a legitimate and expected value here.
6. Where the tracker is absent — plenty of tables never use it — fall back to an initiative-roll cluster to open the encounter and a roll-density collapse to close it, and mark the encounter `reconstruction: "inferred"`.
7. Emit a per-encounter summary: rounds, participants, total damage by actor, notable rolls (natural 20s and 1s, criticals, failed death saves).

## Acceptance

- [ ] Round boundaries match the fixture's turn-order cycles.
- [ ] Every roll inside a combat beat is assigned to a turn or explicitly listed as unassigned with a reason.
- [ ] Advantage and disadvantage survive from the parser into the encounter record.
- [ ] Turn narration attaches to the correct turn.
- [ ] No HP or death outcome is stated without a roll or explicit speech supporting it.
- [ ] The trackerless fallback reconstructs an encounter and marks it inferred.
