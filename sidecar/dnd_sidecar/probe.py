"""Cheap facts about an audio file: how long, what format, and is anyone on it.

This is the sidecar half of `P1-03`. Node reads WAV itself, but Craig ships
FLAC and AAC, and decoding those means ffmpeg — which lives here.

Two things are deliberately separated:

* :func:`speech_ratio` is pure arithmetic over samples and is unit-tested on a
  machine with no ffmpeg at all;
* :func:`probe_file` is the glue that shells out to ffprobe/ffmpeg and never
  raises — a missing tool has to be *reported*, because intake still wants the
  tracks it could measure.

The energy algorithm mirrors ``packages/core/src/intake/craig/speech.ts`` frame
for frame. The two implementations must agree: the same session probed with and
without a sidecar running would otherwise report different participants as
silent, and the constants below are the contract between them.
"""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import struct
import subprocess
import wave
from typing import Any

log = logging.getLogger(__name__)

#: 20 ms, non-overlapping.
FRAME_MS = 20

#: How far above the measured noise floor a frame must sit to count as speech.
SPEECH_MARGIN_DB = 12.0

#: Nothing quieter than this is speech, whatever the floor says.
ABSOLUTE_FLOOR_DB = -55.0

#: Anything this loud is speech, whatever the floor says. Without a ceiling the
#: adaptive floor rises with the signal and a track that is *entirely* speech
#: measures as 0 — reporting a continuously speaking participant as silent.
SPEECH_CEILING_DB = -35.0

#: Sample rate the ratio is measured at. Speech energy needs no more.
ANALYSIS_RATE = 8000

_EPSILON = 1e-10

#: A four-hour FLAC decodes to gigabytes; energy is accumulated per chunk.
_CHUNK_SAMPLES = 1 << 16

_FFMPEG_TIMEOUT_S = 300


def _percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, max(0, int(fraction * len(sorted_values))))
    return sorted_values[index]


def frame_decibels(samples: list[float], sample_rate: int) -> list[float]:
    """RMS of each whole frame, in dBFS."""
    frame_length = max(1, round(FRAME_MS / 1000 * sample_rate))
    frame_count = len(samples) // frame_length
    out: list[float] = []
    for frame in range(frame_count):
        start = frame * frame_length
        total = 0.0
        for value in samples[start : start + frame_length]:
            total += value * value
        rms = math.sqrt(total / frame_length)
        out.append(20 * math.log10(max(rms, _EPSILON)))
    return out


def ratio_from_decibels(decibels: list[float]) -> float:
    """Fraction of frames above an adaptive floor.

    The floor is the 10th percentile rather than the mean: on a Craig track the
    great majority of frames are silence, so the mean is dragged down by the
    very frames it is meant to characterise.
    """
    if not decibels:
        return 0.0
    floor = _percentile(sorted(decibels), 0.1)
    threshold = min(max(floor + SPEECH_MARGIN_DB, ABSOLUTE_FLOOR_DB), SPEECH_CEILING_DB)
    above = sum(1 for value in decibels if value > threshold)
    return round(above / len(decibels), 4)


def speech_ratio(samples: list[float], sample_rate: int) -> float:
    """Mono samples in -1..1 to a 0..1 speech ratio, rounded like the Node side."""
    return ratio_from_decibels(frame_decibels(samples, sample_rate))


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def parse_ffprobe(payload: dict[str, Any]) -> dict[str, Any]:
    """Pulls the audio stream's facts out of ffprobe's JSON.

    Split out from the subprocess call so the parsing — which is where the
    surprises live, such as a container that reports a duration only on the
    format and not on the stream — is testable without ffmpeg installed.
    """
    streams = payload.get("streams") or []
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = payload.get("format") or {}

    duration: float | None = None
    for source in (audio or {}, fmt):
        raw = source.get("duration")
        if raw is None:
            continue
        try:
            duration = float(raw)
            break
        except (TypeError, ValueError):
            continue

    def _int(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return {
        "duration_s": duration,
        "sample_rate": _int((audio or {}).get("sample_rate")),
        "channels": _int((audio or {}).get("channels")),
        "codec": (audio or {}).get("codec_name"),
    }


def _run_ffprobe(path: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ],
        capture_output=True,
        text=True,
        timeout=_FFMPEG_TIMEOUT_S,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "ffprobe failed").strip()[:300])
    return parse_ffprobe(json.loads(result.stdout))


def _wave_facts(path: str) -> dict[str, Any] | None:
    """Reads a WAV with the standard library, so a machine without ffmpeg can
    still probe the synthetic fixtures."""
    try:
        with wave.open(path, "rb") as handle:
            rate = handle.getframerate()
            frames = handle.getnframes()
            width = handle.getsampwidth()
            return {
                "duration_s": frames / rate if rate else None,
                "sample_rate": rate,
                "channels": handle.getnchannels(),
                "codec": "pcm_u8" if width == 1 else f"pcm_s{width * 8}le",
            }
    except Exception as error:  # noqa: BLE001 - a non-WAV here is expected
        log.debug("not readable as wav: %s: %s", type(error).__name__, error)
        return None


def _decode_ratio_via_ffmpeg(path: str) -> float:
    """Streams the file through ffmpeg as mono f32 and measures as it goes."""
    process = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            path,
            "-ac",
            "1",
            "-ar",
            str(ANALYSIS_RATE),
            "-f",
            "f32le",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    frame_length = max(1, round(FRAME_MS / 1000 * ANALYSIS_RATE))
    decibels: list[float] = []
    pending: list[float] = []

    assert process.stdout is not None
    try:
        while True:
            chunk = process.stdout.read(_CHUNK_SAMPLES * 4)
            if not chunk:
                break
            usable = len(chunk) - (len(chunk) % 4)
            pending.extend(struct.unpack(f"<{usable // 4}f", chunk[:usable]))
            whole = len(pending) // frame_length * frame_length
            if whole:
                decibels.extend(frame_decibels(pending[:whole], ANALYSIS_RATE))
                del pending[:whole]
    finally:
        process.stdout.close()
        process.wait(timeout=_FFMPEG_TIMEOUT_S)

    if process.returncode not in (0, None):
        raise RuntimeError((process.stderr.read().decode(errors="replace") or "").strip()[:300])
    return ratio_from_decibels(decibels)


def _wave_ratio(path: str) -> float | None:
    """The no-ffmpeg path for WAV. Only 8/16/32-bit PCM, which is all the
    fixture generator emits."""
    try:
        with wave.open(path, "rb") as handle:
            width = handle.getsampwidth()
            channels = handle.getnchannels()
            rate = handle.getframerate()
            if width not in (1, 2, 4) or rate <= 0:
                return None

            scale = {1: 128.0, 2: 32768.0, 4: 2147483648.0}[width]
            fmt = {1: "b", 2: "h", 4: "i"}[width]
            frame_length = max(1, round(FRAME_MS / 1000 * rate))
            decibels: list[float] = []
            pending: list[float] = []

            while True:
                raw = handle.readframes(_CHUNK_SAMPLES)
                if not raw:
                    break
                count = len(raw) // width
                values = struct.unpack(f"<{count}{fmt}", raw[: count * width])
                if width == 1:
                    # 8-bit WAV is unsigned with 128 as its zero point, and the
                    # struct read above already treated it as signed.
                    values = tuple(v if v >= 0 else v + 256 for v in values)
                    values = tuple(v - 128 for v in values)
                if channels == 1:
                    pending.extend(v / scale for v in values)
                else:
                    for i in range(0, len(values) - channels + 1, channels):
                        pending.append(sum(values[i : i + channels]) / channels / scale)

                whole = len(pending) // frame_length * frame_length
                if whole:
                    decibels.extend(frame_decibels(pending[:whole], rate))
                    del pending[:whole]

            return ratio_from_decibels(decibels)
    except Exception as error:  # noqa: BLE001 - reported, never fatal
        log.debug("wav ratio failed: %s: %s", type(error).__name__, error)
        return None


def probe_file(path: str, *, media: bool = True) -> dict[str, Any]:
    """Everything intake needs about one track. Never raises."""
    result: dict[str, Any] = {"path": path, "exists": False}

    try:
        result["size_bytes"] = os.stat(path).st_size
        result["exists"] = True
    except OSError as error:
        result["error"] = str(error)
        return result

    if not media:
        return result

    errors: list[str] = []

    facts: dict[str, Any] | None = None
    if ffprobe_available():
        try:
            facts = _run_ffprobe(path)
        except Exception as error:  # noqa: BLE001 - a bad file is data, not a crash
            errors.append(f"ffprobe: {type(error).__name__}: {error}")
    # A WAV needs no external tool, so the fallback is tried whenever ffprobe
    # is missing *or* declined the file.
    if facts is None or facts.get("duration_s") is None:
        facts = _wave_facts(path) or facts
    if facts is None:
        errors.append("no ffprobe on PATH and the file is not a readable WAV")
        facts = {"duration_s": None, "sample_rate": None, "channels": None, "codec": None}

    result.update(facts)

    ratio = _wave_ratio(path)
    if ratio is None and ffmpeg_available():
        try:
            ratio = _decode_ratio_via_ffmpeg(path)
        except Exception as error:  # noqa: BLE001
            errors.append(f"ffmpeg: {type(error).__name__}: {error}")
    if ratio is None and not ffmpeg_available():
        errors.append("no ffmpeg on PATH, so speech_ratio could not be measured")

    result["speech_ratio"] = ratio
    if errors:
        result["error"] = "; ".join(errors)
    return result
