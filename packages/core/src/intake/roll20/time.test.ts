import { describe, expect, it } from "vitest";
import {
  FIREBASE_PUSH_ALPHABET,
  decodeFirebasePushTimestamp,
  resolveRoll20Time,
  resolveTimeBasis,
  wallClockToAudioSeconds,
} from "./time.js";
import { resolveTimeBasis as publicResolveTimeBasis } from "./index.js";

function pushId(timestampMs: number, suffix = "abcdefghijk"): string {
  let remainder = timestampMs;
  const prefix = Array.from({ length: 8 }, () => "-");
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    prefix[index] = FIREBASE_PUSH_ALPHABET[remainder % 64] ?? "-";
    remainder = Math.floor(remainder / 64);
  }
  return prefix.join("") + suffix;
}

const recordingStart = Date.parse("2026-08-16T23:04:11.000Z");
const recording = {
  started_at: "2026-08-16T23:04:11.000Z",
  duration_s: 60,
};

describe("Roll20 timestamp recovery", () => {
  it("exposes timestamp recovery through the Roll20 public barrel", () => {
    expect(publicResolveTimeBasis({ messages: [] })).toBe("order_only");
  });

  it("decodes Firebase push-key timestamp prefixes", () => {
    const timestamp = Date.parse("2026-08-16T23:04:13.345Z");
    const id = pushId(timestamp);
    expect(decodeFirebasePushTimestamp(id)).toBe(timestamp);
    expect(decodeFirebasePushTimestamp("not-a-push-id")).toBeNull();
  });

  it("uses live wall-clock stamps and records the Craig offset", () => {
    const capture = {
      mode: "live",
      messages: [
        { id: "not-a-push-id", seq: 1, t_wall_ms: recordingStart + 1_250 },
        { id: "also-not-a-push-id", seq: 2, t_wall_ms: recordingStart + 8_000 },
      ],
    };

    expect(resolveTimeBasis(capture)).toBe("wallclock");
    const result = resolveRoll20Time(capture, recording);
    expect(result.basis).toBe("wallclock");
    expect(result.time_basis).toBe("wallclock");
    expect(result.clock_offset_s).toBe(-recordingStart / 1000);
    expect(result.messages.map((message) => message.t_wall_ms)).toEqual([
      recordingStart + 1_250,
      recordingStart + 8_000,
    ]);
    expect(result.messages.map((message) => message.t_audio_s)).toEqual([1.25, 8]);
    expect(result.qa).toEqual([]);
    expect(wallClockToAudioSeconds(recordingStart + 2_500, recordingStart)).toBe(2.5);
  });

  it("recovers monotonic message-id timestamps for a post-hoc capture", () => {
    const capture = {
      mode: "post-hoc",
      messages: [
        { id: pushId(recordingStart + 2_500), seq: 10, text: "first" },
        { id: pushId(recordingStart + 8_000), seq: 11, text: "second" },
      ],
      turnorder_events: [{ id: pushId(recordingStart + 12_000), seq: 1, entries: [] }],
    };

    expect(resolveTimeBasis(capture)).toBe("messageid");
    const result = resolveRoll20Time(capture, recording);
    expect(result.basis).toBe("messageid");
    expect(result.messages.map((message) => message.t_wall_ms)).toEqual([
      recordingStart + 2_500,
      recordingStart + 8_000,
    ]);
    expect(result.messages.map((message) => message.t_audio_s)).toEqual([2.5, 8]);
    expect(result.turnorder_events[0]).toMatchObject({
      seq: 1,
      t_wall_ms: recordingStart + 12_000,
      t_audio_s: 12,
    });
  });

  it("downgrades a decoded backward step instead of emitting garbage times", () => {
    const capture = {
      messages: [
        { id: pushId(recordingStart + 10_000), seq: 1 },
        { id: pushId(recordingStart + 6_810), seq: 2 },
      ],
    };

    expect(resolveTimeBasis(capture)).toBe("order_only");
    const result = resolveRoll20Time(capture, recording);
    expect(result.basis).toBe("order_only");
    expect(result.messages.map((message) => message.t_wall_ms)).toEqual([null, null]);
    expect(result.messages.map((message) => message.t_audio_s)).toEqual([null, null]);
    expect(result.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(result.qa).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TIME_BASIS_ORDER_ONLY", severity: "info" }),
        expect.objectContaining({ code: "ROLL20_MESSAGEID_NON_MONOTONIC", severity: "warning" }),
      ]),
    );
  });

  it("keeps order-only captures usable when ids carry no decodable time", () => {
    const capture = {
      messages: [
        { id: "anonymous-a", seq: 7, text: "first" },
        { seq: 8, text: "second" },
      ],
    };

    const result = resolveRoll20Time(capture, recording);
    expect(result.basis).toBe("order_only");
    expect(result.messages.map((message) => message.seq)).toEqual([7, 8]);
    expect(result.messages.every((message) => message.t_wall_ms === null)).toBe(true);
    expect(result.messages.every((message) => message.t_audio_s === null)).toBe(true);
    expect(result.clock_offset_s).toBe(-recordingStart / 1000);
  });

  it("warns about events outside the recording window without clamping them", () => {
    const before = recordingStart - 5 * 60 * 1000 - 1_000;
    const after = recordingStart + 60 * 1000 + 5 * 60 * 1000 + 1_000;
    const capture = {
      messages: [
        { id: pushId(before), seq: 1 },
        { id: pushId(recordingStart + 5_000), seq: 2 },
        { id: pushId(after), seq: 3 },
      ],
    };

    const result = resolveRoll20Time(capture, recording);
    expect(result.basis).toBe("messageid");
    expect(result.messages[0]?.t_audio_s).toBe(-301);
    expect(result.messages[2]?.t_audio_s).toBe(361);
    expect(result.messages[0]?.t_wall_ms).toBe(before);
    expect(result.messages[2]?.t_wall_ms).toBe(after);
    expect(result.qa.filter((entry) => entry.code === "ROLL20_WINDOW_MISMATCH")).toHaveLength(2);
  });
});
