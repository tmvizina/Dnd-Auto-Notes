---
id: P0-02
phase: 0
title: Vitest, pytest, lint and format
status: todo
assignee: ""
depends_on: [P0-01]
scope:
  - vitest.config.mjs
  - eslint.config.js
  - .prettierrc
  - sidecar/pyproject.toml
  - sidecar/README.md
  - sidecar/tests/**
estimate: S
commit: ""
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
- [ ] `npm test` passes with at least one real assertion.
- [ ] `npm run test:py` passes with no model package installed.
- [ ] `npm run lint` is clean.
- [ ] Neither suite needs network access.

## Verify
```bash
npm test && npm run lint && npm run test:py
```
