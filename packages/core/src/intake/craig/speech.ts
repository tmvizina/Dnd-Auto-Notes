/**
 * A cheap stand-in for VAD, so intake can say "this participant was muted all
 * evening" without loading a model. It is deliberately not accurate enough to
 * segment speech — that is `P2-01`'s job. All it has to do is separate a track
 * that carries a voice from one that carries nothing.
 */

/** 20 ms, non-overlapping. Long enough to average out a zero crossing. */
export const FRAME_MS = 20;

/** How far above the measured noise floor a frame has to sit to count as speech. */
export const SPEECH_MARGIN_DB = 12;

/**
 * Nothing quieter than this is speech regardless of the floor. Without it a
 * digitally silent track measures its own dither as "12 dB above the floor"
 * and reports a speech ratio near 1.
 */
export const ABSOLUTE_FLOOR_DB = -55;

/**
 * Anything this loud is speech no matter what the floor says. Without a ceiling
 * the adaptive floor rises with the signal, so a track that is *entirely*
 * speech — a co-located mic that never gates, a music bot — has every frame
 * sitting at its own floor and measures as 0. Reporting a continuously
 * speaking participant as silent is the exact failure this metric exists to
 * prevent.
 */
export const SPEECH_CEILING_DB = -35;

/** P1-10's `TRACK_SILENT` threshold, defined here because this is what measures it. */
export const SILENT_RATIO = 0.005;

const EPSILON = 1e-10;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index] ?? 0;
}

/**
 * Fraction of frames whose RMS sits above an adaptive floor.
 *
 * The floor is the 10th percentile of frame energy rather than the mean: on a
 * Craig track the great majority of frames are silence, so the mean is dragged
 * down by exactly the frames it is meant to characterise, while a low
 * percentile lands squarely in the noise.
 *
 * `samples` is mono, -1..1. Rounded to four places so a re-run is byte-identical.
 */
export function speechRatio(samples: Float32Array, sampleRate: number): number {
  const frameLength = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const frameCount = Math.floor(samples.length / frameLength);
  if (frameCount === 0) return 0;

  const decibels: number[] = new Array<number>(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const from = frame * frameLength;
    let sum = 0;
    for (let i = from; i < from + frameLength; i += 1) {
      const value = samples[i] ?? 0;
      sum += value * value;
    }
    decibels[frame] = 20 * Math.log10(Math.max(Math.sqrt(sum / frameLength), EPSILON));
  }

  const sorted = [...decibels].sort((a, b) => a - b);
  const noiseFloor = percentile(sorted, 0.1);
  const threshold = Math.min(
    Math.max(noiseFloor + SPEECH_MARGIN_DB, ABSOLUTE_FLOOR_DB),
    SPEECH_CEILING_DB,
  );

  let above = 0;
  for (const value of decibels) if (value > threshold) above += 1;

  return Number((above / frameCount).toFixed(4));
}

export function isSilent(ratio: number): boolean {
  return ratio < SILENT_RATIO;
}
