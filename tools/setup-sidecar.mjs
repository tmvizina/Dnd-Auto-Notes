#!/usr/bin/env node
// Creates the sidecar's Python environment. Prefers uv; falls back to the first
// interpreter on the machine that is new enough. Installs the base + dev deps
// only — model packages stay opt-in (see sidecar/pyproject.toml).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sidecar = join(repoRoot, "sidecar");
const isWindows = process.platform === "win32";
const MINIMUM = [3, 11];

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", ...options });
}

function versionOf(command, args) {
  // Spawned without a shell: a shell splits the -c payload on spaces and
  // every probe comes back as a SyntaxError.
  const probe = spawnSync(
    command,
    [...args, "-c", "import sys;print(sys.version_info[0],sys.version_info[1])"],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) return null;
  const [major, minor] = probe.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return major > MINIMUM[0] || (major === MINIMUM[0] && minor >= MINIMUM[1])
    ? [major, minor]
    : null;
}

if (spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0) {
  console.log("Using uv.");
  if (run("uv", ["venv"], { cwd: sidecar }).status !== 0) process.exit(1);
  process.exit(run("uv", ["pip", "install", "-e", ".[dev]"], { cwd: sidecar }).status ?? 1);
}

const candidates = isWindows
  ? [
      ["py", ["-3.13"]],
      ["py", ["-3.12"]],
      ["py", ["-3.11"]],
      ["python", []],
    ]
  : [
      ["python3.13", []],
      ["python3.12", []],
      ["python3.11", []],
      ["python3", []],
    ];

const found = candidates
  .map(([command, args]) => ({ command, args, version: versionOf(command, args) }))
  .find((c) => c.version !== null);

if (!found) {
  console.error(`No Python ${MINIMUM.join(".")}+ found. Install one, or install uv, then retry.`);
  process.exit(1);
}

console.log(`Using ${found.command} ${found.args.join(" ")} (Python ${found.version.join(".")}).`);
const venv = join(sidecar, ".venv");
if (!existsSync(venv)) {
  if (run(found.command, [...found.args, "-m", "venv", ".venv"], { cwd: sidecar }).status !== 0) {
    process.exit(1);
  }
}

const python = join(venv, isWindows ? "Scripts/python.exe" : "bin/python");
if (run(python, ["-m", "pip", "install", "--upgrade", "pip"], { cwd: sidecar }).status !== 0) {
  process.exit(1);
}
process.exit(run(python, ["-m", "pip", "install", "-e", ".[dev]"], { cwd: sidecar }).status ?? 1);
