---
id: P5-02
phase: 5
title: Performance budgets
status: todo
assignee: ""
depends_on: [P5-01]
scope:
  - docs/performance.md
  - tools/bench.mjs
estimate: M
commit: ""
---

## Why
A four-hour session is a lot of audio. Without measured budgets, "it takes a while" gradually becomes "it takes overnight" and nobody notices which stage caused it.

## Do
1. Set budgets on the M1 Max for a four-hour, five-track session, measured before being declared:
   - intake under 2 minutes;
   - VAD under 5 minutes;
   - ASR — the dominant cost, target better than 8x realtime on speech-only audio;
   - features under 10 minutes;
   - persona, align, outline, notes — each under 1 minute (pure CPU logic);
   - app cold start to usable window under 3 seconds, idle memory under 300 MiB.
2. `tools/bench.mjs` runs a fixed workload and writes a timing table; a `--compare` mode diffs against the recorded baseline.
3. Measure before optimising, and optimise in measured order. Record every optimisation with its before and after.
4. Memory ceiling: the pipeline must not exceed 32 GiB resident so the machine stays usable while it runs.
5. Document the measurement protocol precisely enough to reproduce, including how to read process memory, and mark an unmeasurable run `N/A` with the reason rather than recording a zero.

## Acceptance
- [ ] Every stage has a measured budget in `docs/performance.md`.
- [ ] `tools/bench.mjs --compare` detects a deliberately introduced 2x regression.
- [ ] Peak resident memory stays under the ceiling on the real session.
- [ ] Cold start and idle memory meet their budgets on a packaged build.
- [ ] The protocol is reproducible by someone who did not write it.
