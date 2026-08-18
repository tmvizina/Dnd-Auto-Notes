---
id: P5-03
phase: 5
title: Packaging and sidecar distribution
status: todo
assignee: ""
depends_on: [P5-02]
scope:
  - electron-builder.yml
  - app/desktop/build/**
  - docs/packaging.md
estimate: L
commit: ""
---

## Why

A packaged Electron app is straightforward. A packaged Electron app that depends on a Python environment with torch in it is not, and that decision has been deferred to here on purpose — by now we know exactly which Python dependencies are actually required.

## Do

1. **Decide and document the sidecar distribution strategy**, with the trade-offs written down:
   - a first-run `uv` bootstrap that creates the venv on the user's machine (small installer, slow and network-dependent first run);
   - a bundled interpreter with pinned wheels (large installer, offline, painful to update);
   - a hybrid — bundle the pure-Python core, bootstrap the model stack on demand.
     Recommendation up front, evidence after.
2. Build dmg (arm64) and nsis (x64). Notarisation for macOS is out of scope for a personal build; document what would be needed.
3. `asarUnpack` native modules; explicit `electron-rebuild` for `better-sqlite3` against the pinned Electron ABI.
4. Verify the packaged bundle excludes test fixtures, the deterministic fake runner, and any development-only code, by inspecting the built asar.
5. First-run experience: no session, no campaign, no models. The app must explain what to do next rather than showing an empty screen or an error.
6. Model downloads happen on demand with visible progress and a stated size, never silently at install time.

## Acceptance

- [ ] The decision is documented with its trade-offs and a recommendation.
- [ ] Installers build on both platforms from a clean checkout.
- [ ] Asar inspection confirms fixtures and the fake runner are absent.
- [ ] A fresh machine reaches a working pipeline following only the in-app instructions.
- [ ] Model download shows size and progress and is cancellable.
- [ ] The installed app runs with no development toolchain present.
