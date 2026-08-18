---
id: P1-01
phase: 1
title: Python sidecar skeleton and job registry
status: approved
assignee: "orchestrator"
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

- [x] `uvicorn dnd_sidecar.server:app` starts with zero model packages installed.
- [x] `/health` reports every capability as false on a bare env and never 500s.
- [x] A test job reports monotonic progress, completes, and its result is retrievable.
- [x] Cancelling a running job moves it to `cancelled` within one progress checkpoint.
- [x] Two light jobs run concurrently; a heavy job excludes everything else.
- [x] The sidecar opens no database and no file outside the paths passed to it.

## Verify

```bash
cd sidecar && uv run pytest -q
```

## Delivered

`sidecar/dnd_sidecar/` — `server.py` (FastAPI), `jobs.py` (registry + readers-writer GPU gate, ported from Audio Forge's worker), `cancel.py` (cooperative cancellation plus subprocess termination), `capabilities.py` (the `/health` probe) and `logging_setup.py` (JSON logs carrying the job id). 26 Python tests, up from 11.

`/health` is a capability probe rather than a liveness ping, and it is written so it cannot fail: every optional import is a lazy `find_spec` inside `try/except`, and the endpoint itself catches anything the probe throws and downgrades to `status: "degraded"`. A `/health` that 500s tells the supervisor nothing it can act on.

Two notes:

- **The gate distinguishes readers from writers.** Heavy work (`transcribe`, `embed`) is exclusive because two Whisper models will not fit twice; light work (`probe`, `score`, `vad`) runs concurrently up to `DND_JOB_CONCURRENCY`. Both properties are tested with real threads and a semaphore rather than asserted — a reader pair is proven to overlap, and a reader is proven to be held at the gate while a writer holds it.
- **Progress is monotonic by construction.** A stage that recomputes a fraction must never appear to go backwards in a progress bar, so `progress()` takes the max. Tested by feeding it 0.5, 0.2, 0.9 in that order.

Ruff caught a silent `except: pass` in device detection. It was intentional — no torch means cpu — but a quietly swallowed error is exactly what `AGENTS.md` warns against, so it now logs at debug level, which keeps a _broken_ torch install diagnosable instead of invisible.

The `/health` assertion in `test_smoke.py`, which `P0-02` left guarded by `importorskip` until this ticket, now runs.

Verified beyond the unit tests: a real uvicorn server was started on a spare port and `GET /health` returned `status: ok`, `device: cpu`, and every model capability false on this bare environment — which is the property the whole opt-in dependency split exists to guarantee.
