// WAV synthesis with no external tools. ffmpeg is not assumed to exist: the
// fixture has to be generatable on a bare machine, including CI.

/** Deterministic PRNG — the fixture must be byte-identical across runs. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A voiced burst: a fundamental plus two harmonics, amplitude-enveloped so the
 * edges are not clicks. Each speaker gets a distinct fundamental, which gives
 * VAD real boundaries to find and embeddings something to separate.
 */
function burst(samples, sampleRate, startS, endS, fundamental, rng) {
  const from = Math.round(startS * sampleRate);
  const to = Math.min(Math.round(endS * sampleRate), samples.length);
  const length = to - from;
  if (length <= 0) return;

  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    // Cosine ramp over 30 ms at each edge.
    const ramp = Math.round(0.03 * sampleRate);
    const head = Math.min(1, i / ramp);
    const tail = Math.min(1, (length - i) / ramp);
    const envelope = Math.min(head, tail);

    // Syllable-rate wobble so the burst is not a pure tone.
    const wobble = 0.8 + 0.2 * Math.sin(2 * Math.PI * 4.5 * t);
    const value =
      Math.sin(2 * Math.PI * fundamental * t) * 0.6 +
      Math.sin(2 * Math.PI * fundamental * 2 * t) * 0.25 +
      Math.sin(2 * Math.PI * fundamental * 3 * t) * 0.1 +
      (rng() - 0.5) * 0.05;

    samples[from + i] = Math.max(-1, Math.min(1, value * envelope * wobble * 0.7));
  }
}

/**
 * Builds one track. Everything outside a scheduled burst is true digital
 * silence, because Discord gates transmission — Craig tracks really are silent
 * between utterances, and a fixture with room tone would teach the VAD the
 * wrong lesson.
 */
export function renderTrack(schedule, { seconds, sampleRate, fundamental, seed }) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  const rng = mulberry32(seed);
  for (const item of schedule) {
    burst(samples, sampleRate, item.start, item.end, fundamental, rng);
  }
  return samples;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // format: PCM
  buffer.writeUInt16LE(1, 22); // channels
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}
