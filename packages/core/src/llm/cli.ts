import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeNdjson } from "./normalize.js";
import {
  LlmResponseError,
  LlmUnavailableError,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProvider,
} from "./provider.js";

const execFileAsync = promisify(execFile);
const resolutionCache = new Map<string, string | null>();

export interface CliProviderOptions {
  readonly executable?: string;
  readonly permissionMode?: string;
  readonly resolve?: (name: string) => Promise<string | null>;
  readonly verify?: (executable: string) => Promise<boolean>;
  readonly spawnProcess?: typeof spawn;
  readonly cancellationTimeoutMs?: number;
}

async function defaultVerify(executable: string): Promise<boolean> {
  try {
    await execFileAsync(executable, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCliExecutable(
  name: "claude" | "codex",
  resolver?: (name: string) => Promise<string | null>,
  verify: (executable: string) => Promise<boolean> = defaultVerify,
): Promise<string | null> {
  const cached = resolutionCache.get(name);
  if (cached !== undefined) return cached;
  const candidates =
    platform() === "win32"
      ? [join(process.env["APPDATA"] ?? "", "npm", `${name}.cmd`), `${name}.cmd`]
      : [join(homedir(), ".local", "bin", name), name];
  const custom =
    resolver ??
    (async (command: string) => {
      try {
        const result = await execFileAsync(platform() === "win32" ? "where.exe" : "which", [
          command,
        ]);
        return (
          result.stdout
            .split(/\r?\n/u)
            .find((line) => line.trim() !== "")
            ?.trim() ?? null
        );
      } catch {
        return null;
      }
    });
  for (const candidate of candidates) {
    const found = await custom(candidate);
    if (found !== null && (await verify(found))) {
      resolutionCache.set(name, found);
      return found;
    }
  }
  resolutionCache.set(name, null);
  return null;
}

export class CliProvider implements LlmProvider {
  constructor(
    private readonly name: "claude" | "codex",
    private readonly options: CliProviderOptions = {},
  ) {}
  async capabilities(): Promise<{
    readonly available: boolean;
    readonly provider: string;
    readonly reason?: string;
  }> {
    const executable =
      this.options.executable ??
      (await resolveCliExecutable(this.name, this.options.resolve, this.options.verify));
    return executable === null
      ? {
          available: false,
          provider: `cli-${this.name}`,
          reason: `${this.name} executable was not found`,
        }
      : {
          available: true,
          provider: `cli-${this.name}:${this.options.permissionMode ?? "default"}:${executable}`,
        };
  }
  async complete<T>(request: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
    if (request.signal?.aborted)
      throw new LlmUnavailableError(`cli-${this.name}`, "language model request cancelled");
    const executable =
      this.options.executable ??
      (await resolveCliExecutable(this.name, this.options.resolve, this.options.verify));
    if (executable === null)
      throw new LlmUnavailableError(`cli-${this.name}`, `${this.name} executable was not found`);
    const args =
      this.name === "claude"
        ? [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            this.options.permissionMode ?? "default",
          ]
        : ["exec", "--json"];
    const child = (this.options.spawnProcess ?? spawn)(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let rejectResult: ((error: Error) => void) | undefined;
    const kill = (): void => {
      if (closed) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (closed) return;
        child.kill("SIGKILL");
        rejectResult?.(
          new LlmUnavailableError(`cli-${this.name}`, "language model request cancelled"),
        );
      }, this.options.cancellationTimeoutMs ?? 2_000);
    };
    request.signal?.addEventListener("abort", kill, { once: true });
    child.stdin.write(`${request.system}\n\n${request.prompt}`);
    child.stdin.end();
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    let result: { code: number | null; output: string };
    try {
      result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        rejectResult = reject;
        child.on("error", reject);
        child.on("close", (code) => {
          closed = true;
          resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
        });
      });
    } finally {
      if (escalation !== undefined) clearTimeout(escalation);
      request.signal?.removeEventListener("abort", kill);
    }
    if (request.signal?.aborted)
      throw new LlmUnavailableError(`cli-${this.name}`, "language model request cancelled");
    if (result.code !== 0)
      throw new LlmResponseError(`${this.name} exited with code ${String(result.code)}`);
    const normalized = normalizeNdjson(result.output);
    if (normalized.result === null)
      throw new LlmResponseError(
        normalized.malformed > 0
          ? "CLI stream contained no valid result"
          : "CLI stream contained no result",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized.result);
    } catch {
      throw new LlmResponseError("CLI result was not JSON");
    }
    const checked = request.schema.safeParse(parsed);
    if (!checked.success) throw new LlmResponseError("CLI result failed the requested schema");
    return { value: checked.data };
  }
}
