---
id: P0-01
phase: 0
title: Repo scaffold, workspaces, TypeScript
status: done
assignee: "orchestrator"
depends_on: []
scope:
  - package.json
  - tsconfig.base.json
  - .gitignore
  - packages/core/**
  - packages/cli/**
estimate: M
commit: ""
---

## Why
Nothing else can be built or tested until the workspace layout, module system and TypeScript settings are fixed. Getting this wrong later means touching every package.

## Do
1. Root `package.json`: private, `"type": "module"`, npm workspaces `["packages/core", "packages/cli", "app/desktop", "app/ui"]`. Only create `packages/*` now; the `app/*` entries land in phase 4 and an absent workspace is tolerated.
2. Scripts: `typecheck`, `test`, `build`, `lint`, `format`, `pipeline` (delegates to `packages/cli`), `session:new`.
3. `tsconfig.base.json`: ES2022, NodeNext module + resolution, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`. Each workspace extends it and adds its own `tsconfig.build.json` with `outDir`/`rootDir`.
4. `packages/core` (`@dnd/core`) and `packages/cli` (`@dnd/cli`), each `src/index.ts` building to `dist/`, with an `exports` map.
5. `.gitignore`: `node_modules`, `dist`, `.venv`, `sessions/*/input/`, `sessions/*/media/`, `*.wav`, `*.flac`, `*.mp3`, `*.db*`, `sessions/*/session.pdf`.
6. Pin Node 22 in `engines` plus `.nvmrc`.
7. `packages/cli` exposes a `pipeline` bin stub that prints its resolved config and exits 0.

## Acceptance
- [x] `npm install` succeeds on a clean checkout on macOS and Windows.
- [x] `npm run typecheck` passes with zero errors.
- [x] `npm run build` emits `packages/*/dist`.
- [x] `npx pipeline --help` prints usage.
- [x] No workspace imports another by relative path, only by package name.

## Verify
```bash
npm install && npm run typecheck && npm run build && npx pipeline --help
```

## Notes
Mirror the workspace + ESM setup in `Manuscript-Work/package.json`, including its Windows-explicit `npm.cmd` in fan-out scripts.

## Delivered

Deviations from the Do list, each deliberate:

- **`npm`, not `npm.cmd`, in fan-out scripts.** The Notes said to mirror Manuscript-Work's Windows-explicit `npm.cmd`. That repo is Windows-only; this one targets macOS first, where `npm.cmd` does not exist. Plain `npm` works on both.
- **`workspaces` uses globs (`packages/*`, `app/*`) rather than literal paths.** A literal path to an absent directory is an install error; a glob that matches nothing is not. Same effect once phase 4 creates `app/*`.
- **`engines.node` is `>=22`, `.nvmrc` pins `22`.** The dev box runs Node 24. A hard `22.x` pin would reject it for no benefit; `.nvmrc` still declares 22 as the target for CI and contributors.
- **Build uses TypeScript project references (`tsc -b`), not `npm run build --workspaces`.** npm runs workspace scripts alphabetically, so `@dnd/cli` built before `@dnd/core` and failed to resolve it. Project references order themselves by dependency.
- **`@dnd/core` exposes `./src/index.ts` under a `@dnd/source` custom condition.** Lets `typecheck` run against source without a prior build, while Node still resolves `dist` at runtime. The `tsconfig.build.json` files clear the condition so emit resolves to `dist` and `rootDir` stays valid.
- **`@dnd/cli` is a root devDependency, and its `bin` points at a committed `bin/pipeline.mjs` launcher.** npm only links a workspace bin when something depends on that workspace; without both changes `npx pipeline` was not on PATH after a clean install.

Verified from a clean checkout (`rm -rf node_modules package-lock.json packages/*/dist`): install, typecheck, build, and `npx pipeline --help` all succeed. `pipeline config` resolves correctly from inside and outside the repo; unknown commands exit 2, unimplemented commands exit 1.
