import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidecarError } from "../../sidecar/errors.js";
import { createProber, ProbeError, sidecarProber, wavProber } from "./probe.js";
import { readWavFormat, wavCodec, wavDurationSeconds, WavError } from "./wav.js";

const RATE = 8000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dnd-probe-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 16-bit PCM WAV, the shape tools/fixture-audio.mjs writes. */
function writeWav(
  name: string,
  samples: Float32Array,
  { channels = 1, rate = RATE }: { channels?: number; rate?: number } = {},
): string {
  const frames = samples.length;
  const dataBytes = frames * 2 * channels;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2 * channels, 28);
  buffer.writeUInt16LE(2 * channels, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.max(-1, Math.min(1, samples[i] ?? 0)) * 32767);
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(value, 44 + (i * channels + channel) * 2);
    }
  }
  const path = join(root, name);
  writeFileSync(path, buffer);
  return path;
}

function tone(seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = 0.7 * Math.sin(2 * Math.PI * 196 * (i / RATE));
  }
  return samples;
}

describe("wavProber", () => {
  it("measures duration, format and energy with no external tool", async () => {
    const silence = new Float32Array(5 * RATE);
    const speech = tone(5);
    const samples = new Float32Array(silence.length + speech.length);
    samples.set(silence);
    samples.set(speech, silence.length);

    const probe = await wavProber().probe(writeWav("1-ash.wav", samples));

    expect(probe.duration_s).toBe(10);
    expect(probe.sample_rate).toBe(RATE);
    expect(probe.channels).toBe(1);
    expect(probe.codec).toBe("pcm_s16le");
    expect(probe.speech_ratio).toBe(0.5);
  });

  it("reports a silent track as near zero", async () => {
    const probe = await wavProber().probe(writeWav("2-bly.wav", new Float32Array(3 * RATE)));
    expect(probe.duration_s).toBe(3);
    expect(probe.speech_ratio).toBe(0);
  });

  it("averages channels rather than taking the first", async () => {
    // A hand-converted stereo file with the voice in one channel must not be
    // reported as an absent participant.
    const probe = await wavProber().probe(writeWav("3-cyd.wav", tone(1), { channels: 2 }));
    expect(probe.channels).toBe(2);
    expect(probe.speech_ratio).toBe(1);
  });

  it("refuses a file that is not RIFF", async () => {
    const path = join(root, "notes.wav");
    writeFileSync(path, "this is not audio");
    await expect(wavProber().probe(path)).rejects.toBeInstanceOf(WavError);
  });
});

describe("readWavFormat", () => {
  it("skips chunks that sit between fmt and data", async () => {
    const samples = tone(1);
    const path = writeWav("4-wren.wav", samples);
    const original = readFileSync(path);

    // Splice a LIST chunk in ahead of `data`, which is what a tagger does.
    const list = Buffer.alloc(8 + 10);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(10, 4);
    const spliced = Buffer.concat([original.subarray(0, 36), list, original.subarray(36)]);
    const taggedPath = join(root, "4-wren-tagged.wav");
    writeFileSync(taggedPath, spliced);

    const format = await readWavFormat(taggedPath);
    expect(format.sampleRate).toBe(RATE);
    expect(wavDurationSeconds(format)).toBeCloseTo(1, 6);
    expect(wavCodec(format)).toBe("pcm_s16le");
  });
});

describe("sidecarProber", () => {
  const respond = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  it("reads ffprobe's answer out of /probe", async () => {
    const prober = sidecarProber({
      baseUrl: "http://127.0.0.1:8477",
      fetchImpl: respond({
        files: [
          {
            path: "/x/1-ash.flac",
            exists: true,
            duration_s: 14682.3,
            sample_rate: 48000,
            channels: 2,
            codec: "flac",
            speech_ratio: 0.18,
          },
        ],
      }),
    });

    expect(await prober.probe("/x/1-ash.flac")).toEqual({
      duration_s: 14682.3,
      sample_rate: 48000,
      channels: 2,
      codec: "flac",
      speech_ratio: 0.18,
    });
  });

  it("sends the path the caller asked about", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${String(url)} ${String(init.body)}`);
      return new Response(
        JSON.stringify({ files: [{ path: "x", exists: true, duration_s: 1, speech_ratio: 0 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await sidecarProber({ baseUrl: "http://host:1", fetchImpl }).probe("/x/1-ash.flac");
    expect(seen[0]).toContain("http://host:1/probe");
    expect(seen[0]).toContain("1-ash.flac");
  });

  it("surfaces a missing ffprobe as a probe error, not a silent zero", async () => {
    const prober = sidecarProber({
      baseUrl: "http://127.0.0.1:8477",
      fetchImpl: respond({
        files: [{ path: "/x/1-ash.flac", exists: true, error: "no ffprobe on PATH" }],
      }),
    });
    await expect(prober.probe("/x/1-ash.flac")).rejects.toThrow(/no ffprobe on PATH/);
  });

  it("reports an unreachable sidecar as a SidecarError", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      sidecarProber({ baseUrl: "http://127.0.0.1:1", fetchImpl }).probe("/x/a.flac"),
    ).rejects.toBeInstanceOf(SidecarError);
  });
});

describe("createProber", () => {
  it("reads WAV in process without contacting a sidecar", async () => {
    const fetchImpl = (async () => {
      throw new Error("the sidecar must not be called for a WAV");
    }) as unknown as typeof fetch;

    const probe = await createProber({ sidecarUrl: "http://127.0.0.1:8477", fetchImpl }).probe(
      writeWav("1-ash.wav", tone(2)),
    );
    expect(probe.duration_s).toBe(2);
  });

  it("sends everything else to the sidecar", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          files: [{ path: "x", exists: true, duration_s: 42, sample_rate: 48000, channels: 1 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const probe = await createProber({ sidecarUrl: "http://127.0.0.1:8477", fetchImpl }).probe(
      "/x/1-ash.flac",
    );
    expect(probe.duration_s).toBe(42);
  });

  it("falls back to the sidecar for a WAV it cannot parse", async () => {
    const path = join(root, "5-odd.wav");
    writeFileSync(path, "RIFFnot really a wave file at all");
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ files: [{ path, exists: true, duration_s: 9, speech_ratio: 0.1 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const probe = await createProber({ sidecarUrl: "http://127.0.0.1:8477", fetchImpl }).probe(
      path,
    );
    expect(probe.duration_s).toBe(9);
  });

  it("says so plainly when there is no sidecar and no way to read the file", async () => {
    await expect(createProber().probe("/x/1-ash.flac")).rejects.toBeInstanceOf(ProbeError);
  });
});
