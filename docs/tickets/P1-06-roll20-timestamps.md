---
id: P1-06
phase: 1
title: Roll20 timestamp recovery
status: done
assignee: "luna-p1-06"
depends_on: [P1-05]
scope:
  - packages/core/src/intake/roll20/time.ts
  - packages/core/src/intake/roll20/time.test.ts
  - packages/core/src/intake/roll20/index.ts
  - docs/spikes/roll20-timestamps.md
estimate: M
commit: "5dd325b"
---

## Why

If Roll20 events carry real wall-clock time, aligning them to the audio is arithmetic. If they do not, alignment becomes a search problem (`P2-09`). Which world we are in changes the design of two later tickets, so it gets decided with evidence now.

## Do

1. **Spike first.** Take a real capture and determine empirically whether current Roll20 `data-messageid` values are Firebase-style push keys whose leading characters encode a millisecond timestamp. Decode the candidate prefix with the push-key alphabet and check the results against a live capture's own wall-clock stamps from `P1-04` live mode. Write the finding — including the negative case — to `docs/spikes/roll20-timestamps.md`.
2. Implement `resolveTimeBasis(capture)` returning one of:
   - `wallclock` — live-mode stamps present; use them directly;
   - `messageid` — the spike confirmed decodable ids; decode and validate monotonicity, falling back if a decoded time goes backwards;
   - `order_only` — sequence is known, absolute time is not.
3. Emit per-message `{ t_wall_ms | null, seq }` plus the basis, and set `manifest.roll20.time_basis`.
4. Cross-check against the recording window from `P1-03`: any event outside `[start - 5m, start + duration + 5m]` is a QA warning, since it usually means the capture spans two sessions.
5. Convert wall-clock to audio-relative seconds using the Craig recording start, and record the offset explicitly so `P2-09` can refine it.

## Acceptance

- [x] The spike document states the answer with the evidence that produced it.
- [x] All three bases are implemented and unit-tested against fixtures.
- [x] A decoded timestamp that violates monotonicity downgrades the basis rather than producing garbage times.
- [x] Events outside the recording window are warned about, not silently clamped.
- [x] `order_only` captures still produce a usable ordering with `t_wall_ms: null` throughout.

## Notes

Do not let this ticket block: `order_only` is a fully supported path, and `P2-09` is designed to work without absolute time.
