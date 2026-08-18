"""FastAPI surface of the D&D Auto Notes sidecar.

Contract with the Node side:

* fast, pure-logic calls are synchronous (``/health``, ``/probe``);
* anything that touches a model runs as a job — POST returns ``{"job_id": ...}``
  and the caller polls ``GET /jobs/<id>`` for progress, result or error;
* **the sidecar never opens the SQLite database.** It reads audio paths, writes
  JSON, and returns results. Node owns all persistence, which is what makes
  this process safe to restart at any moment.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import __version__, capabilities, logging_setup
from .jobs import GPU_GATE, cancel_job, create_job, get_job, list_jobs

logging_setup.configure()
log = logging.getLogger(__name__)

app = FastAPI(title="dnd-sidecar", version=__version__)

DEFAULT_PORT = 8477


@app.get("/health")
def health() -> dict[str, Any]:
    """Capability probe, not just liveness.

    Never raises: a broken optional dependency has to be reportable, and a
    /health that 500s tells the supervisor nothing it can act on.
    """
    try:
        payload = capabilities.health()
    except Exception as error:
        log.exception("health probe failed")
        return {
            "status": "degraded",
            "version": __version__,
            "error": f"{type(error).__name__}: {error}",
            "capabilities": {},
        }
    payload["gpu_gate"] = GPU_GATE.state
    return payload


class ProbeRequest(BaseModel):
    paths: list[str] = Field(default_factory=list)


@app.post("/probe")
def probe(request: ProbeRequest) -> dict[str, Any]:
    """Cheap file facts. Synchronous because it loads no model."""
    results = []
    for path in request.paths:
        try:
            stat = os.stat(path)
            results.append({"path": path, "exists": True, "size_bytes": stat.st_size})
        except OSError as error:
            results.append({"path": path, "exists": False, "error": str(error)})
    return {"files": results}


class EchoRequest(BaseModel):
    """Exercises the whole job lifecycle without a model. Used by the tests and
    by the Node supervisor's readiness check."""

    steps: int = Field(default=3, ge=1, le=100)
    delay_ms: int = Field(default=0, ge=0, le=5000)
    kind: str = "probe"
    fail: bool = False


@app.post("/jobs/echo")
def start_echo(request: EchoRequest) -> dict[str, str]:
    import time

    def run(progress: Any) -> dict[str, Any]:
        for step in range(request.steps):
            progress((step + 1) / request.steps, f"step {step + 1}/{request.steps}")
            if request.delay_ms:
                time.sleep(request.delay_ms / 1000)
        if request.fail:
            raise RuntimeError("echo asked to fail")
        return {"steps": request.steps}

    return {"job_id": create_job(request.kind, run)}


@app.get("/jobs")
def jobs(limit: int = 50) -> dict[str, Any]:
    return {"jobs": list_jobs(limit)}


@app.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job {job_id}")
    return job


@app.post("/jobs/{job_id}/cancel")
def job_cancel(job_id: str) -> dict[str, Any]:
    if get_job(job_id) is None:
        raise HTTPException(status_code=404, detail=f"unknown job {job_id}")
    return {"job_id": job_id, "cancelling": cancel_job(job_id)}
