"""What this machine can actually do.

Every probe is a lazy import inside try/except and must never raise: the whole
point is that the sidecar starts on a bare machine and *reports* what is
missing, rather than failing at import and taking the pipeline down with it.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import shutil
import sys
from functools import lru_cache
from typing import Any

log = logging.getLogger(__name__)

#: Optional packages, each gating a specific stage.
OPTIONAL_MODULES = (
    "mlx_whisper",
    "faster_whisper",
    "whisper_cpp",
    "torch",
    "speechbrain",
    "pyannote.audio",
    "silero_vad",
)


def _module_present(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, ModuleNotFoundError):
        return False
    except Exception:  # noqa: BLE001 - a broken install must not crash /health
        return False


def _device() -> str:
    """Best available accelerator. Falls back to cpu without complaint."""
    override = os.environ.get("DND_DEVICE", "").strip()
    if override:
        return override
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception as error:  # noqa: BLE001 - torch absent is the normal case
        # Not a failure: no torch means cpu. Logged at debug so a *broken*
        # torch install is still diagnosable rather than silently invisible.
        log.debug("no accelerator detected: %s: %s", type(error).__name__, error)
    return "cpu"


def fake_asr_enabled() -> bool:
    return os.environ.get("DND_FAKE_ASR", "") == "1"


def fake_embed_enabled() -> bool:
    return os.environ.get("DND_FAKE_EMBED", "") == "1"


@lru_cache(maxsize=1)
def _static_capabilities() -> dict[str, bool]:
    return {name.replace(".", "_"): _module_present(name) for name in OPTIONAL_MODULES}


def capabilities() -> dict[str, Any]:
    caps = dict(_static_capabilities())
    # ffmpeg is a binary, not a module, and is re-probed because a user may
    # install it while the sidecar is running.
    caps["ffmpeg"] = shutil.which("ffmpeg") is not None
    caps["ffprobe"] = shutil.which("ffprobe") is not None
    return caps


def missing_capability_message(name: str) -> str:
    """Actionable rather than merely true — the caller shows this verbatim."""
    hints = {
        "mlx_whisper": "pip install mlx-whisper  (Apple Silicon only)",
        "faster_whisper": "pip install faster-whisper",
        "whisper_cpp": "install whisper.cpp and put its binary on PATH",
        "torch": "install torch from pytorch.org matching your CUDA, then retry",
        "speechbrain": "pip install speechbrain  (needs torch)",
        "pyannote_audio": "pip install pyannote.audio, accept the gated model terms, set HF_TOKEN",
        "silero_vad": "pip install silero-vad  (an energy fallback ships in-tree)",
        "ffmpeg": "install ffmpeg and put it on PATH",
        "ffprobe": "install ffmpeg (ffprobe ships with it) and put it on PATH",
    }
    hint = hints.get(name, "see sidecar/pyproject.toml for the install line")
    return f"capability '{name}' is not available on this machine. To enable it: {hint}"


def health() -> dict[str, Any]:
    from . import __version__

    return {
        "status": "ok",
        "version": __version__,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "device": _device(),
        "capabilities": capabilities(),
        "fakes": {"asr": fake_asr_enabled(), "embed": fake_embed_enabled()},
    }
