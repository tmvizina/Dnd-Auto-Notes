---
id: P1-01
phase: 1
title: Python sidecar skeleton and job registry
status: todo
assignee: ""
depends_on: [P0-02]
scope:
  - sidecar/dnd_sidecar/**
  - sidecar/tests/**
estimate: M
commit: ""
---

## Why
Everything model-shaped in phases 2 and 3 runs here. The contract — synchronous for pure logic, job-based for anything that loads a model — has to be settled before the first model lands, or half the endpoints end up blocking a four-hour request.

## Do
1. `sidecar/dnd_sidecar/server.py`: FastAPI app, `__version__`, bound to `127.0.0.1` on a port from `DND_SIDECAR_PORT` (default 8477).
2. `GET /health` returns a **capability probe**, not just `ok`: sidecar version, python version, `device` (`mps` | `cuda` | `cpu`), and a boolean per optional dependency (`mlx_whisper`, `faster_whisper`, `whisper_cpp`, `torch`, `speechbrain`, `ffmpeg`, `silero_vad`). Each probe is a lazy import in a try/except and must never raise.
3. `sidecar/dnd_sidecar/jobs.py`: port the job registry from `Audio-Forge-/worker/audioforge_worker/jobs.py` — `create_job(kind, fn, use_model_lock=True)` returning a job id immediately, one background thread per job, `progress(pct, msg)` callback, statuses `queued|running|done|error|cancelled`, and the readers/writer GPU gate (heavy jobs exclusive, light scoring jobs concurrent up to `DND_JOB_CONCURRENCY`).
4. `sidecar/dnd_sidecar/cancel.py`: cooperative cancellation — a flag checked at each `progress` call, plus subprocess termination for jobs that shell out.
5. Endpoints `GET /jobs/{job_id}`, `POST /jobs/{job_id}/cancel`, `GET /jobs`.
6. Fake backends behind `DND_FAKE_ASR=1` / `DND_FAKE_EMBED=1` so every downstream test runs with no models.
7. Structured JSON logging to stdout with the job id on every line.

## Acceptance
- [ ] `uvicorn dnd_sidecar.server:app` starts with zero model packages installed.
- [ ] `/health` reports every capability as false on a bare env and never 500s.
- [ ] A test job reports monotonic progress, completes, and its result is retrievable.
- [ ] Cancelling a running job moves it to `cancelled` within one progress checkpoint.
- [ ] Two light jobs run concurrently; a heavy job excludes everything else.
- [ ] The sidecar opens no database and no file outside the paths passed to it.

## Verify
```bash
cd sidecar && uv run pytest -q
```
