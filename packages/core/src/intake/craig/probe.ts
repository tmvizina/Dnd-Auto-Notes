import { SidecarError } from "../../sidecar/errors.js";
import { speechRatio } from "./speech.js";
import { readWavFormat, readWavMono, wavCodec, wavDurationSeconds } from "./wav.js";

/**
 * Measuring a track means decoding it, and decoding anything but WAV means
 * ffmpeg — which lives in the sidecar. So probing is an interface with two
 * implementations rather than one call:
 *
 * - `wavProber` reads a WAV with no external tool at all, which is what lets
 *   the fixture-driven intake test measure real durations and real energy on a
 *   machine with no ffmpeg and no sidecar process;
 * - `sidecarProber` posts to `/probe` and gets ffprobe's answer for the formats
 *   Craig actually emits.
 *
 * `createProber` chains them, so a session of FLAC and a session of fixture WAV
 * both work through one code path.
 */

export interface TrackProbe {
  readonly duration_s: number;
  readonly sample_rate: number;
  readonly channels: number;
  readonly codec?: string;
  readonly speech_ratio: number;
}

export interface TrackProber {
  probe(path: string): Promise<TrackProbe>;
}

export class ProbeError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

export function wavProber(): TrackProber {
  return {
    async probe(path: string): Promise<TrackProbe> {
      const format = await readWavFormat(path);
      const samples = await readWavMono(path, format);
      return {
        duration_s: Number(wavDurationSeconds(format).toFixed(6)),
        sample_rate: format.sampleRate,
        channels: format.channels,
        codec: wavCodec(format),
        speech_ratio: speechRatio(samples, format.sampleRate),
      };
    },
  };
}

interface ProbeResponseFile {
  path: string;
  exists: boolean;
  error?: string | null;
  duration_s?: number | null;
  sample_rate?: number | null;
  channels?: number | null;
  codec?: string | null;
  speech_ratio?: number | null;
}

export interface SidecarProberOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * `/probe` is synchronous rather than a job: it loads no model, and making the
 * caller poll for a file's duration would be all latency and no benefit.
 */
export function sidecarProber(options: SidecarProberOptions): TrackProber {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async probe(path: string): Promise<TrackProbe> {
      let response: Response;
      try {
        response = await fetchImpl(`${options.baseUrl}/probe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: [path], media: true }),
        });
      } catch (error) {
        throw new SidecarError(
          "http",
          `sidecar unreachable at ${options.baseUrl}/probe: ${(error as Error).message}`,
        );
      }
      if (!response.ok) {
        throw new SidecarError("http", `/probe returned ${String(response.status)}`);
      }

      const body = (await response.json()) as { files?: ProbeResponseFile[] };
      const file = body.files?.[0];
      if (file === undefined) throw new ProbeError("sidecar returned no result", path);
      if (!file.exists) throw new ProbeError(file.error ?? "file does not exist", path);
      if (file.duration_s === null || file.duration_s === undefined) {
        throw new ProbeError(
          file.error ?? "sidecar could not read the media; is ffprobe on PATH?",
          path,
        );
      }

      return {
        duration_s: file.duration_s,
        sample_rate: file.sample_rate ?? 0,
        channels: file.channels ?? 1,
        ...(file.codec === null || file.codec === undefined ? {} : { codec: file.codec }),
        speech_ratio: file.speech_ratio ?? 0,
      };
    },
  };
}

function isWav(path: string): boolean {
  return path.toLowerCase().endsWith(".wav");
}

export interface CreateProberOptions {
  /** Base URL of a running sidecar. Without it, only WAV can be probed. */
  readonly sidecarUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * WAV is read in-process; everything else goes to the sidecar. A WAV that this
 * cannot parse — an exotic bit depth, a compressed RIFF — also falls through
 * rather than failing the whole intake.
 */
export function createProber(options: CreateProberOptions = {}): TrackProber {
  const local = wavProber();
  const remote =
    options.sidecarUrl === undefined
      ? null
      : sidecarProber({
          baseUrl: options.sidecarUrl,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });

  return {
    async probe(path: string): Promise<TrackProbe> {
      if (isWav(path)) {
        try {
          return await local.probe(path);
        } catch (error) {
          if (remote === null) throw error;
        }
      }
      if (remote === null) {
        throw new ProbeError("no sidecar configured, and only WAV can be probed without one", path);
      }
      return remote.probe(path);
    },
  };
}
