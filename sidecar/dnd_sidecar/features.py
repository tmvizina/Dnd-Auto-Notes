"""Per-utterance speaker embeddings and deterministic prosody features.

The default installation deliberately has no model dependency.  ``fake`` mode
uses a stable digest of the fixture's player/character identity, while the real
path lazily loads SpeechBrain ECAPA only when a job actually requests it.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import TypeAlias

import numpy as np  # type: ignore

ProgressFn: TypeAlias = Callable[[float, str], None]
ParamsInput: TypeAlias = Mapping[str, object] | None

MIN_FEATURE_DURATION_S = 0.6
FAKE_EMBEDDING_DIMENSION = 16
DEFAULT_SPEECHBRAIN_SOURCE = "speechbrain/spkrec-ecapa-voxceleb"
_WORD_PATTERN = re.compile(r"\S+", re.UNICODE)
_MODEL_LOCK = threading.Lock()
_MODEL: tuple[str, object] | None = None


class FeaturesBackendUnavailableError(RuntimeError):
    """Raised when the requested real embedding backend is not installed."""


def _finite(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a number") from error
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _params(value: ParamsInput) -> dict[str, object]:
    if value is None:
        value = {}
    if not isinstance(value, Mapping):
        raise TypeError("params must be an object")
    allowed = {
        "backend",
        "model",
        "min_duration_s",
        "device",
        "sample_rate",
    }
    unknown = sorted(str(key) for key in value if str(key) not in allowed)
    if unknown:
        raise ValueError(f"unknown features parameter: {unknown[0]}")
    backend = value.get("backend", "auto")
    if not isinstance(backend, str) or backend.strip() == "":
        raise ValueError("backend must be a non-empty string")
    backend = backend.strip().lower()
    if backend not in {"auto", "fake", "speechbrain", "ecapa"}:
        raise ValueError("backend must be one of: auto, fake, speechbrain")
    model = value.get("model", DEFAULT_SPEECHBRAIN_SOURCE)
    if not isinstance(model, str) or model.strip() == "":
        raise ValueError("model must be a non-empty string")
    minimum = _finite(value.get("min_duration_s", MIN_FEATURE_DURATION_S), "min_duration_s")
    if minimum <= 0:
        raise ValueError("min_duration_s must be greater than zero")
    device = value.get("device", "auto")
    if not isinstance(device, str) or device.strip() == "":
        raise ValueError("device must be a non-empty string")
    sample_rate = _finite(value.get("sample_rate", 16_000), "sample_rate")
    if not sample_rate.is_integer() or sample_rate <= 0:
        raise ValueError("sample_rate must be a positive integer")
    return {
        "backend": backend,
        "model": model.strip(),
        "min_duration_s": minimum,
        "device": device.strip().lower(),
        "sample_rate": int(sample_rate),
    }


def _find_truth(track_path: Path) -> Path | None:
    current = track_path.resolve().parent
    for candidate in (current, *current.parents):
        truth = candidate / "truth.json"
        if truth.is_file():
            return truth
    return None


def _truth_labels(track_path: Path) -> dict[str, str]:
    path = _find_truth(track_path)
    if path is None:
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, Mapping):
        return {}
    result: dict[str, str] = {}
    utterances = raw.get("utterances", [])
    if not isinstance(utterances, Sequence) or isinstance(utterances, (str, bytes, bytearray)):
        return result
    for item in utterances:
        if not isinstance(item, Mapping):
            continue
        identifier = item.get("id")
        player = item.get("player_id", item.get("player"))
        character = item.get("character_id", item.get("character"))
        if isinstance(identifier, str) and isinstance(player, str):
            result[identifier] = f"{player}|{character if isinstance(character, str) else '__table__'}"
    return result


def _normalise_audio(path: Path) -> tuple[np.ndarray, int]:
    try:
        import soundfile as sf  # type: ignore

        samples, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception as error:
        raise RuntimeError(
            f"could not decode {path}: {type(error).__name__}: {error}; install soundfile or ffmpeg"
        ) from error
    mono = np.asarray(samples, dtype=np.float32).mean(axis=1)
    if sample_rate <= 0:
        raise ValueError(f"audio has invalid sample rate: {sample_rate}")
    return mono, int(sample_rate)


def _frames(samples: np.ndarray, sample_rate: int, frame_s: float = 0.04) -> np.ndarray:
    size = max(1, round(sample_rate * frame_s))
    count = max(1, math.ceil(len(samples) / size))
    padded = np.pad(samples, (0, max(0, count * size - len(samples))))
    return padded.reshape(count, size)


def _pitch(frame: np.ndarray, sample_rate: int) -> float:
    centered = frame - float(np.mean(frame, dtype=np.float64))
    if float(np.sqrt(np.mean(np.square(centered), dtype=np.float64))) < 1e-4:
        return 0.0
    crossings = np.count_nonzero(np.diff(np.signbit(centered)))
    frequency = crossings * sample_rate / (2.0 * len(frame))
    return frequency if 50.0 <= frequency <= 500.0 else 0.0


def _spectral_tilt(samples: np.ndarray, sample_rate: int) -> float:
    if len(samples) < 4:
        return 0.0
    spectrum = np.abs(np.fft.rfft(samples.astype(np.float64)))
    frequencies = np.fft.rfftfreq(len(samples), 1.0 / sample_rate)
    valid = (frequencies >= 50.0) & (spectrum > 1e-12)
    if np.count_nonzero(valid) < 2:
        return 0.0
    x = np.log(frequencies[valid])
    y = np.log(spectrum[valid])
    return float(np.polyfit(x, y, 1)[0])


def _prosody(samples: np.ndarray, sample_rate: int, words: Sequence[object], duration: float) -> dict[str, float]:
    frames = _frames(samples, sample_rate)
    rms = np.sqrt(np.mean(np.square(frames), axis=1, dtype=np.float64))
    pitches = np.asarray([_pitch(frame, sample_rate) for frame in frames], dtype=np.float64)
    voiced_pitch = pitches[pitches > 0]
    f0_mean = float(np.mean(voiced_pitch)) if len(voiced_pitch) else 0.0
    f0_std = float(np.std(voiced_pitch)) if len(voiced_pitch) else 0.0
    f0_range = float(np.max(voiced_pitch) - np.min(voiced_pitch)) if len(voiced_pitch) else 0.0
    word_count = 0
    for item in words:
        if not isinstance(item, Mapping):
            continue
        start = item.get("s", item.get("start"))
        end = item.get("e", item.get("end"))
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end > start:
            word_count += 1
    peak = float(np.max(rms)) if len(rms) else 0.0
    jitter_proxy = (
        float(np.mean(np.abs(np.diff(voiced_pitch))) / np.mean(voiced_pitch))
        if len(voiced_pitch) > 1 and float(np.mean(voiced_pitch)) > 0
        else 0.0
    )
    threshold = max(1e-4, peak * 0.1)
    return {
        "f0_mean": f0_mean,
        "f0_std": f0_std,
        "f0_range": f0_range,
        "rate_wps": word_count / duration if duration else 0.0,
        "intensity_mean": float(np.mean(rms, dtype=np.float64)),
        "intensity_std": float(np.std(rms, dtype=np.float64)),
        "spectral_tilt": _spectral_tilt(samples, sample_rate),
        "jitter_proxy": jitter_proxy,
        "pause_ratio": float(np.mean(rms < threshold)) if len(rms) else 1.0,
    }


def _fake_vector(identity: str, dimension: int = FAKE_EMBEDDING_DIMENSION) -> list[float]:
    values: list[float] = []
    for index in range(dimension):
        digest = hashlib.sha256(f"dnd-fake-embed-v1|{identity}|{index}".encode("utf-8")).digest()
        values.append((int.from_bytes(digest[:8], "little") / 2**64) * 2.0 - 1.0)
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values]


def _load_model(source: str, device: str) -> tuple[object, int]:
    global _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None and _MODEL[0] == f"{source}|{device}":
            model = _MODEL[1]
        else:
            try:
                from speechbrain.inference.speaker import EncoderClassifier  # type: ignore
            except Exception as error:
                raise FeaturesBackendUnavailableError(
                    "install speechbrain and torch, then retry the features job"
                ) from error
            try:
                model = EncoderClassifier.from_hparams(source=source, run_opts={"device": device})
            except Exception as error:
                raise RuntimeError(f"could not load SpeechBrain ECAPA model {source}: {error}") from error
            _MODEL = (f"{source}|{device}", model)
    dimension = int(getattr(model, "embedding_dim", 192))
    return model, dimension


def _real_embedding(model: object, samples: np.ndarray) -> list[float]:
    try:
        import torch  # type: ignore

        tensor = torch.from_numpy(samples.astype(np.float32)).unsqueeze(0)
        output = model.encode_batch(tensor)  # type: ignore[attr-defined]
        values = np.asarray(output.detach().cpu().reshape(-1), dtype=np.float32)
    except Exception as error:
        raise RuntimeError(f"SpeechBrain embedding failed: {type(error).__name__}: {error}") from error
    norm = float(np.linalg.norm(values))
    if not math.isfinite(norm) or norm <= 0:
        raise RuntimeError("SpeechBrain returned a zero or non-finite embedding")
    return [float(value / norm) for value in values]


def _real_embeddings(model: object, clips: Sequence[np.ndarray], batch_size: int = 16) -> list[list[float]]:
    """Encode bounded batches so ECAPA does not launch one GPU call per utterance."""
    try:
        import torch  # type: ignore

        result: list[list[float]] = []
        for start in range(0, len(clips), batch_size):
            batch = clips[start : start + batch_size]
            width = max(len(clip) for clip in batch)
            padded = np.zeros((len(batch), width), dtype=np.float32)
            for index, clip in enumerate(batch):
                padded[index, : len(clip)] = clip
            lengths = np.asarray([len(clip) / width for clip in batch], dtype=np.float32)
            output = model.encode_batch(  # type: ignore[attr-defined]
                torch.from_numpy(padded), torch.from_numpy(lengths)
            )
            array = np.asarray(output.detach().cpu(), dtype=np.float32)
            array = array.reshape(len(batch), -1)
            for values in array:
                norm = float(np.linalg.norm(values))
                if not math.isfinite(norm) or norm <= 0:
                    raise RuntimeError("SpeechBrain returned a zero or non-finite embedding")
                result.append([float(value / norm) for value in values])
        return result
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError(f"SpeechBrain batched embedding failed: {type(error).__name__}: {error}") from error


_PROSODY_FIELDS = (
    "f0_mean",
    "f0_std",
    "f0_range",
    "rate_wps",
    "intensity_mean",
    "intensity_std",
    "spectral_tilt",
    "jitter_proxy",
    "pause_ratio",
)


def _zscore_rows(rows: list[dict[str, object]]) -> None:
    by_player: dict[str, list[dict[str, float]]] = {}
    for row in rows:
        raw = row.get("prosody")
        player = row.get("player_id")
        if not isinstance(player, str) or not isinstance(raw, Mapping):
            continue
        if not all(isinstance(raw.get(field), (int, float)) for field in _PROSODY_FIELDS):
            continue
        by_player.setdefault(player, []).append({field: float(raw[field]) for field in _PROSODY_FIELDS})
    for row in rows:
        raw = row.get("prosody")
        player = row.get("player_id")
        if not isinstance(player, str) or not isinstance(raw, Mapping):
            continue
        baseline = by_player.get(player, [])
        if not baseline:
            continue
        z: dict[str, float] = {}
        for field in _PROSODY_FIELDS:
            values = np.asarray([item[field] for item in baseline], dtype=np.float64)
            mean = float(np.mean(values))
            std = float(np.std(values))
            z[field] = 0.0 if std <= 1e-12 else (float(raw[field]) - mean) / std
        row["prosody_z"] = z
        nested = row.get("features")
        if isinstance(nested, dict):
            nested["prosody_z"] = z


def compute_features(
    track_path: str | Path,
    utterances: Sequence[Mapping[str, object]],
    params: ParamsInput = None,
    progress: ProgressFn | None = None,
) -> dict[str, object]:
    """Compute one track's embeddings and prosody without opening the database."""
    path = Path(track_path)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    options = _params(params)
    use_fake = os.environ.get("DND_FAKE_EMBED", "") == "1" or options["backend"] == "fake"
    backend = "fake" if use_fake else options["backend"]
    if backend == "auto":
        backend = "speechbrain"
    labels = _truth_labels(path)
    samples, sample_rate = _normalise_audio(path)
    model: object | None = None
    dimension = FAKE_EMBEDDING_DIMENSION
    if backend in {"speechbrain", "ecapa"}:
        model, dimension = _load_model(str(options["model"]), str(options["device"]))
        backend = "speechbrain-ecapa"
    started = time.perf_counter()
    rows: list[dict[str, object]] = []
    pending_clips: list[np.ndarray] = []
    pending_rows: list[int] = []
    for index, item in enumerate(utterances):
        identifier = item.get("id", item.get("utterance_id"))
        if not isinstance(identifier, str) or identifier == "":
            raise ValueError(f"utterance {str(index)} has no id")
        player = item.get("player_id")
        if not isinstance(player, str) or player == "":
            raise ValueError(f"utterance {identifier} has no player_id; refusing to infer one")
        start = _finite(item.get("start_s", item.get("start")), f"{identifier}.start_s")
        end = _finite(item.get("end_s", item.get("end")), f"{identifier}.end_s")
        duration = end - start
        if start < 0 or duration <= 0:
            raise ValueError(f"utterance {identifier} has an invalid interval")
        base: dict[str, object] = {
            "utterance_id": identifier,
            "player_id": player,
            "duration_s": round(duration, 6),
        }
        if duration < float(options["min_duration_s"]):
            rows.append({**base, "embedding": None, "prosody": None, "prosody_z": None, "features": None})
        else:
            first = min(len(samples), max(0, round(start * sample_rate)))
            last = min(len(samples), max(first + 1, round(end * sample_rate)))
            clip = samples[first:last]
            raw_prosody = _prosody(clip, sample_rate, item.get("words", []), duration)
            if backend == "fake":
                character = labels.get(identifier, f"{player}|__unknown__").split("|", 1)[-1]
                embedding = _fake_vector(f"{player}|{character}")
            else:
                if model is None:
                    raise RuntimeError("features model was not loaded")
                embedding = None
                pending_clips.append(clip)
                pending_rows.append(len(rows))
            rows.append({
                **base,
                "embedding": embedding,
                "prosody": raw_prosody,
                "prosody_z": None,
                "features": {"embedding": embedding, "prosody": raw_prosody, "prosody_z": None},
            })
        if progress:
            progress((index + 1) / max(1, len(utterances)), f"features {index + 1}/{len(utterances)}")
    if pending_clips:
        if model is None:
            raise RuntimeError("features model was not loaded")
        embeddings = _real_embeddings(model, pending_clips)
        dimension = len(embeddings[0])
        for row_index, embedding in zip(pending_rows, embeddings, strict=True):
            rows[row_index]["embedding"] = embedding
            nested = rows[row_index].get("features")
            if isinstance(nested, dict):
                nested["embedding"] = embedding
    _zscore_rows(rows)
    elapsed = max(time.perf_counter() - started, 1e-9)
    return {
        "track_path": str(path),
        "backend": backend,
        "dimension": dimension,
        "rows": rows,
        "throughput_utterances_per_s": len(rows) / elapsed,
        "params": options,
    }


def run_features(
    track_path: str | Path,
    utterances: Sequence[Mapping[str, object]],
    params: ParamsInput = None,
    progress: ProgressFn | None = None,
) -> dict[str, object]:
    """Job-friendly alias used by the FastAPI endpoint."""
    return compute_features(track_path, utterances, params, progress)


def reset_for_tests() -> None:
    global _MODEL
    with _MODEL_LOCK:
        _MODEL = None


__all__ = [
    "DEFAULT_SPEECHBRAIN_SOURCE",
    "FAKE_EMBEDDING_DIMENSION",
    "FeaturesBackendUnavailableError",
    "MIN_FEATURE_DURATION_S",
    "compute_features",
    "reset_for_tests",
    "run_features",
]
