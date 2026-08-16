---
id: P3-01
phase: 3
title: Event model and timeline assembly
status: todo
assignee: ""
depends_on: [P2-07, P2-09]
scope:
  - packages/core/src/outline/events.ts
  - packages/core/src/stages/outline.ts
estimate: M
commit: ""
---

## Why
Attributed speech and anchored rolls are still two lists. The event model is the single ordered stream the renderer and the app both read, and fixing it early lets phase 4 start in parallel with the rest of phase 3.

## Do
1. One `SessionEvent` union over a single time axis: `speech` (with mode, speaker, character, text, confidence), `roll`, `chat`, `turnorder`, `combat_start`, `combat_end`, `gap` (silence over a threshold), `session_start`, `session_end`.
2. Every event carries `t_start_s`, `t_end_s`, a stable id, a `source_refs` list of the utterance and roll ids it derives from, and a `confidence`.
3. Merge, sort and de-duplicate: a roll announcement matched to an utterance links them rather than emitting both as unrelated events.
4. Derived convenience fields the renderer needs and should not recompute: speaker display name, character display name, whether the speaker is the DM.
5. A traversal API — `eventsBetween(a, b)`, `eventsFor(characterId)`, `rollsInWindow` — used by every later ticket so nobody re-implements slicing.
6. Freeze the event id scheme; the app stores these ids.

## Acceptance
- [ ] Events are strictly ordered with deterministic ids across re-runs.
- [ ] Every event's `source_refs` resolve to existing utterance or roll ids.
- [ ] A roll and the utterance announcing it are linked, not duplicated.
- [ ] Gaps over the threshold appear as events.
- [ ] The traversal API is covered by tests and used by `P3-02` onward.
