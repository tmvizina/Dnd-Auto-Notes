"""In-process job registry for long-running work.

Ported from Audio Forge's worker, which has run this shape in production: the
endpoints enqueue a callable and return a ``job_id``; the caller polls
``GET /jobs/<id>``. One background thread per job.

GPU access is coordinated by ``GPU_GATE``, a readers-writer gate:

* **writers** (transcribe, embed — the heavy model work) serialise against
  everything, because two Whisper models will not fit twice.
* **readers** (probe, score — light work) run concurrently among themselves,
  up to ``DND_JOB_CONCURRENCY``, as long as no writer holds the gate.

A scoring-only pass therefore gets real parallelism instead of queueing behind
one global lock, while a mixed workload keeps the exclusive-GPU guarantee.
"""

from __future__ import annotations

import logging
import os
import threading
import traceback
import uuid
from collections.abc import Callable
from datetime import UTC
from typing import Any

from . import cancel

log = logging.getLogger(__name__)

ProgressFn = Callable[[float, str], None]
JobFn = Callable[[ProgressFn], Any]

#: Job kinds that only read the GPU and may share it.
READER_KINDS = frozenset({"probe", "score", "vad"})


class _GpuGate:
    """Readers share; writers are exclusive. Double-checked so a burst of
    readers does not serialise on the condition lock just to increment."""

    def __init__(self, max_readers: int) -> None:
        self._cond = threading.Condition(threading.Lock())
        self._readers = 0
        self._writer = False
        self._max_readers = max(1, max_readers)

    def acquire_read(self) -> None:
        with self._cond:
            while self._writer or self._readers >= self._max_readers:
                self._cond.wait()
            self._readers += 1

    def release_read(self) -> None:
        with self._cond:
            self._readers -= 1
            self._cond.notify_all()

    def acquire_write(self) -> None:
        with self._cond:
            while self._writer or self._readers > 0:
                self._cond.wait()
            self._writer = True

    def release_write(self) -> None:
        with self._cond:
            self._writer = False
            self._cond.notify_all()

    @property
    def state(self) -> dict[str, Any]:
        with self._cond:
            return {"readers": self._readers, "writer": self._writer, "max_readers": self._max_readers}


_CONCURRENCY = max(1, int(os.environ.get("DND_JOB_CONCURRENCY", "3")))
GPU_GATE = _GpuGate(_CONCURRENCY)

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _now() -> str:
    from datetime import datetime

    return datetime.now(UTC).isoformat()


def create_job(kind: str, fn: JobFn, *, use_model_lock: bool = True) -> str:
    """Start ``fn(progress)`` on a background thread; return its id at once."""
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    with _lock:
        _jobs[job_id] = {
            "job_id": job_id,
            "kind": kind,
            "status": "queued",
            "progress": 0.0,
            "message": "queued",
            "result": None,
            "error": None,
            "created_at": _now(),
            "finished_at": None,
        }

    def progress(pct: float, message: str) -> None:
        # Cancellation between steps surfaces here as a clean JobCancelled.
        cancel.raise_if_cancelled(job_id)
        with _lock:
            job = _jobs.get(job_id)
            if job and job["status"] == "running":
                # Monotonic: a stage that recomputes a fraction must never
                # appear to go backwards in a progress bar.
                job["progress"] = max(job["progress"], round(min(max(pct, 0.0), 1.0), 4))
                job["message"] = message[:300]

    def run() -> None:
        cancel.set_current_job(job_id)
        is_reader = kind in READER_KINDS
        holds_gate = False
        try:
            if use_model_lock:
                if is_reader:
                    GPU_GATE.acquire_read()
                else:
                    GPU_GATE.acquire_write()
                holds_gate = True

            # Cancelled while queued behind the gate: bail before any work.
            cancel.raise_if_cancelled(job_id)
            with _lock:
                _jobs[job_id]["status"] = "running"
                _jobs[job_id]["message"] = "running"

            result = fn(progress)
            with _lock:
                _jobs[job_id].update(
                    status="done",
                    progress=1.0,
                    message="done",
                    result=result,
                    finished_at=_now(),
                )
            log.info("job finished", extra={"job_id": job_id})
        except cancel.JobCancelled:
            with _lock:
                _jobs[job_id].update(status="cancelled", message="cancelled", finished_at=_now())
            log.info("job cancelled", extra={"job_id": job_id})
        except Exception as error:  # noqa: BLE001 - job errors are reported, not raised
            with _lock:
                _jobs[job_id].update(
                    status="error",
                    error=f"{type(error).__name__}: {error}",
                    message=traceback.format_exc()[-1500:],
                    finished_at=_now(),
                )
            log.warning("job failed", extra={"job_id": job_id})
        finally:
            if holds_gate:
                if is_reader:
                    GPU_GATE.release_read()
                else:
                    GPU_GATE.release_write()
            cancel.clear_job(job_id)
            cancel.set_current_job(None)

    threading.Thread(target=run, name=f"job-{kind}", daemon=True).start()
    return job_id


def cancel_job(job_id: str) -> bool:
    """False when the job is unknown or already finished."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job["status"] in ("done", "error", "cancelled"):
            return False
        job["message"] = "cancelling"
    cancel.request_cancel(job_id)
    return True


def get_job(job_id: str) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    with _lock:
        rows = sorted(_jobs.values(), key=lambda j: j["created_at"], reverse=True)
        return [dict(job) for job in rows[:limit]]


def reset_for_tests() -> None:
    with _lock:
        _jobs.clear()
