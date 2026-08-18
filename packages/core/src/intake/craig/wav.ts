import { open } from "node:fs/promises";

/**
 * Just enough RIFF to measure a WAV without ffmpeg.
 *
 * The point is not to support every WAV in the world — Craig does not even emit
 * WAV. It is that the synthetic fixture is WAV, so the end-to-end intake test
 * measures real durations and real energy on a machine with no ffmpeg and no
 * sidecar running. Anything this cannot read falls through to the sidecar,
 * which has ffprobe.
 */

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavError";
  }
}

export interface WavFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  /** 1 = PCM, 3 = IEEE float. Anything else is not readable here. */
  readonly formatTag: number;
  readonly dataOffset: number;
  readonly dataBytes: number;
}

const PCM = 1;
const IEEE_FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/** Reads the header chunks only; the data chunk is left on disk. */
export async function readWavFormat(path: string): Promise<WavFormat> {
  const handle = await open(path, "r");
  try {
    // 64 KiB covers the RIFF header plus any LIST/fact chunks a tagger added
    // ahead of `data`, without reading a four-hour file into memory.
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const view = header.subarray(0, bytesRead);

    if (view.length < 12 || view.toString("ascii", 0, 4) !== "RIFF") {
      throw new WavError("not a RIFF file");
    }
    if (view.toString("ascii", 8, 12) !== "WAVE") throw new WavError("RIFF file is not WAVE");

    let offset = 12;
    let format: Omit<WavFormat, "dataOffset" | "dataBytes"> | null = null;

    while (offset + 8 <= view.length) {
      const id = view.toString("ascii", offset, offset + 4);
      const size = view.readUInt32LE(offset + 4);
      const body = offset + 8;

      if (id === "fmt " && body + 16 <= view.length) {
        const formatTag = view.readUInt16LE(body);
        format = {
          formatTag,
          channels: view.readUInt16LE(body + 2),
          sampleRate: view.readUInt32LE(body + 4),
          bitsPerSample: view.readUInt16LE(body + 14),
        };
      } else if (id === "data") {
        if (format === null) throw new WavError("data chunk precedes fmt chunk");
        // A streamed WAV can carry a placeholder size; trust the file instead.
        const actual = (await handle.stat()).size - body;
        const dataBytes = size === 0 || size === 0xffffffff ? actual : Math.min(size, actual);
        return { ...format, dataOffset: body, dataBytes };
      }

      // Chunks are word-aligned: an odd size is followed by a pad byte.
      offset = body + size + (size % 2);
    }

    throw new WavError("no data chunk found in the first 64 KiB");
  } finally {
    await handle.close();
  }
}

export function wavDurationSeconds(format: WavFormat): number {
  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  if (bytesPerFrame <= 0) throw new WavError("format declares no bytes per frame");
  return format.dataBytes / bytesPerFrame / format.sampleRate;
}

export function wavCodec(format: WavFormat): string {
  if (format.formatTag === IEEE_FLOAT) return `pcm_f${String(format.bitsPerSample)}le`;
  if (format.formatTag === PCM || format.formatTag === EXTENSIBLE) {
    return format.bitsPerSample === 8 ? "pcm_u8" : `pcm_s${String(format.bitsPerSample)}le`;
  }
  return `wav_format_${String(format.formatTag)}`;
}

function sampleAt(view: Buffer, offset: number, format: WavFormat): number {
  const { formatTag, bitsPerSample } = format;
  if (formatTag === IEEE_FLOAT) {
    return bitsPerSample === 64 ? view.readDoubleLE(offset) : view.readFloatLE(offset);
  }
  switch (bitsPerSample) {
    case 8:
      // 8-bit PCM is unsigned with 128 as the zero point.
      return (view.readUInt8(offset) - 128) / 128;
    case 16:
      return view.readInt16LE(offset) / 32768;
    case 24:
      return (
        ((view.readUInt8(offset) |
          (view.readUInt8(offset + 1) << 8) |
          (view.readInt8(offset + 2) << 16)) as number) / 8388608
      );
    case 32:
      return view.readInt32LE(offset) / 2147483648;
    default:
      throw new WavError(`unsupported bit depth ${String(bitsPerSample)}`);
  }
}

/**
 * Decodes to mono -1..1 in chunks. Channels are averaged rather than taking the
 * first: a Craig track is mono, but a hand-converted stereo file with the voice
 * only in the right channel would otherwise measure as silence.
 */
export async function readWavMono(path: string, format: WavFormat): Promise<Float32Array> {
  const bytesPerSample = format.bitsPerSample / 8;
  const bytesPerFrame = bytesPerSample * format.channels;
  const frames = Math.floor(format.dataBytes / bytesPerFrame);
  const out = new Float32Array(frames);

  const handle = await open(path, "r");
  try {
    const framesPerChunk = Math.max(1, Math.floor((1 << 20) / bytesPerFrame));
    const buffer = Buffer.alloc(framesPerChunk * bytesPerFrame);

    let frame = 0;
    let position = format.dataOffset;
    while (frame < frames) {
      const wanted = Math.min(framesPerChunk, frames - frame) * bytesPerFrame;
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      const usable = Math.floor(bytesRead / bytesPerFrame);
      for (let i = 0; i < usable; i += 1) {
        let sum = 0;
        for (let channel = 0; channel < format.channels; channel += 1) {
          sum += sampleAt(buffer, i * bytesPerFrame + channel * bytesPerSample, format);
        }
        out[frame + i] = sum / format.channels;
      }
      frame += usable;
    }
  } finally {
    await handle.close();
  }
  return out;
}
