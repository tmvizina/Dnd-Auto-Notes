import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "..", "..");
const rendererRoot = join(desktopRoot, "renderer");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const viteCli = join(repositoryRoot, "node_modules", "vite", "bin", "vite.js");
const electronCli = join(repositoryRoot, "node_modules", "electron", "cli.js");
const rendererUrl = "http://127.0.0.1:5173/";

function runBuildStep(script) {
  const result = spawnSync(npmCommand, ["run", script], {
    cwd: desktopRoot,
    stdio: "inherit",
    // Windows cannot execute npm.cmd directly with shell disabled.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function waitForRenderer(server) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error("Vite exited before becoming ready");
    try {
      const response = await fetch(rendererUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite did not become ready at ${rendererUrl}`);
}

if (!existsSync(viteCli)) throw new Error(`Vite CLI not found: ${viteCli}`);
if (!existsSync(electronCli)) throw new Error(`Electron CLI not found: ${electronCli}`);

// Compile the privileged processes before starting the renderer server. The
// renderer itself is served directly by Vite so edits are visible on reload.
runBuildStep("build:main");
runBuildStep("build:preload");

const vite = spawn(
  process.execPath,
  [viteCli, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  {
    cwd: rendererRoot,
    stdio: "inherit",
    shell: false,
  },
);

let electron = null;
let shuttingDown = false;
const stop = (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  vite.kill();
  electron?.kill();
  process.exit(exitCode);
};

process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));

try {
  await waitForRenderer(vite);
  electron = spawn(process.execPath, [electronCli, "."], {
    cwd: desktopRoot,
    env: { ...process.env, VITE_DEV_SERVER_URL: rendererUrl },
    stdio: "inherit",
    shell: false,
  });
  electron.once("exit", (code, signal) => {
    if (shuttingDown) return;
    stop(code ?? (signal ? 1 : 0));
  });
  vite.once("exit", (code) => {
    if (!shuttingDown && code !== 0) stop(code ?? 1);
  });
} catch (error) {
  console.error(error);
  stop(1);
}
