import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SidecarClient } from "./client.js";
import type { HealthReport } from "./client.js";
import { SidecarError } from "./errors.js";

export const DEFAULT_PORT = 8477;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface SidecarRecord {
  pid: number | null;
  port: number;
  version: string | null;
  startedAt: string;
  /** False when we adopted a process someone else started. */
  ownedByUs: boolean;
}

export interface SupervisorOptions {
  /** Repository root; the sidecar lives at <repoRoot>/sidecar. */
  repoRoot: string;
  port?: number;
  /** Where sidecar.json and logs live. Defaults to <repoRoot>/.dnd. */
  stateDir?: string;
  startTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function commandExists(command: string): boolean {
  // No shell: a shell splits arguments on spaces and turns a probe into a
  // syntax error. These are real executables.
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * How to run Python. `uv` is the documented path; a virtualenv at
 * `sidecar/.venv` is the fallback so a machine without uv is not blocked.
 * Installing uv is machine-wide software and needs a human's say-so, so this
 * never installs anything — it reports the exact command.
 */
export function resolveLauncher(sidecarDir: string): {
  kind: "uv" | "venv";
  command: string;
  args: string[];
} {
  const python = join(sidecarDir, ".venv", isWindows() ? "Scripts/python.exe" : "bin/python");
  if (existsSync(python)) {
    // An existing environment is mandatory. `uv run` is intentionally not
    // used here because it may create/sync a missing environment implicitly.
    return { kind: "venv", command: python, args: [] };
  }
  const remedy = commandExists("uv")
    ? 'cd sidecar && uv venv .venv && uv pip install -e ".[dev]"'
    : isWindows()
      ? 'cd sidecar && py -3.12 -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"'
      : 'cd sidecar && python3.12 -m venv .venv && .venv/bin/python -m pip install -e ".[dev]"';
  throw new SidecarError("env_missing", "no Python environment for the sidecar", remedy);
}

/** Resolves the port to try: explicit option, then env, then the default. */
export function resolvePort(
  option: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (option !== undefined) return option;
  const raw = env["DND_SIDECAR_PORT"];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}

function rotateLog(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // A log we cannot rotate is not a reason to refuse to start.
  }
}

/**
 * Starts the sidecar if it is not already running, and adopts it if it is.
 *
 * Adoption matters: a developer running `uvicorn --reload` in a terminal must
 * not have it killed or duplicated by the app. We never terminate a process we
 * did not start.
 */
export class SidecarSupervisor {
  private child: ChildProcess | null = null;
  private record: SidecarRecord | null = null;
  private readonly sidecarDir: string;
  private readonly stateDir: string;

  constructor(private readonly options: SupervisorOptions) {
    this.sidecarDir = join(options.repoRoot, "sidecar");
    this.stateDir = options.stateDir ?? join(options.repoRoot, ".dnd");
  }

  get recordPath(): string {
    return join(this.stateDir, "sidecar.json");
  }

  get logPath(): string {
    return join(this.stateDir, "logs", "sidecar.log");
  }

  /** True when this supervisor started the process it is talking to. */
  get owns(): boolean {
    return this.record?.ownedByUs === true;
  }

  client(port: number): SidecarClient {
    return new SidecarClient(`http://127.0.0.1:${String(port)}`);
  }

  private async probe(port: number): Promise<HealthReport | null> {
    try {
      return await this.client(port).health();
    } catch {
      return null;
    }
  }

  async ensureRunning(): Promise<SidecarRecord> {
    if (this.record !== null && (await this.probe(this.record.port)) !== null) {
      return this.record;
    }

    const wanted = resolvePort(this.options.port, this.options.env ?? process.env);

    // Adopt anything already answering there rather than starting a rival.
    const existing = await this.probe(wanted);
    if (existing !== null) {
      this.record = {
        pid: null,
        port: wanted,
        version: existing.version ?? null,
        startedAt: new Date().toISOString(),
        ownedByUs: false,
      };
      await this.writeRecord();
      return this.record;
    }

    return this.start(wanted);
  }

  private async start(preferredPort: number): Promise<SidecarRecord> {
    const launcher = resolveLauncher(this.sidecarDir);
    const port = preferredPort;

    mkdirSync(join(this.stateDir, "logs"), { recursive: true });
    rotateLog(this.logPath);
    const logStream = createWriteStream(this.logPath, { flags: "a" });

    const child = spawn(
      launcher.command,
      [
        ...launcher.args,
        "-m",
        "uvicorn",
        "dnd_sidecar.server:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--log-level",
        "warning",
      ],
      {
        cwd: this.sidecarDir,
        env: { ...process.env, ...this.options.env, DND_SIDECAR_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    this.child = child;

    const timeout = this.options.startTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    let exitCode: number | null = null;
    child.once("exit", (code) => {
      exitCode = code ?? -1;
    });

    while (Date.now() < deadline) {
      const health = await this.probe(port);
      if (health !== null) {
        this.record = {
          pid: child.pid ?? null,
          port,
          version: health.version ?? null,
          startedAt: new Date().toISOString(),
          ownedByUs: true,
        };
        await this.writeRecord();
        return this.record;
      }
      if (exitCode !== null) {
        throw new SidecarError(
          "start_failed",
          `sidecar exited with code ${String(exitCode)} before answering /health. See ${this.logPath}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    child.kill();
    throw new SidecarError(
      "start_failed",
      `sidecar did not answer /health within ${String(timeout)}ms. See ${this.logPath}`,
    );
  }

  private async writeRecord(): Promise<void> {
    if (this.record === null) return;
    mkdirSync(this.stateDir, { recursive: true });
    await writeFile(this.recordPath, `${JSON.stringify(this.record, null, 2)}\n`, "utf8");
  }

  async readRecord(): Promise<SidecarRecord | null> {
    if (!existsSync(this.recordPath)) return null;
    try {
      return JSON.parse(await readFile(this.recordPath, "utf8")) as SidecarRecord;
    } catch {
      return null;
    }
  }

  /**
   * SIGTERM, then SIGKILL after a grace period. Never touches an adopted
   * process: killing the terminal the developer is watching would be rude and
   * is not ours to do.
   */
  async stop(graceMs = 5000): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null) {
      this.child = null;
      this.record = null;
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });

    child.kill("SIGTERM");
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!stopped) {
      child.kill("SIGKILL");
      await exited;
    }

    this.child = null;
    this.record = null;
  }
}
