#!/usr/bin/env node
// Runs the sidecar suite through whichever Python the machine has: uv if it is
// installed (the documented path), else a virtualenv at sidecar/.venv. Anything
// else prints the setup commands rather than a stack trace.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sidecar = join(repoRoot, "sidecar");
const isWindows = process.platform === "win32";
const venvPython = join(sidecar, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");

function has(command) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

const passthrough = process.argv.slice(2);

let command;
let args;
if (has("uv")) {
  command = "uv";
  args = ["run", "--project", sidecar, "pytest", ...passthrough];
} else if (existsSync(venvPython)) {
  command = venvPython;
  args = ["-m", "pytest", ...passthrough];
} else {
  console.error(
    [
      "No Python environment for the sidecar.",
      "",
      "With uv (preferred):",
      '  cd sidecar && uv venv && uv pip install -e ".[dev]"',
      "",
      "Without uv:",
      isWindows
        ? '  cd sidecar && py -3.12 -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"'
        : '  cd sidecar && python3.12 -m venv .venv && .venv/bin/python -m pip install -e ".[dev]"',
      "",
      "See sidecar/README.md.",
    ].join("\n"),
  );
  process.exit(1);
}

const result = spawnSync(command, args, { cwd: sidecar, stdio: "inherit" });
process.exit(result.status ?? 1);
