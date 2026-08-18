---
id: P0-02
phase: 0
title: Vitest, pytest, lint and format
status: done
assignee: "orchestrator"
depends_on: [P0-01]
scope:
  - vitest.config.mjs
  - eslint.config.js
  - .prettierrc
  - sidecar/pyproject.toml
  - sidecar/README.md
  - sidecar/tests/**
estimate: S
commit: "06dd168"
---

## Why

Tests are part of every ticket's definition of done, so the harness must exist before the first real ticket. A worker forced to invent a test setup invents a different one each time.

## Do

1. One root `vitest.config.mjs`, `environment: "node"`, including `packages/**/src/**/*.test.ts`, `app/**/src/**/*.test.{ts,tsx}`, `test/**`.
2. ESLint flat config plus Prettier; `npm run lint`, `npm run format:check`.
3. `sidecar/pyproject.toml` managed by `uv`: `fastapi`, `uvicorn`, `pydantic>=2`, `numpy`, `soundfile`; dev `pytest`, `ruff`. Model libraries stay commented out with install notes so the sidecar imports and starts on a machine with no models.
4. `sidecar/tests/test_smoke.py` asserting the app builds and `/health` responds.
5. Root scripts `test`, `test:py`, `test:all`.
6. `sidecar/README.md` documents `uv venv && uv pip install -e ".[dev]"`.

## Acceptance

- [x] `npm test` passes with at least one real assertion.
- [x] `npm run test:py` passes with no model package installed.
- [x] `npm run lint` is clean.
- [x] Neither suite needs network access.

## Verify

```bash
npm test && npm run lint && npm run test:py
```

## Delivered

`npm test` — 19 tests across 3 files (`findRepoRoot`, CLI argument handling, config resolution). `npm run test:py` — 10 passed, 1 skipped. `npm run lint` clean. `npx prettier --check .` clean.

Deviations, each deliberate:

- **`sidecar/dnd_sidecar/__init__.py` added, outside the stated scope.** The ticket's own step 3 asks for an installable `-e ".[dev]"` package, which hatchling cannot build without the package directory existing. Two lines and a docstring; P1-01 fills in the rest.
- **The `/health` assertion is `pytest.importorskip`-guarded.** The ticket asks the smoke test to assert `/health` responds, but the FastAPI app is P1-01's deliverable. The test is written in full and skips with a reason until then, rather than being omitted and forgotten.
- **`uv` is preferred, not required.** `uv` is not installed on the dev box and installing machine-wide software needs the human's say-so. `tools/run-pytest.mjs` uses `uv` when present and falls back to a virtualenv at `sidecar/.venv`; `tools/setup-sidecar.mjs` creates that environment with whichever 3.11+ interpreter it finds. The documented `uv` path in `sidecar/README.md` is unchanged.
- **Prettier does not run against Markdown in this commit's scope.** Formatting the existing docs is a 63-file reflow unrelated to test tooling, so it lands as its own commit immediately after.

Two things worth remembering, both caught by running the tools rather than reading them:

- **Vitest resolved `@dnd/core` to `dist/`, so the suite was testing the last build.** It passed against a stale build and failed the moment `dist` was removed. The config now sets `resolve.conditions` (and the `ssr` equivalent) to the `@dnd/source` condition, so tests always run against the working tree.
- **`spawnSync(..., { shell: true })` splits a `python -c` payload on spaces**, turning every interpreter probe into a `SyntaxError`. `py.exe` and `python.exe` are real executables and need no shell; the Python tooling now spawns them directly.
