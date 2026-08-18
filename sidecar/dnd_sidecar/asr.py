"""Deterministic, word-timestamped transcription for VAD segments.

The module keeps model imports behind the job boundary.  A bare sidecar can
therefore answer health checks and run the fixture backend without pulling a
large model into memory.  Real backends all return the same small intermediate
shape, which is normalized here into the track-absolute transcript contract.
"""

from __future__ import annotations

import atexit
import importlib
import json
import logging
import math
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol, TypeAlias

from . import capabilities

log = logging.getLogger(__name__)

ProgressFn: TypeAlias = Callable[[float, str], None]
ParamsInput: TypeAlias = Mapping[str, object] | None

DEFAULT_MODEL = "large-v3"
DEFAULT_BEAM_SIZE = 5
DEFAULT_LANGUAGE = "en"
DEFAULT_PROMPT_MAX_CHARS = 1_000
DEFAULT_TIMEOUT_S = 1_800
_EPSILON = 1e-9
_WORD_PATTERN = re.compile(r"\S+", re.UNICODE)

BACKENDS: tuple[str, ...] = ("mlx-whisper", "faster-whisper", "whisper.cpp")
_BACKEND_ALIASES = {
    "mlx_whisper": "mlx-whisper",
    "mlx-whisper": "mlx-whisper",
    "faster_whisper": "faster-whisper",
    "faster-whisper": "faster-whisper",
    "whisper_cpp": "whisper.cpp",
    "whisper.cpp": "whisper.cpp",
}


@dataclass(frozen=True)
class SegmentWindow:
    """One VAD window in seconds relative to the start of the track."""

    start_s: float
    end_s: float


@dataclass(frozen=True)
class ASRSettings:
    """Settings shared by every model adapter.

    Temperature and previous-text conditioning are intentionally not
    user-tunable: both introduce run-to-run variation that is especially hard
    to diagnose once word timestamps are used for roll alignment.
    """

    language: str = DEFAULT_LANGUAGE
    beam_size: int = DEFAULT_BEAM_SIZE
    temperature: float = 0.0
    condition_on_previous_text: bool = False
    device: str = "auto"
    compute_type: str = "default"
    prompt_max_chars: int = DEFAULT_PROMPT_MAX_CHARS
    timeout_s: float = DEFAULT_TIMEOUT_S


@dataclass(frozen=True)
class PromptData:
    text: str
    terms: tuple[str, ...]


@dataclass(frozen=True)
class _RawBatch:
    segments: tuple[object, ...]
    timestamps_absolute: bool


class BackendUnavailableError(RuntimeError):
    """Raised when the configured ASR implementation is not installed."""

    def __init__(self, backend: str, message: str) -> None:
        super().__init__(message)
        self.backend = backend


class _Backend(Protocol):
    name: str
    model: str

    def load(self) -> None:
        """Load the singleton model, if this backend has one."""

    def transcribe_segment(
        self,
        track_path: Path,
        window: SegmentWindow,
        settings: ASRSettings,
        prompt: str,
    ) -> _RawBatch:
        """Transcribe one window and return backend-native timestamps."""


def _finite_number(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a number") from error
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _parse_settings(params: ParamsInput) -> ASRSettings:
    if params is None:
        return ASRSettings()
    if not isinstance(params, Mapping):
        raise TypeError("params must be an object")

    allowed = (
        "language",
        "beam_size",
        "temperature",
        "condition_on_previous_text",
        "device",
        "compute_type",
        "prompt_max_chars",
        "timeout_s",
        "campaign_root",
        "initial_prompt",
    )
    unknown = sorted(str(key) for key in params if str(key) not in allowed)
    if unknown:
        raise ValueError(f"unknown ASR parameter: {unknown[0]}")

    language = params.get("language", DEFAULT_LANGUAGE)
    if not isinstance(language, str) or language.strip() == "":
        raise ValueError("language must be a non-empty string")
    beam_value = _finite_number(params.get("beam_size", DEFAULT_BEAM_SIZE), "beam_size")
    if not beam_value.is_integer() or beam_value < 1:
        raise ValueError("beam_size must be a positive integer")

    temperature = _finite_number(params.get("temperature", 0.0), "temperature")
    if temperature != 0.0:
        raise ValueError("temperature must be 0 for deterministic transcription")
    condition = params.get("condition_on_previous_text", False)
    if not isinstance(condition, bool):
        raise TypeError("condition_on_previous_text must be a boolean")
    if condition:
        raise ValueError("condition_on_previous_text must be false for deterministic transcription")

    device = params.get("device", "auto")
    if not isinstance(device, str) or device.strip() == "":
        raise ValueError("device must be a non-empty string")
    compute_type = params.get("compute_type", "default")
    if not isinstance(compute_type, str) or compute_type.strip() == "":
        raise ValueError("compute_type must be a non-empty string")

    prompt_limit = _finite_number(
        params.get("prompt_max_chars", DEFAULT_PROMPT_MAX_CHARS), "prompt_max_chars"
    )
    if not prompt_limit.is_integer() or prompt_limit < 32:
        raise ValueError("prompt_max_chars must be an integer of at least 32")
    timeout = _finite_number(params.get("timeout_s", DEFAULT_TIMEOUT_S), "timeout_s")
    if timeout <= 0:
        raise ValueError("timeout_s must be greater than zero")

    return ASRSettings(
        language=language.strip(),
        beam_size=int(beam_value),
        temperature=0.0,
        condition_on_previous_text=False,
        device=device.strip().lower(),
        compute_type=compute_type.strip(),
        prompt_max_chars=int(prompt_limit),
        timeout_s=timeout,
    )


def _window(value: object) -> SegmentWindow:
    if isinstance(value, SegmentWindow):
        return value
    if isinstance(value, Mapping):
        start_raw = value.get("start_s", value.get("start"))
        end_raw = value.get("end_s", value.get("end"))
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        if len(value) != 2:
            raise ValueError("a segment sequence must contain start and end")
        start_raw, end_raw = value[0], value[1]
    else:
        raise TypeError("each segment must be an object with start_s and end_s")
    start = _finite_number(start_raw, "segment.start_s")
    end = _finite_number(end_raw, "segment.end_s")
    if start < 0 or end <= start:
        raise ValueError(
            "segment end_s must be greater than start_s and start_s must be non-negative"
        )
    return SegmentWindow(start, end)


def _windows(value: object) -> list[SegmentWindow]:
    if value is None:
        return []
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        raise TypeError("segments must be an array")
    return [_window(item) for item in value]


def _normalise_backend(value: str | None) -> str:
    requested = "auto" if value is None else value.strip().lower()
    if requested in {"", "auto"}:
        return "auto"
    if requested == "fake":
        return "fake"
    try:
        return _BACKEND_ALIASES[requested]
    except KeyError as error:
        choices = ", ".join(("auto", "fake", *BACKENDS))
        raise ValueError(f"backend must be one of: {choices}") from error


def backend_capabilities() -> dict[str, bool]:
    """Report ASR backend availability using the same probes as ``/health``."""
    raw = capabilities.capabilities()
    configured_server = os.environ.get("DND_WHISPER_CPP_SERVER", "").strip()
    return {
        "mlx-whisper": bool(raw.get("mlx_whisper", False)),
        "faster-whisper": bool(raw.get("faster_whisper", False)),
        "whisper.cpp": bool(raw.get("whisper_cpp", False))
        or bool(configured_server)
        or any(shutil.which(name) is not None for name in ("whisper-server", "whisper-server.exe")),
        "fake": capabilities.fake_asr_enabled(),
    }


def _backend_key(name: str) -> str:
    return {
        "mlx-whisper": "mlx_whisper",
        "faster-whisper": "faster_whisper",
        "whisper.cpp": "whisper_cpp",
    }.get(name, name)


def _missing_backend_message(name: str) -> str:
    if name == "fake":
        return "ASR backend 'fake' is unavailable. Set DND_FAKE_ASR=1 to enable the deterministic fixture backend."
    if name == "whisper.cpp":
        return "install whisper.cpp and put its whisper-server binary on PATH (or set DND_WHISPER_CPP_SERVER)"
    message = capabilities.missing_capability_message(_backend_key(name))
    return f"ASR backend '{name}' is unavailable. {message}"


def select_backend(requested: str | None = None) -> str:
    """Choose an installed backend deterministically, or raise an actionable error."""
    if capabilities.fake_asr_enabled():
        return "fake"
    name = _normalise_backend(requested)
    available = backend_capabilities()
    if name != "auto":
        if not available.get(name, False):
            raise BackendUnavailableError(name, _missing_backend_message(name))
        return name

    # Prefer the Metal path on an Apple device, then the portable CTranslate2
    # path.  The order is fixed so the same machine never changes backend due
    # to dictionary ordering or import timing.
    device = os.environ.get("DND_DEVICE", "").strip().lower()
    preference = (
        BACKENDS
        if device in {"", "mps", "metal"}
        else ("faster-whisper", "whisper.cpp", "mlx-whisper")
    )
    for candidate in preference:
        if available.get(candidate, False):
            return candidate
    details = "; ".join(_missing_backend_message(candidate) for candidate in BACKENDS)
    raise BackendUnavailableError("auto", f"No ASR backend is installed. {details}")


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _add_term(terms: dict[str, str], value: object) -> None:
    if not isinstance(value, str):
        return
    clean = " ".join(value.split())
    if clean == "":
        return
    terms.setdefault(clean.casefold(), clean)


def _terms_from_campaign(root: Path) -> list[str]:
    terms: dict[str, str] = {}
    glossary = root / "glossary.md"
    try:
        for line in glossary.read_text(encoding="utf-8").splitlines():
            clean = line.strip().lstrip("-* ").strip()
            if clean and not clean.startswith("#"):
                _add_term(terms, clean)
    except OSError:
        pass

    players = _read_json(root / "players.json")
    if isinstance(players, Mapping):
        raw_players = players.get("players", [])
        if isinstance(raw_players, Sequence) and not isinstance(
            raw_players, (str, bytes, bytearray)
        ):
            for player in raw_players:
                if not isinstance(player, Mapping):
                    continue
                _add_term(terms, player.get("display_name"))
                _add_term(terms, player.get("name"))
                characters = player.get("characters", [])
                if isinstance(characters, Sequence) and not isinstance(
                    characters, (str, bytes, bytearray)
                ):
                    for character in characters:
                        if not isinstance(character, Mapping):
                            continue
                        _add_term(terms, character.get("name"))
                        aliases = character.get("aliases", [])
                        if isinstance(aliases, Sequence) and not isinstance(
                            aliases, (str, bytes, bytearray)
                        ):
                            for alias in aliases:
                                _add_term(terms, alias)

    npcs = _read_json(root / "npcs.json")
    if isinstance(npcs, Mapping):
        raw_npcs = npcs.get("npcs", [])
        if isinstance(raw_npcs, Sequence) and not isinstance(raw_npcs, (str, bytes, bytearray)):
            for npc in raw_npcs:
                if not isinstance(npc, Mapping):
                    continue
                _add_term(terms, npc.get("name"))
                aliases = npc.get("aliases", [])
                if isinstance(aliases, Sequence) and not isinstance(
                    aliases, (str, bytes, bytearray)
                ):
                    for alias in aliases:
                        _add_term(terms, alias)
    return sorted(terms.values(), key=lambda value: (value.casefold(), value))


def _find_campaign_root(track_path: Path, explicit: object | None) -> Path | None:
    if isinstance(explicit, str) and explicit.strip():
        return Path(explicit).expanduser()
    current = track_path.resolve().parent
    for candidate in (current, *current.parents):
        root = candidate / "campaign"
        if root.is_dir():
            return root
    return None


def _cap_prompt(terms: Sequence[str], custom: str, limit: int) -> PromptData:
    prefix = "D&D proper nouns: "
    selected: list[str] = []
    body_length = 0
    for term in terms:
        extra = len(term) if not selected else len(term) + 2
        if len(prefix) + body_length + extra > limit:
            break
        selected.append(term)
        body_length += extra
    prompt = prefix + ", ".join(selected) if selected else ""
    if custom.strip():
        custom_text = " ".join(custom.split())
        addition = f" {custom_text}" if prompt else custom_text
        prompt = (prompt + addition)[:limit]
    return PromptData(prompt[:limit], tuple(selected))


def build_initial_prompt(
    campaign_root: str | Path | None = None,
    *,
    track_path: str | Path | None = None,
    max_chars: int = DEFAULT_PROMPT_MAX_CHARS,
    custom: str = "",
) -> PromptData:
    """Build a bounded, deterministic prompt from glossary and identity files."""
    track = Path(track_path) if track_path is not None else Path.cwd()
    root = _find_campaign_root(track, campaign_root)
    terms = _terms_from_campaign(root) if root is not None else []
    return _cap_prompt(terms, custom, max_chars)


def _field(value: object, name: str, default: object | None = None) -> object | None:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _raw_words(segment: object) -> list[tuple[str, float, float]]:
    raw_words = _field(segment, "words", [])
    if not isinstance(raw_words, Sequence) or isinstance(raw_words, (str, bytes, bytearray)):
        return []
    result: list[tuple[str, float, float]] = []
    for item in raw_words:
        word = _text(_field(item, "word", _field(item, "text", _field(item, "t", ""))))
        start_raw = _field(item, "start", _field(item, "s"))
        end_raw = _field(item, "end", _field(item, "e"))
        if word == "" or start_raw is None or end_raw is None:
            continue
        try:
            start = _finite_number(start_raw, "word.start")
            end = _finite_number(end_raw, "word.end")
        except (TypeError, ValueError):
            continue
        if end > start:
            result.append((word, start, end))
    return result


def _raw_segment_values(
    segment: object,
) -> tuple[float, float, str, list[tuple[str, float, float]], float | None, float | None]:
    start_raw = _field(segment, "start", _field(segment, "start_s", 0.0))
    end_raw = _field(segment, "end", _field(segment, "end_s", start_raw))
    start = _finite_number(start_raw, "segment.start")
    end = _finite_number(end_raw, "segment.end")
    if end <= start:
        raise ValueError("backend returned a non-positive segment")
    text = _text(_field(segment, "text", ""))
    words = _raw_words(segment)
    avg_raw = _field(segment, "avg_logprob", _field(segment, "avg_log_probability"))
    no_speech_raw = _field(segment, "no_speech_prob", _field(segment, "no_speech_probability"))
    avg = None if avg_raw is None else _finite_number(avg_raw, "avg_logprob")
    no_speech = None if no_speech_raw is None else _finite_number(no_speech_raw, "no_speech_prob")
    return start, end, text, words, avg, no_speech


def _normalise_batch(
    batch: _RawBatch,
    window: SegmentWindow,
) -> list[dict[str, object]]:
    normalized: list[dict[str, object]] = []
    for raw in batch.segments:
        start, end, text, words, avg, no_speech = _raw_segment_values(raw)
        if batch.timestamps_absolute and (end <= window.start_s or start >= window.end_s):
            continue
        offset = 0.0 if batch.timestamps_absolute else window.start_s
        start = max(window.start_s, start + offset) if batch.timestamps_absolute else start + offset
        end = min(window.end_s, end + offset) if batch.timestamps_absolute else end + offset
        if end <= start:
            continue
        output_words: list[dict[str, object]] = []
        previous_end = start
        for word_text, word_start, word_end in sorted(
            words, key=lambda item: (item[1], item[2], item[0])
        ):
            word_start += offset
            word_end += offset
            if batch.timestamps_absolute:
                if word_end <= window.start_s or word_start >= window.end_s:
                    continue
                word_start = max(window.start_s, word_start)
                word_end = min(window.end_s, word_end)
            if word_end <= word_start:
                continue
            # A broken model timestamp must not make the canonical word list
            # go backwards. Clamping is deterministic and keeps the segment
            # useful for downstream alignment instead of dropping the utterance.
            word_start = max(previous_end, word_start)
            word_end = max(word_start + 0.001, word_end)
            output_words.append(
                {
                    "t": word_text,
                    "s": round(word_start, 3),
                    "e": round(word_end, 3),
                }
            )
            previous_end = word_end
        normalized.append(
            {
                "start_s": round(start, 3),
                "end_s": round(end, 3),
                "text": text,
                "words": output_words,
                "avg_logprob": None if avg is None else round(avg, 6),
                "no_speech_prob": None if no_speech is None else round(no_speech, 6),
            }
        )
    return normalized


def _enforce_global_word_monotonic(
    segments: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    """Clip/drop overlapping words without changing their text or ordering.

    VAD windows may overlap, and a backend can repeat a boundary word.  The
    canonical transcript keeps the first deterministically sorted occurrence,
    clips a later word that crosses that boundary, and drops one wholly inside
    the already-emitted interval.  Millisecond integers make the result stable
    after the public three-decimal rounding.
    """
    previous_end_ms: int | None = None
    adjusted: list[dict[str, object]] = []
    for segment in segments:
        raw_words = segment.get("words", [])
        if not isinstance(raw_words, Sequence) or isinstance(raw_words, (str, bytes, bytearray)):
            adjusted.append(segment)
            continue
        kept: list[dict[str, object]] = []
        valid_words = 0
        for raw_word in raw_words:
            if not isinstance(raw_word, Mapping):
                continue
            text = raw_word.get("t")
            if not isinstance(text, str):
                continue
            try:
                start_ms = round(_finite_number(raw_word.get("s"), "word.s") * 1000)
                end_ms = round(_finite_number(raw_word.get("e"), "word.e") * 1000)
            except (TypeError, ValueError):
                continue
            if end_ms <= start_ms:
                continue
            valid_words += 1
            if previous_end_ms is not None:
                if end_ms <= previous_end_ms:
                    continue
                start_ms = max(start_ms, previous_end_ms)
            if end_ms <= start_ms:
                continue
            kept.append({"t": text, "s": start_ms / 1000, "e": end_ms / 1000})
            previous_end_ms = end_ms

        if valid_words > 0 and not kept:
            # This is an overlapping duplicate, not an attribution decision.
            continue
        copied = dict(segment)
        copied["words"] = kept
        adjusted.append(copied)
    return adjusted


class _FasterWhisperBackend:
    name = "faster-whisper"

    def __init__(self, model: str, device: str, compute_type: str) -> None:
        self.model = model
        self._device = device
        self._compute_type = compute_type
        self._model: object | None = None
        self._lock = threading.Lock()

    def load(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            try:
                from faster_whisper import WhisperModel  # type: ignore
            except Exception as error:  # pragma: no cover - model host only
                raise BackendUnavailableError(
                    self.name, _missing_backend_message(self.name)
                ) from error
            log.info(
                "loading ASR backend=%s model=%s device=%s compute_type=%s",
                self.name,
                self.model,
                self._device,
                self._compute_type,
            )
            self._model = WhisperModel(
                self.model,
                device=self._device,
                compute_type=self._compute_type,
            )

    def transcribe_segment(
        self,
        track_path: Path,
        window: SegmentWindow,
        settings: ASRSettings,
        prompt: str,
    ) -> _RawBatch:
        self.load()
        assert self._model is not None
        kwargs: dict[str, object] = {
            "language": settings.language,
            "beam_size": settings.beam_size,
            "temperature": 0.0,
            "condition_on_previous_text": False,
            "word_timestamps": True,
            "clip_timestamps": [window.start_s, window.end_s],
        }
        if prompt:
            kwargs["initial_prompt"] = prompt
        result = self._model.transcribe(str(track_path), **kwargs)  # type: ignore[attr-defined]
        raw_segments = result[0] if isinstance(result, tuple) else result
        if not isinstance(raw_segments, Sequence):
            raw_segments = tuple(raw_segments)
        # faster-whisper applies ``clip_timestamps`` as an input seek while
        # retaining the track offset in Segment.start/Word.start.  Adding the
        # VAD offset again would double it for every non-zero window.
        return _RawBatch(tuple(raw_segments), timestamps_absolute=True)


class _MlxWhisperBackend:
    name = "mlx-whisper"

    def __init__(self, model: str) -> None:
        self.model = model
        self._module: object | None = None
        self._model_resource: object | None = None
        self._lock = threading.Lock()

    def load(self) -> None:
        if self._module is not None:
            return
        with self._lock:
            if self._module is not None:
                return
            try:
                import mlx_whisper  # type: ignore
            except Exception as error:  # pragma: no cover - model host only
                raise BackendUnavailableError(
                    self.name, _missing_backend_message(self.name)
                ) from error
            self._preload_model()
            self._module = mlx_whisper
            log.info("loaded ASR backend=%s model=%s", self.name, self.model)

    def _preload_model(self) -> None:
        """Prime mlx-whisper's official process-wide ``ModelHolder`` cache.

        The public ``transcribe`` function accepts a model path, not a model
        object.  Current mlx-whisper releases keep the loaded object in the
        ``transcribe.ModelHolder`` cache; priming that holder here ensures the
        first segment does the load and later jobs reuse the same resource.
        Older/forked releases without that holder remain supported and keep
        their own backend cache semantics.
        """
        try:
            transcribe_module = importlib.import_module("mlx_whisper.transcribe")
            holder = getattr(transcribe_module, "ModelHolder", None)
            get_model = getattr(holder, "get_model", None)
            if not callable(get_model):
                return
            import mlx.core as mx  # type: ignore

            self._model_resource = get_model(self.model, dtype=mx.float16)
        except ImportError:
            # The top-level module can be supplied by a compatible fork whose
            # transcribe function owns model loading internally.
            return

    def transcribe_segment(
        self,
        track_path: Path,
        window: SegmentWindow,
        settings: ASRSettings,
        prompt: str,
    ) -> _RawBatch:
        self.load()
        assert self._module is not None
        kwargs: dict[str, object] = {
            "path_or_hf_repo": self.model,
            "language": settings.language,
            "beam_size": settings.beam_size,
            "temperature": 0.0,
            "condition_on_previous_text": False,
            "word_timestamps": True,
            "clip_timestamps": [window.start_s, window.end_s],
            "fp16": True,
        }
        if prompt:
            kwargs["initial_prompt"] = prompt
        result = self._module.transcribe(str(track_path), **kwargs)  # type: ignore[attr-defined]
        if isinstance(result, Mapping):
            raw_segments = result.get("segments", [])
            if not isinstance(raw_segments, Sequence) or isinstance(
                raw_segments, (str, bytes, bytearray)
            ):
                raw_segments = (raw_segments,)
            return _RawBatch(tuple(raw_segments), timestamps_absolute=True)
        return _RawBatch((result,), timestamps_absolute=True)


def _parse_cpp_time(value: object) -> float:
    if isinstance(value, (int, float)):
        return _finite_number(value, "whisper.cpp timestamp")
    if not isinstance(value, str):
        raise TypeError("whisper.cpp timestamp is missing")
    text = value.strip()
    if ":" in text:
        pieces = text.split(":")
        if len(pieces) == 3:
            return int(pieces[0]) * 3600 + int(pieces[1]) * 60 + float(pieces[2].replace(",", "."))
        if len(pieces) == 2:
            return int(pieces[0]) * 60 + float(pieces[1].replace(",", "."))
    return _finite_number(text.replace(",", "."), "whisper.cpp timestamp")


def _cpp_words(item: Mapping[str, object]) -> list[dict[str, object]]:
    """Convert whisper.cpp token timestamps to the common word shape."""
    raw_words = item.get("words", item.get("tokens", []))
    if not isinstance(raw_words, Sequence) or isinstance(raw_words, (str, bytes, bytearray)):
        return []
    converted: list[dict[str, object]] = []
    for raw_word in raw_words:
        if not isinstance(raw_word, Mapping):
            continue
        timestamps = raw_word.get("timestamps", {})
        if not isinstance(timestamps, Mapping):
            timestamps = {}
        start_value = timestamps.get("from", raw_word.get("start"))
        end_value = timestamps.get("to", raw_word.get("end"))
        try:
            start = _parse_cpp_time(start_value)
            end = _parse_cpp_time(end_value)
        except (TypeError, ValueError):
            continue
        word = _text(raw_word.get("word", raw_word.get("text", "")))
        if word and end > start:
            converted.append({"word": word, "start": start, "end": end})
    return converted


def _cpp_segments(payload: object) -> tuple[object, ...]:
    if isinstance(payload, Mapping):
        raw = payload.get("transcription", payload.get("segments", []))
        if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes, bytearray)):
            converted: list[dict[str, object]] = []
            for item in raw:
                if not isinstance(item, Mapping):
                    continue
                timestamps = item.get("timestamps", {})
                if not isinstance(timestamps, Mapping):
                    timestamps = {}
                start_value = timestamps.get(
                    "from",
                    item.get(
                        "start",
                        item.get("offsets", {}).get("from", 0)
                        if isinstance(item.get("offsets"), Mapping)
                        else 0,
                    ),
                )
                end_value = timestamps.get(
                    "to",
                    item.get(
                        "end",
                        item.get("offsets", {}).get("to", start_value)
                        if isinstance(item.get("offsets"), Mapping)
                        else start_value,
                    ),
                )
                try:
                    start = _parse_cpp_time(start_value)
                    end = _parse_cpp_time(end_value)
                except (TypeError, ValueError):
                    continue
                converted.append(
                    {
                        "start": start,
                        "end": end,
                        "text": _text(item.get("text", "")),
                        "words": _cpp_words(item),
                        "avg_logprob": item.get("avg_logprob"),
                        "no_speech_prob": item.get("no_speech_prob"),
                    }
                )
            return tuple(converted)
    return ()


class _WhisperCppBackend:
    """Persistent whisper.cpp HTTP-server adapter.

    The whisper.cpp CLI loads its model for every invocation.  Its supported
    ``whisper-server`` binary loads the model once and exposes the same
    decoder through ``/inference``; keeping that subprocess alive lets jobs
    reuse the loaded model while the sidecar's job gate serializes requests.
    """

    name = "whisper.cpp"
    _SERVER_START_TIMEOUT_S = 30.0
    _SERVER_HOST = "127.0.0.1"

    def __init__(self, model: str) -> None:
        self.model = model
        self._server_command = os.environ.get("DND_WHISPER_CPP_SERVER", "").strip() or None
        self._process: subprocess.Popen[bytes] | None = None
        self._base_url: str | None = None
        self._server_ready = False
        self._lock = threading.Lock()
        self._request_lock = threading.Lock()

    def _find_server_command(self) -> str | None:
        if self._server_command:
            return self._server_command
        return next(
            (
                shutil.which(name)
                for name in ("whisper-server", "whisper-server.exe")
                if shutil.which(name)
            ),
            None,
        )

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((_WhisperCppBackend._SERVER_HOST, 0))
            return int(probe.getsockname()[1])

    def _stop_process(self) -> None:
        process = self._process
        self._process = None
        self._base_url = None
        self._server_ready = False
        if process is None:
            return
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            log.debug("whisper.cpp server did not stop cleanly", exc_info=True)

    def _start_server(self) -> None:
        command = self._find_server_command()
        if command is None:
            raise BackendUnavailableError(
                self.name,
                "install whisper.cpp and put its whisper-server binary on PATH "
                "(or set DND_WHISPER_CPP_SERVER)",
            )
        if self.model.strip() == "":
            raise RuntimeError(
                "whisper.cpp needs a model path; pass model or set DND_WHISPER_CPP_MODEL"
            )
        port = self._free_port()
        argv = [
            command,
            "-m",
            self.model,
            "--host",
            self._SERVER_HOST,
            "--port",
            str(port),
            "--inference-path",
            "/inference",
        ]
        if os.environ.get("DND_WHISPER_CPP_CONVERT", "") == "1":
            argv.append("--convert")
        try:
            process = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as error:
            raise BackendUnavailableError(
                self.name,
                "whisper.cpp server could not be started; verify DND_WHISPER_CPP_SERVER "
                "or put whisper-server on PATH",
            ) from error
        self._process = process
        self._base_url = f"http://{self._SERVER_HOST}:{port}"
        deadline = time.monotonic() + self._SERVER_START_TIMEOUT_S
        while time.monotonic() < deadline:
            if process.poll() is not None:
                self._stop_process()
                raise RuntimeError("whisper.cpp server exited before loading its model")
            try:
                request = urllib.request.Request(f"{self._base_url}/health", method="GET")
                with urllib.request.urlopen(request, timeout=0.25) as response:
                    if response.status == 200:
                        self._server_ready = True
                        log.info(
                            "ready ASR backend=%s model=%s server=%s",
                            self.name,
                            self.model,
                            self._base_url,
                        )
                        return
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.05)
        self._stop_process()
        raise RuntimeError("whisper.cpp server did not become ready before the startup timeout")

    def load(self) -> None:
        with self._lock:
            if self._server_ready and self._process is not None and self._process.poll() is None:
                return
            self._stop_process()
            self._start_server()

    def close(self) -> None:
        with self._lock:
            self._base_url = None
            self._stop_process()

    @staticmethod
    def _multipart_body(track_path: Path, fields: Mapping[str, str]) -> tuple[bytes, str]:
        boundary = "dnd-auto-notes-whisper-boundary"
        chunks: list[bytes] = []
        for name, value in fields.items():
            chunks.extend(
                (
                    f"--{boundary}\r\n".encode(),
                    f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                    value.encode(),
                    b"\r\n",
                )
            )
        filename = track_path.name.replace('"', "")
        mime = "audio/wav" if track_path.suffix.lower() == ".wav" else "application/octet-stream"
        chunks.extend(
            (
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                    f"Content-Type: {mime}\r\n\r\n"
                ).encode(),
                track_path.read_bytes(),
                b"\r\n",
                f"--{boundary}--\r\n".encode(),
            )
        )
        return b"".join(chunks), boundary

    def _request_server(
        self,
        track_path: Path,
        settings: ASRSettings,
        prompt: str,
    ) -> _RawBatch:
        self.load()
        assert self._base_url is not None
        fields = {
            "response_format": "verbose_json",
            "temperature": "0",
            "temperature_inc": "0",
            "language": settings.language,
            "beam_size": str(settings.beam_size),
            "token_timestamps": "1",
            "no_timestamps": "0",
            "split_on_word": "1",
            "no_context": "1",
            "no_language_probabilities": "1",
        }
        if prompt:
            fields["prompt"] = prompt
        body, boundary = self._multipart_body(track_path, fields)
        request = urllib.request.Request(
            f"{self._base_url}/inference",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with self._request_lock:
            try:
                with urllib.request.urlopen(request, timeout=settings.timeout_s) as response:
                    payload = json.loads(response.read())
            except urllib.error.HTTPError as error:
                detail = error.read(500).decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"whisper.cpp server returned HTTP {error.code}: {detail}"
                ) from error
            except (OSError, urllib.error.URLError) as error:
                self._server_ready = False
                raise RuntimeError(f"whisper.cpp server request failed: {error}") from error
        if isinstance(payload, Mapping) and payload.get("error"):
            raise RuntimeError(f"whisper.cpp server error: {payload['error']}")
        return _RawBatch(_cpp_segments(payload), timestamps_absolute=True)

    def transcribe_segment(
        self,
        track_path: Path,
        window: SegmentWindow,
        settings: ASRSettings,
        prompt: str,
    ) -> _RawBatch:
        del window
        return self._request_server(track_path, settings, prompt)

    def transcribe_segments(
        self,
        track_path: Path,
        windows: Sequence[SegmentWindow],
        settings: ASRSettings,
        prompt: str,
    ) -> _RawBatch:
        del windows
        # One HTTP request per job keeps the loaded server model reusable while
        # the caller assigns the absolute response to each VAD window.
        return self._request_server(track_path, settings, prompt)


class _FakeBackend:
    name = "fake"

    def __init__(self, model: str, track_path: Path) -> None:
        self.model = model
        self.track_path = track_path
        self._utterances: list[Mapping[str, object]] | None = None

    def load(self) -> None:
        if self._utterances is not None:
            return
        truth_path = _find_truth(self.track_path)
        if truth_path is None:
            raise RuntimeError("DND_FAKE_ASR=1 requires truth.json beside the synthetic session")
        truth = _read_json(truth_path)
        if not isinstance(truth, Mapping):
            raise TypeError(f"fixture truth is not an object: {truth_path}")
        track_name = self.track_path.name
        player_id: str | None = None
        track_found = False
        raw_tracks = truth.get("tracks", [])
        if isinstance(raw_tracks, Sequence) and not isinstance(raw_tracks, (str, bytes, bytearray)):
            for item in raw_tracks:
                if isinstance(item, Mapping) and Path(str(item.get("file", ""))).name == track_name:
                    track_found = True
                    value = item.get("player_id", item.get("player"))
                    player_id = value if isinstance(value, str) else None
                    break
        if not track_found:
            raise RuntimeError(f"fixture truth has no track entry for {track_name}")
        if player_id is None:
            raise RuntimeError(f"fixture truth track {track_name} has no player_id")
        raw_utterances = truth.get("utterances", [])
        if not isinstance(raw_utterances, Sequence) or isinstance(
            raw_utterances, (str, bytes, bytearray)
        ):
            raise TypeError(f"fixture truth has no utterances: {truth_path}")
        self._utterances = [
            item
            for item in raw_utterances
            if isinstance(item, Mapping) and item.get("player_id", item.get("player")) == player_id
        ]
        log.info("loaded deterministic ASR truth=%s track=%s", truth_path, track_name)

    def transcribe_segment(
        self,
        track_path: Path,
        window: SegmentWindow,
        settings: ASRSettings,
        prompt: str,
    ) -> _RawBatch:
        del track_path, settings, prompt
        self.load()
        assert self._utterances is not None
        result: list[dict[str, object]] = []
        for item in self._utterances:
            start = _finite_number(item.get("start_s", item.get("start")), "truth.start_s")
            end = _finite_number(item.get("end_s", item.get("end")), "truth.end_s")
            if end <= window.start_s or start >= window.end_s:
                continue
            text = _text(item.get("text", ""))
            result.append(
                {
                    "start": start,
                    "end": end,
                    "text": text,
                    "words": _fake_words(text, start, end),
                    "avg_logprob": -0.05,
                    "no_speech_prob": 0.0,
                }
            )
        return _RawBatch(tuple(result), timestamps_absolute=True)


def _find_truth(track_path: Path) -> Path | None:
    current = track_path.resolve().parent
    for candidate in (current, *current.parents):
        truth = candidate / "truth.json"
        if truth.is_file():
            return truth
    return None


def _fake_words(text: str, start: float, end: float) -> list[dict[str, object]]:
    matches = list(_WORD_PATTERN.finditer(text))
    if not matches:
        return []
    duration = end - start
    total_chars = max(1, len(text))
    words: list[dict[str, object]] = []
    previous = start
    for match in matches:
        word_start = start + duration * match.start() / total_chars
        word_end = start + duration * match.end() / total_chars
        word_start = max(previous, word_start)
        word_end = max(word_start + min(0.001, duration), word_end)
        words.append({"t": match.group(0), "s": round(word_start, 3), "e": round(word_end, 3)})
        previous = word_end
    return words


def _resolve_device(settings: ASRSettings) -> tuple[str, str]:
    device = settings.device
    if device == "auto":
        device = os.environ.get("DND_DEVICE", "").strip().lower()
    if device == "":
        device = "cpu"
    compute = settings.compute_type
    if compute == "default":
        compute = "float16" if device in {"cuda", "mps", "metal"} else "int8"
    return device, compute


_ADAPTERS: dict[tuple[str, str, str, str], _Backend] = {}
_ADAPTER_LOCK = threading.Lock()


def _adapter(name: str, model: str, settings: ASRSettings, track_path: Path) -> _Backend:
    device, compute = _resolve_device(settings)
    key = (name, model, device, compute)
    if name == "fake":
        # The fixture backend has no model to share and its truth source is
        # track-specific; caching it by model alone would reuse the first
        # track's utterances for every later track in the process.
        return _FakeBackend(model, track_path)
    with _ADAPTER_LOCK:
        existing = _ADAPTERS.get(key)
        if existing is not None:
            return existing
        if name == "faster-whisper":
            created = _FasterWhisperBackend(model, device, compute)
        elif name == "mlx-whisper":
            created = _MlxWhisperBackend(model)
        elif name == "whisper.cpp":
            created = _WhisperCppBackend(model)
        else:  # pragma: no cover - select_backend validates this
            raise ValueError(f"unsupported ASR backend: {name}")
        _ADAPTERS[key] = created
        return created


def reset_for_tests() -> None:
    """Drop lazy singleton adapters without importing any model package."""
    with _ADAPTER_LOCK:
        adapters = tuple(_ADAPTERS.values())
        _ADAPTERS.clear()
    for adapter in adapters:
        close = getattr(adapter, "close", None)
        if callable(close):
            close()


def _model_name(name: str, requested: str | None) -> str:
    if requested is not None and requested.strip():
        return requested.strip()
    if name == "fake":
        return "fixture-truth"
    if name == "whisper.cpp":
        return os.environ.get("DND_WHISPER_CPP_MODEL", "").strip()
    return DEFAULT_MODEL


def transcribe_track(
    track_path: str | Path,
    segments: object,
    *,
    backend: str | None = None,
    model: str | None = None,
    params: ParamsInput = None,
    progress: ProgressFn | None = None,
) -> dict[str, object]:
    """Transcribe VAD windows and return a deterministic JSON-compatible result."""
    path = Path(track_path)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    options = _parse_settings(params)
    windows = _windows(segments)
    selected = select_backend(backend)
    model_name = _model_name(selected, model)
    prompt_params = params if isinstance(params, Mapping) else {}
    prompt = build_initial_prompt(
        prompt_params.get("campaign_root"),
        track_path=path,
        max_chars=options.prompt_max_chars,
        custom=prompt_params.get("initial_prompt", "")
        if isinstance(prompt_params.get("initial_prompt", ""), str)
        else "",
    )
    log.info(
        "transcription backend=%s model=%s initial_prompt_chars=%d terms=%s",
        selected,
        model_name or "(unset)",
        len(prompt.text),
        ",".join(prompt.terms) or "(none)",
    )
    if progress:
        progress(0.05, f"selected {selected}")

    adapter = _adapter(selected, model_name, options, path)
    # Loading is deliberately outside the per-segment try block: a missing
    # installation is a job-level configuration failure, while a corrupt clip
    # is evidence that should not discard every other usable segment.
    adapter.load()

    output_segments: list[dict[str, object]] = []
    errors: list[dict[str, object]] = []

    def record_error(index: int, window: SegmentWindow, error: Exception) -> None:
        errors.append(
            {
                "segment_index": index,
                "start_s": round(window.start_s, 3),
                "end_s": round(window.end_s, 3),
                "error": f"{type(error).__name__}: {error}",
            }
        )

    batch_runner = getattr(adapter, "transcribe_segments", None)
    if callable(batch_runner) and windows:
        try:
            shared_batch = batch_runner(path, windows, options, prompt.text)
        except Exception as error:  # noqa: BLE001 - report each requested clip
            for index, window in enumerate(windows):
                record_error(index, window, error)
                if progress:
                    fraction = 0.1 + (0.85 * (index + 1) / len(windows))
                    progress(fraction, f"transcribed segment {index + 1}/{len(windows)}")
        else:
            for index, window in enumerate(windows):
                try:
                    output_segments.extend(_normalise_batch(shared_batch, window))
                except Exception as error:  # noqa: BLE001 - isolate one VAD window
                    record_error(index, window, error)
                if progress:
                    fraction = 0.1 + (0.85 * (index + 1) / len(windows))
                    progress(fraction, f"transcribed segment {index + 1}/{len(windows)}")
    else:
        for index, window in enumerate(windows):
            try:
                batch = adapter.transcribe_segment(path, window, options, prompt.text)
                output_segments.extend(_normalise_batch(batch, window))
            except Exception as error:  # noqa: BLE001 - one bad clip must not abort a track
                record_error(index, window, error)
            if progress:
                fraction = 0.1 + (0.85 * (index + 1) / max(1, len(windows)))
                progress(fraction, f"transcribed segment {index + 1}/{len(windows)}")

    output_segments.sort(
        key=lambda item: (float(item["start_s"]), float(item["end_s"]), str(item["text"]))
    )
    deduped: list[dict[str, object]] = []
    seen: set[tuple[float, float, str]] = set()
    for segment in output_segments:
        key = (float(segment["start_s"]), float(segment["end_s"]), str(segment["text"]))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(segment)
    deduped = _enforce_global_word_monotonic(deduped)

    result: dict[str, object] = {
        "backend": selected,
        "model": model_name,
        "segments": deduped,
        "errors": errors,
        "initial_prompt": prompt.text,
        "prompt_terms": list(prompt.terms),
        "settings": asdict(options),
    }
    if progress:
        progress(1.0, "transcription complete")
    return result


def run_transcription(
    track_path: str | Path,
    segments: object,
    backend: str | None = None,
    model: str | None = None,
    params: ParamsInput = None,
    progress: ProgressFn | None = None,
) -> dict[str, object]:
    """Job-friendly alias used by the FastAPI ``POST /transcribe`` route."""
    return transcribe_track(
        track_path, segments, backend=backend, model=model, params=params, progress=progress
    )


# The server subprocess owns a loaded model and must not survive a sidecar
# interpreter shutdown.  Registering the existing reset hook keeps cleanup
# independent of whether the process exits through FastAPI or a test runner.
atexit.register(reset_for_tests)


__all__ = [
    "BACKENDS",
    "DEFAULT_BEAM_SIZE",
    "DEFAULT_LANGUAGE",
    "DEFAULT_MODEL",
    "DEFAULT_PROMPT_MAX_CHARS",
    "ASRSettings",
    "BackendUnavailableError",
    "PromptData",
    "SegmentWindow",
    "backend_capabilities",
    "build_initial_prompt",
    "reset_for_tests",
    "run_transcription",
    "select_backend",
    "transcribe_track",
]
