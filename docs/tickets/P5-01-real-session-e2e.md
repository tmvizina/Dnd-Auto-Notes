---
id: P5-01
phase: 5
title: Real-session end-to-end
status: todo
assignee: ""
depends_on: [P3-08]
scope:
  - docs/runs/**
estimate: M
commit: ""
---

## Why

Synthetic fixtures prove the code runs. Only a real four-hour session with real crosstalk, real accents and a real DM proves it works. Everything the fixtures could not anticipate shows up here.

## Do

1. Process one complete real session end to end, recording wall-clock per stage and peak memory.
2. Have someone who was at the table read `session.md` and mark every error: wrong attribution, invented event, missed beat, mangled name.
3. Produce `docs/runs/<date>-<session>.md`: the QA numbers, the human error list, and a categorisation of each error by which stage caused it.
4. Turn the categorised errors into follow-up tickets rather than fixing them ad hoc in this ticket.
5. Hand-label a slice of this session and run `pipeline calibrate`, recording the before and after.
6. Note anything the synthetic fixture failed to represent and extend the generator accordingly.

## Acceptance

- [ ] A real session completes every stage without manual intervention beyond registry mapping.
- [ ] A human review of the notes exists with a per-error stage attribution.
- [ ] QA metrics and stage timings are recorded.
- [ ] Follow-up tickets are filed for every error class found.
- [ ] The fixture generator is extended to cover at least one newly discovered case.
