"""Voice activity detection for one Craig track.

The stage deliberately has two layers.  The pure energy path operates on
frame RMS values and needs only numpy; the optional Silero path is imported
inside the call that uses it.  That keeps a newly installed sidecar useful on
a bare machine, while leaving one stable result shape for either backend.

Craig transmission is already silence-gated by Discord.  The fallback uses a
low percentile of the complete track as its noise estimate, but caps how far
that estimate may rise and recognises a quiet, continuously voiced track.  A
long quiet gap therefore cannot make the next quiet sentence disappear.
"""

from __future__ import annotations

import hashlib
import importlib.util
import math
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Iterator, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TypeAlias

import numpy as np  # type: ignore

ANALYSIS_SAMPLE_RATE = 16_000
FRAME_MS = 20
DEFAULT_MIN_SPEECH_S = 0.30
DEFAULT_MIN_SILENCE_S = 0.40
DEFAULT_PAD_S = 0.15
DEFAULT_MAX_SEGMENT_S = 30.0

# These values intentionally mirror the conservative Craig probe.  Discord's
# gate makes a very low floor appropriate, even after a long pause.
NOISE_FLOOR_PERCENTILE = 10.0
SPEECH_MARGIN_DB = 12.0
ABSOLUTE_FLOOR_DB = -55.0
SPEECH_CEILING_DB = -35.0
MAX_ADAPTIVE_FLOOR_DB = -60.0
_EPSILON = 1e-10
_BLOCK_FRAMES = 1 << 16
_FFMPEG_TIMEOUT_S = 600

ProgressFn: TypeAlias = Callable[[float, str], None]


@dataclass(frozen=True)
class VADParams:
    """Validated shaping and backend options for one VAD pass."""

    min_speech_s: float = DEFAULT_MIN_SPEECH_S
    min_silence_s: float = DEFAULT_MIN_SILENCE_S
    pad_s: float = DEFAULT_PAD_S
    max_segment_s: float = DEFAULT_MAX_SEGMENT_S
    # ``auto`` tries Silero only when its package is installed.  ``energy``
    # makes an offline run explicit; ``silero`` still falls back if loading it
    # fails, because a partially installed optional model must not break intake.
    backend: str = "auto"
    split_overlap_s: float | None = None
    frame_ms: int = FRAME_MS
    speech_margin_db: float = SPEECH_MARGIN_DB
    absolute_floor_db: float = ABSOLUTE_FLOOR_DB
    speech_ceiling_db: float = SPEECH_CEILING_DB

    def __post_init__(self) -> None:
        positive = {
            "min_speech_s": self.min_speech_s,
            "min_silence_s": self.min_silence_s,
            "max_segment_s": self.max_segment_s,
            "frame_ms": self.frame_ms,
        }
        for name, value in positive.items():
            if float(value) <= 0:
                raise ValueError(f"{name} must be greater than zero")
        if self.pad_s < 0:
            raise ValueError("pad_s must not be negative")
        if self.split_overlap_s is not None and self.split_overlap_s < 0:
            raise ValueError("split_overlap_s must not be negative")
        if self.min_speech_s > self.max_segment_s:
            raise ValueError("min_speech_s cannot exceed max_segment_s")
        backend = self.backend.lower()
        if backend not in {"auto", "energy", "silero"}:
            raise ValueError("backend must be one of: auto, energy, silero")
        object.__setattr__(self, "backend", backend)
        object.__setattr__(self, "frame_ms", int(self.frame_ms))

    @property
    def overlap_s(self) -> float:
        """Overlap used when a shaped segment must be hard-split."""
        requested = self.split_overlap_s
        if requested is None:
            requested = self.pad_s
        # At least one sample of overlap is useful, but a window must always
        # remain longer than twice its overlap or the split loop can stall.
        return min(max(float(requested), 1.0 / ANALYSIS_SAMPLE_RATE), self.max_segment_s / 4.0)


ParamsInput: TypeAlias = Mapping[str, object] | VADParams | None

_VAD_PARAMETER_NAMES: tuple[str, ...] = (
    "min_speech_s",
    "min_silence_s",
    "pad_s",
    "max_segment_s",
    "backend",
    "split_overlap_s",
    "overlap_s",
    "frame_ms",
    "speech_margin_db",
    "absolute_floor_db",
    "threshold_db",
    "speech_ceiling_db",
)


@dataclass(frozen=True)
class SpeechSegment:
    """One track-absolute speech window returned by the stage."""

    start_s: float
    end_s: float
    mean_rms: float

    def as_dict(self) -> dict[str, float]:
        return {
            "start_s": round(float(self.start_s), 3),
            "end_s": round(float(self.end_s), 3),
            "mean_rms": round(float(self.mean_rms), 6),
        }


def _coerce_float(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a number") from error
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _params(value: ParamsInput) -> VADParams:
    if value is None:
        return VADParams()
    if isinstance(value, VADParams):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("params must be an object")

    unknown = sorted(
        str(key) for key in value if str(key) not in _VAD_PARAMETER_NAMES
    )
    if unknown:
        raise ValueError(f"unknown VAD parameter: {unknown[0]}")

    data: dict[str, object] = {}
    for name in _VAD_PARAMETER_NAMES:
        if name not in value:
            continue
        raw = value[name]
        if name == "backend":
            if not isinstance(raw, str):
                raise ValueError("backend must be a string")
            data[name] = raw
        elif name in ("split_overlap_s", "overlap_s", "threshold_db"):
            # Alias fields are resolved below, after both sides have been
            # parsed, so dictionary insertion order cannot change the result.
            continue
        elif name == "frame_ms":
            frame = _coerce_float(raw, name)
            if not frame.is_integer():
                raise ValueError("frame_ms must be an integer")
            data[name] = int(frame)
        else:
            data[name] = _coerce_float(raw, name)

    if "split_overlap_s" in value and "overlap_s" in value:
        split_overlap = _coerce_float(value["split_overlap_s"], "split_overlap_s")
        overlap = _coerce_float(value["overlap_s"], "overlap_s")
        if split_overlap != overlap:
            raise ValueError("split_overlap_s and overlap_s conflict")
        data["split_overlap_s"] = split_overlap
    elif "split_overlap_s" in value:
        data["split_overlap_s"] = _coerce_float(value["split_overlap_s"], "split_overlap_s")
    elif "overlap_s" in value:
        data["split_overlap_s"] = _coerce_float(value["overlap_s"], "overlap_s")

    if "absolute_floor_db" in value and "threshold_db" in value:
        absolute_floor = _coerce_float(value["absolute_floor_db"], "absolute_floor_db")
        threshold = _coerce_float(value["threshold_db"], "threshold_db")
        if absolute_floor != threshold:
            raise ValueError("absolute_floor_db and threshold_db conflict")
        data["absolute_floor_db"] = absolute_floor
    elif "absolute_floor_db" in value:
        data["absolute_floor_db"] = _coerce_float(
            value["absolute_floor_db"], "absolute_floor_db"
        )
    elif "threshold_db" in value:
        # A threshold is a convenience alias used by a few clients.  It is
        # represented as the absolute floor so the deterministic energy
        # calculation still has one parameter object.
        data["absolute_floor_db"] = _coerce_float(value["threshold_db"], "threshold_db")
    return VADParams(**data)  # type: ignore[arg-type]


def silero_available() -> bool:
    """Return whether the optional Silero package can be imported."""
    try:
        return importlib.util.find_spec("silero_vad") is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _iter_resampled(
    source: object,
    sample_rate: int,
    *,
    target_rate: int,
) -> Iterator[np.ndarray]:
    """Stream downmixed samples through a deterministic linear resampler."""
    # ``source`` exposes ``read(frames, dtype, always_2d)``.  Keeping this
    # protocol dynamic avoids importing soundfile at module import time.
    ratio = sample_rate / float(target_rate)
    buffer = np.empty(0, dtype=np.float32)
    buffer_start = 0
    next_output = 0
    total_input = 0

    def available(last_input: int) -> int:
        if last_input <= 1:
            return next_output - 1
        return math.floor(((last_input - 1) - 1e-9) / ratio)

    def produce(last_input: int, *, final: bool) -> np.ndarray:
        nonlocal buffer, buffer_start, next_output
        total_output = round(total_input * target_rate / sample_rate)
        last = total_output - 1 if final else available(last_input)
        if last < next_output:
            return np.empty(0, dtype=np.float32)
        indices = np.arange(next_output, last + 1, dtype=np.int64)
        positions = indices.astype(np.float64) * ratio
        base = np.floor(positions).astype(np.int64)
        fraction = positions - base
        local = base - buffer_start
        local_next = np.minimum(local + 1, len(buffer) - 1)
        values = buffer[local] * (1.0 - fraction) + buffer[local_next] * fraction
        next_output = last + 1
        drop = max(0, math.floor(next_output * ratio) - buffer_start)
        if drop > 0 and drop < len(buffer):
            buffer = buffer[drop:]
            buffer_start += drop
        return np.asarray(values, dtype=np.float32)

    while True:
        chunk = source.read(_BLOCK_FRAMES, dtype="float32", always_2d=True)  # type: ignore[attr-defined]
        if len(chunk) == 0:
            break
        mono = np.asarray(chunk, dtype=np.float32).mean(axis=1)
        buffer = np.concatenate((buffer, mono))
        total_input += len(mono)
        end = buffer_start + len(buffer)
        output = produce(end, final=False)
        if len(output):
            yield output
    if total_input:
        output = produce(buffer_start + len(buffer), final=True)
        if len(output):
            yield output


def _decode_to_temp(source_path: Path, temp_path: Path) -> tuple[int, float]:
    """Write a 16 kHz mono analysis WAV without touching ``source_path``."""
    try:
        import soundfile as sf  # type: ignore

        with sf.SoundFile(str(source_path), mode="r") as source:
            input_rate = int(source.samplerate)
            input_frames = int(source.frames)
            if input_rate <= 0 or input_frames < 0:
                raise ValueError("audio has no usable sample rate")
            with sf.SoundFile(
                str(temp_path),
                mode="w",
                samplerate=ANALYSIS_SAMPLE_RATE,
                channels=1,
                format="WAV",
                subtype="PCM_16",
            ) as output:
                if input_rate == ANALYSIS_SAMPLE_RATE:
                    while True:
                        chunk = source.read(_BLOCK_FRAMES, dtype="float32", always_2d=True)
                        if len(chunk) == 0:
                            break
                        output.write(np.asarray(chunk, dtype=np.float32).mean(axis=1))
                else:
                    for chunk in _iter_resampled(
                        source, input_rate, target_rate=ANALYSIS_SAMPLE_RATE
                    ):
                        output.write(np.asarray(chunk, dtype=np.float32))
            duration = input_frames / float(input_rate)
        return ANALYSIS_SAMPLE_RATE, duration
    except Exception as soundfile_error:
        if shutil.which("ffmpeg") is None:
            raise RuntimeError(
                f"could not decode {source_path}: {type(soundfile_error).__name__}: "
                f"{soundfile_error}; install soundfile support or ffmpeg"
            ) from soundfile_error
        command = [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(source_path),
            "-ac",
            "1",
            "-ar",
            str(ANALYSIS_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            "-y",
            str(temp_path),
        ]
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=_FFMPEG_TIMEOUT_S,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or "ffmpeg failed").strip()[:500]
            raise RuntimeError(
                f"could not decode {source_path} with ffmpeg: {detail}"
            ) from soundfile_error
        try:
            with sf.SoundFile(str(temp_path), mode="r") as decoded:
                duration = int(decoded.frames) / float(decoded.samplerate)
        except Exception as error:
            raise RuntimeError(f"ffmpeg produced an unreadable analysis file: {error}") from error
        return ANALYSIS_SAMPLE_RATE, duration


def _frame_rms(path: Path, frame_samples: int) -> tuple[np.ndarray, float]:
    """Return one RMS value per frame and the decoded duration."""
    import soundfile as sf  # type: ignore

    values: list[np.ndarray] = []
    pending = np.empty(0, dtype=np.float32)
    duration = 0.0
    with sf.SoundFile(str(path), mode="r") as source:
        duration = int(source.frames) / float(source.samplerate)
        while True:
            chunk = source.read(_BLOCK_FRAMES, dtype="float32", always_2d=True)
            if len(chunk) == 0:
                break
            pending = np.concatenate((pending, np.asarray(chunk, dtype=np.float32).mean(axis=1)))
            whole = len(pending) // frame_samples * frame_samples
            if whole:
                frames = pending[:whole].reshape(-1, frame_samples)
                values.append(
                    np.sqrt(np.mean(np.square(frames), axis=1, dtype=np.float64)).astype(np.float64)
                )
                pending = pending[whole:]
    if len(pending):
        padded = np.pad(pending, (0, frame_samples - len(pending)))
        values.append(
            np.asarray([np.sqrt(np.mean(np.square(padded), dtype=np.float64))], dtype=np.float64)
        )
    if not values:
        return np.empty(0, dtype=np.float64), duration
    return np.concatenate(values), duration


def _adaptive_threshold_db(rms: np.ndarray, params: VADParams) -> float:
    if not len(rms):
        return params.absolute_floor_db
    decibels = 20.0 * np.log10(np.maximum(rms, _EPSILON))
    floor = float(np.percentile(decibels, NOISE_FLOOR_PERCENTILE))
    # A high room-tone estimate should not make a quiet post-gap sentence
    # disappear.  Craig's digital silence means this cap is safe in practice.
    floor = min(floor, MAX_ADAPTIVE_FLOOR_DB)
    threshold = floor + params.speech_margin_db
    return min(max(threshold, params.absolute_floor_db), params.speech_ceiling_db)


def _energy_mask(rms: np.ndarray, params: VADParams) -> tuple[np.ndarray, float]:
    if not len(rms):
        return np.zeros(0, dtype=bool), params.absolute_floor_db
    decibels = 20.0 * np.log10(np.maximum(rms, _EPSILON))
    threshold = _adaptive_threshold_db(rms, params)
    active = decibels >= threshold
    # If the complete track is quiet but continuous, percentile + margin has
    # no silence reference.  Treat a small-dynamic-range, above-floor signal as
    # voiced; true digital silence remains below the absolute floor.
    spread = float(np.percentile(decibels, 90) - np.percentile(decibels, 10))
    if spread <= 3.0 and float(np.median(decibels)) >= params.absolute_floor_db:
        active[:] = True
    return active, threshold


def _runs(mask: np.ndarray) -> list[tuple[int, int, bool]]:
    if not len(mask):
        return []
    runs: list[tuple[int, int, bool]] = []
    start = 0
    state = bool(mask[0])
    for index in range(1, len(mask)):
        current = bool(mask[index])
        if current != state:
            runs.append((start, index, state))
            start, state = index, current
    runs.append((start, len(mask), state))
    return runs


def _shape_mask(mask: np.ndarray, params: VADParams) -> np.ndarray:
    """Fill brief gaps, then reject brief isolated speech runs."""
    if not len(mask):
        return mask
    frame_s = params.frame_ms / 1000.0
    min_silence_frames = max(1, math.ceil(params.min_silence_s / frame_s - 1e-9))
    min_speech_frames = max(1, math.ceil(params.min_speech_s / frame_s - 1e-9))
    shaped = mask.copy()
    for start, end, voiced in _runs(shaped):
        if not voiced and end - start < min_silence_frames:
            shaped[start:end] = True
    for start, end, voiced in _runs(shaped):
        if voiced and end - start < min_speech_frames:
            shaped[start:end] = False
    return shaped


def _intervals_from_mask(
    mask: np.ndarray, duration: float, frame_s: float
) -> list[tuple[float, float, int, int]]:
    intervals: list[tuple[float, float, int, int]] = []
    for start, end, voiced in _runs(mask):
        if not voiced:
            continue
        intervals.append((min(duration, start * frame_s), min(duration, end * frame_s), start, end))
    return intervals


def _interval_rms(rms: np.ndarray, start: float, end: float, frame_s: float) -> float:
    if not len(rms) or end <= start:
        return 0.0
    first = max(0, math.floor(start / frame_s))
    last = min(len(rms), max(first + 1, math.ceil(end / frame_s)))
    if last <= first:
        return 0.0
    return float(np.mean(rms[first:last], dtype=np.float64))


def _interval_union_seconds(intervals: list[tuple[float, float]]) -> float:
    total = 0.0
    current_start: float | None = None
    current_end = 0.0
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if current_start is None:
            current_start, current_end = start, end
        elif start <= current_end:
            current_end = max(current_end, end)
        else:
            total += current_end - current_start
            current_start, current_end = start, end
    if current_start is not None:
        total += current_end - current_start
    return total


def _shape_intervals(
    intervals: list[tuple[float, float]],
    *,
    duration: float,
    params: VADParams,
    rms: np.ndarray,
) -> list[SpeechSegment]:
    frame_s = params.frame_ms / 1000.0
    accepted: list[tuple[float, float]] = []
    for start, end in sorted(intervals):
        if end - start + 1e-9 < params.min_speech_s:
            continue
        padded_start = max(0.0, start - params.pad_s)
        padded_end = min(duration, end + params.pad_s)
        if padded_end > padded_start:
            accepted.append((padded_start, padded_end))

    # VAD backends can return adjacent records.  Merge only touching/overlap;
    # the minimum-silence decision was already made before this point.
    merged: list[tuple[float, float]] = []
    for start, end in accepted:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    output: list[SpeechSegment] = []
    overlap = params.overlap_s
    for start, end in merged:
        cursor = start
        while cursor < end - 1e-9:
            piece_end = min(end, cursor + params.max_segment_s)
            output.append(
                SpeechSegment(
                    cursor,
                    piece_end,
                    _interval_rms(rms, cursor, piece_end, frame_s),
                )
            )
            if piece_end >= end:
                break
            next_cursor = piece_end - overlap
            # Defensive guard for custom floating point values; the validated
            # overlap is below the max window, so this is normally unnecessary.
            cursor = max(cursor + 1.0 / ANALYSIS_SAMPLE_RATE, next_cursor)
    return output


def _silero_intervals(samples_path: Path, params: VADParams) -> list[tuple[float, float]]:
    """Run Silero lazily and return seconds relative to the track start."""
    import soundfile as sf  # type: ignore
    from silero_vad import get_speech_timestamps, load_silero_vad  # type: ignore

    with sf.SoundFile(str(samples_path), mode="r") as source:
        samples = np.asarray(source.read(dtype="float32", always_2d=True), dtype=np.float32).mean(
            axis=1
        )
    if not len(samples):
        return []
    model = load_silero_vad()
    import torch  # type: ignore

    timestamps = get_speech_timestamps(
        torch.from_numpy(samples),
        model,
        sampling_rate=ANALYSIS_SAMPLE_RATE,
        min_speech_duration_ms=max(1, round(params.min_speech_s * 1000)),
        min_silence_duration_ms=max(1, round(params.min_silence_s * 1000)),
        # _shape_intervals applies the configured pad once for every backend.
        # Asking Silero to pad too would widen each boundary a second time.
        speech_pad_ms=0,
    )
    return [
        (float(item["start"]) / ANALYSIS_SAMPLE_RATE, float(item["end"]) / ANALYSIS_SAMPLE_RATE)
        for item in timestamps
        if isinstance(item, Mapping) and "start" in item and "end" in item
    ]


def analyze_track(
    track_path: str | Path,
    params: ParamsInput = None,
    progress: ProgressFn | None = None,
) -> dict[str, object]:
    """Analyze one track and return deterministic speech segments.

    The returned ``speech_seconds`` is the duration of the union of shaped
    windows (so max-split overlap is not double-counted).  ``source_sha256``
    hashes the original bytes, never the temporary analysis WAV.
    """
    path = Path(track_path)
    options = _params(params)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    source_hash = _sha256(path)
    if progress:
        progress(0.05, "hashed source")

    with tempfile.TemporaryDirectory(prefix="dnd-vad-") as temporary:
        analysis_path = Path(temporary) / "analysis-16k-mono.wav"
        _decode_to_temp(path, analysis_path)
        if progress:
            progress(0.30, "decoded 16 kHz mono analysis copy")
        frame_samples = max(1, round(ANALYSIS_SAMPLE_RATE * options.frame_ms / 1000.0))
        rms, duration = _frame_rms(analysis_path, frame_samples)
        frame_s = options.frame_ms / 1000.0
        warnings: list[str] = []

        backend = "energy"
        intervals: list[tuple[float, float]]
        if options.backend in {"auto", "silero"} and silero_available():
            try:
                intervals = _silero_intervals(analysis_path, options)
                backend = "silero"
            except Exception as error:  # noqa: BLE001 - fallback is intentional
                warnings.append(f"silero unavailable at runtime: {type(error).__name__}: {error}")
                intervals = []
        else:
            intervals = []
        if backend != "silero":
            active, threshold = _energy_mask(rms, options)
            shaped_mask = _shape_mask(active, options)
            intervals = [
                (start, end)
                for start, end, _first, _last in _intervals_from_mask(
                    shaped_mask, duration, frame_s
                )
            ]
            backend = "energy"
            threshold_db = round(threshold, 3)
        else:
            threshold_db = None
        segments = _shape_intervals(intervals, duration=duration, params=options, rms=rms)
        segment_dicts = [segment.as_dict() for segment in segments]
        speech_seconds = _interval_union_seconds(
            [(segment.start_s, segment.end_s) for segment in segments]
        )
        if progress:
            progress(0.90, f"segmented with {backend}")

    result: dict[str, object] = {
        "track_path": str(path),
        "source_sha256": source_hash,
        # ``sha256`` matches the intake manifest field; the explicit name
        # above keeps the provenance clear when this result is logged alone.
        "sha256": source_hash,
        "duration_s": round(duration, 3),
        "analysis_sample_rate": ANALYSIS_SAMPLE_RATE,
        "backend": backend,
        "segments": segment_dicts,
        "speech_ratio": round(speech_seconds / duration, 4) if duration else 0.0,
        "speech_seconds": round(speech_seconds, 3),
        "params": asdict(options),
    }
    if threshold_db is not None:
        result["threshold_db"] = threshold_db
    if warnings:
        result["warnings"] = warnings
    if progress:
        progress(1.0, "done")
    return result


def run_vad(
    track_path: str | Path,
    params: ParamsInput = None,
    progress: ProgressFn | None = None,
) -> dict[str, object]:
    """Job-friendly alias used by the FastAPI ``POST /vad`` handler."""
    return analyze_track(track_path, params, progress)


__all__ = [
    "ABSOLUTE_FLOOR_DB",
    "ANALYSIS_SAMPLE_RATE",
    "DEFAULT_MAX_SEGMENT_S",
    "DEFAULT_MIN_SILENCE_S",
    "DEFAULT_MIN_SPEECH_S",
    "DEFAULT_PAD_S",
    "FRAME_MS",
    "SPEECH_CEILING_DB",
    "SPEECH_MARGIN_DB",
    "SpeechSegment",
    "VADParams",
    "analyze_track",
    "run_vad",
    "silero_available",
]
