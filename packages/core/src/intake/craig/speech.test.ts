import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_FLOOR_DB,
  isSilent,
  SILENT_RATIO,
  speechRatio,
  SPEECH_CEILING_DB,
  SPEECH_MARGIN_DB,
} from "./speech.js";

const RATE = 8000;

function tone(seconds: number, amplitude = 0.7, frequency = 196): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin(2 * Math.PI * frequency * (i / RATE));
  }
  return samples;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("speechRatio", () => {
  it("reports digital silence as exactly zero", () => {
    expect(speechRatio(new Float32Array(RATE), RATE)).toBe(0);
  });

  it("reports a continuously speaking track as one", () => {
    // Every frame sits at the same level, so the adaptive floor lands on the
    // signal itself. Only the ceiling keeps this from reading as silence —
    // and calling a non-stop speaker "absent" is the failure this metric exists
    // to catch.
    expect(speechRatio(tone(1), RATE)).toBe(1);
  });

  it("tracks the speaking fraction of a mostly-silent track", () => {
    const samples = concat(new Float32Array(4 * RATE), tone(2), new Float32Array(4 * RATE));
    expect(speechRatio(samples, RATE)).toBe(0.2);
  });

  it("does not mistake a quiet hiss for speech", () => {
    const hiss = new Float32Array(RATE);
    for (let i = 0; i < hiss.length; i += 1) hiss[i] = i % 2 === 0 ? 1e-4 : -1e-4;
    expect(20 * Math.log10(1e-4)).toBeLessThan(ABSOLUTE_FLOOR_DB);
    expect(speechRatio(hiss, RATE)).toBe(0);
  });

  it("returns zero when there is not even one whole frame", () => {
    expect(speechRatio(new Float32Array(10).fill(0.5), RATE)).toBe(0);
  });

  it("is deterministic", () => {
    const samples = concat(new Float32Array(RATE), tone(1), new Float32Array(RATE));
    expect(speechRatio(samples, RATE)).toBe(speechRatio(samples, RATE));
  });

  it("rounds to four places so a re-run is byte-identical", () => {
    const samples = concat(new Float32Array(RATE * 7), tone(0.3));
    const ratio = speechRatio(samples, RATE);
    expect(Number(ratio.toFixed(4))).toBe(ratio);
  });
});

describe("isSilent", () => {
  it("uses P1-10's half-percent threshold", () => {
    expect(SILENT_RATIO).toBe(0.005);
    expect(isSilent(0)).toBe(true);
    expect(isSilent(0.004)).toBe(true);
    expect(isSilent(0.005)).toBe(false);
    expect(isSilent(0.2)).toBe(false);
  });
});

describe("the cross-language contract", () => {
  it("declares the constants sidecar/dnd_sidecar/probe.py mirrors", () => {
    // Both implementations measure the same tracks; if these drift, the same
    // session reports different silent participants depending on whether the
    // sidecar happened to be running.
    expect(SPEECH_MARGIN_DB).toBe(12);
    expect(ABSOLUTE_FLOOR_DB).toBe(-55);
    expect(SPEECH_CEILING_DB).toBe(-35);
  });
});
