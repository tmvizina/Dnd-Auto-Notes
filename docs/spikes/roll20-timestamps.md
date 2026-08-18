# Roll20 timestamp recovery spike

## Finding

Roll20 `data-messageid` values in the supplied privacy-safe archive are
Firebase-style push keys: the first eight characters decode with Firebase's
push alphabet to millisecond timestamps in a plausible 2026 range. They are a
useful recovery candidate, but they are not a reliable recording clock for an
archive by themselves. The implementation therefore supports `messageid` for
a complete monotonic stream and falls back to `order_only` as soon as decoded
time goes backwards.

## Evidence

The archive contained 98 non-null message ids. All 98 decoded successfully.
The decoded values ranged from `2026-08-07T00:09:35.990Z` to
`2026-08-16T00:09:00.970Z`, a span of approximately 215.99 hours. In capture
order there was one backward step of approximately 3.19 seconds. There were
15 gaps larger than five minutes, including two larger than one hour; the
largest gap was approximately 166.47 hours.

The saved HTML contained no live wall-clock stamps from P1-04 and covered more
than one session, so a direct id-to-live-stamp comparison was not available for
this artifact. That explains both the broad range and the backward step: the
ids retain server creation time, but the archive is not proof that every record
belongs to one recording window. No private path, campaign/player name, or raw
message content is recorded here.

## Decision

- A live capture with `t_wall_ms` values uses `wallclock` directly.
- A capture without wall-clock values uses `messageid` only when every id in
  each event stream decodes and decoded timestamps are non-decreasing in the
  captured sequence.
- A missing/invalid id or any decoded backward step selects `order_only`.
  Sequence numbers and records remain usable; no timestamp is invented.
- When Craig's start and duration are available, the resolver records
  `clock_offset_s = -(recording start in milliseconds) / 1000` and emits
  `t_audio_s = (t_wall_ms - recording start) / 1000`. Events outside the
  recording window plus/minus five minutes receive `ROLL20_WINDOW_MISMATCH`;
  their values are retained without clamping.

The archive evidence consequently does not justify treating message ids as a
single-session wall clock. `order_only` is the honest basis for that capture,
while clean monotonic captures can still use the recovered message-id clock.
