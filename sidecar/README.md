# Sidecar

Python service holding the models: VAD, ASR, utterance embeddings, and optional
audio adjudication. The Node side spawns and supervises it; it speaks HTTP on
`127.0.0.1:8477` by default.

**It never opens the SQLite database.** It reads audio paths, writes JSON, and
returns results. Node owns all persistence — that rule is what makes the sidecar
safe to restart at any moment.

## Setup

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
cd sidecar
uv venv
uv pip install -e ".[dev]"
```

No model packages are installed by this. The sidecar starts without them and
reports what is missing on `GET /health`; see the commented block in
`pyproject.toml` for the per-platform install lines.

### Without uv

`uv` is preferred but not required — any 3.11+ virtualenv at `sidecar/.venv`
works, and the test runner finds it:

```bash
py -3.12 -m venv .venv          # Windows
python3.12 -m venv .venv        # macOS / Linux
.venv/Scripts/python -m pip install -e ".[dev]"   # Windows
.venv/bin/python -m pip install -e ".[dev]"       # macOS / Linux
```

## Tests

From the repository root:

```bash
npm run test:py
```

The suite runs with no model packages installed and needs no network.
