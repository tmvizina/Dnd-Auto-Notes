"""Cooperative cancellation.

A job is cancelled at its next progress checkpoint rather than killed, so a
half-written file never outlives the job that was writing it. Anything that
shells out registers its subprocess here so cancelling reaches the child too.
"""

from __future__ import annotations

import subprocess
import threading


class JobCancelled(Exception):
    """Raised inside a worker thread when its job has been cancelled."""


_lock = threading.Lock()
_cancelled: set[str] = set()
_subprocesses: dict[str, subprocess.Popen[bytes]] = {}
_current = threading.local()


def set_current_job(job_id: str | None) -> None:
    _current.job_id = job_id


def current_job() -> str | None:
    return getattr(_current, "job_id", None)


def request_cancel(job_id: str) -> None:
    """Flag the job and kill any subprocess it registered."""
    with _lock:
        _cancelled.add(job_id)
        process = _subprocesses.get(job_id)
    if process is not None and process.poll() is None:
        process.terminate()


def is_cancelled(job_id: str) -> bool:
    with _lock:
        return job_id in _cancelled


def raise_if_cancelled(job_id: str | None = None) -> None:
    target = job_id or current_job()
    if target is not None and is_cancelled(target):
        raise JobCancelled(target)


def register_subprocess(process: subprocess.Popen[bytes], job_id: str | None = None) -> None:
    target = job_id or current_job()
    if target is None:
        return
    with _lock:
        _subprocesses[target] = process


def clear_job(job_id: str) -> None:
    with _lock:
        _cancelled.discard(job_id)
        _subprocesses.pop(job_id, None)
