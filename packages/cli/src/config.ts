import { join, resolve } from "node:path";
import { findRepoRoot } from "@dnd/core";

export const DEFAULT_SIDECAR_PORT = 8477;

/** Where a value came from, so `pipeline config` can explain itself. */
export type ConfigSource = "env" | "default";

export interface ResolvedValue<T> {
  readonly value: T;
  readonly source: ConfigSource;
}

export interface ResolvedConfig {
  /** Null when the CLI is run from outside a checkout. */
  readonly repoRoot: string | null;
  readonly cwd: string;
  readonly sessionsRoot: ResolvedValue<string>;
  readonly campaignRoot: ResolvedValue<string>;
  readonly sidecarPort: ResolvedValue<number>;
  readonly nodeVersion: string;
}

function fromEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function resolvePath(
  envName: string,
  fallbackBase: string,
  fallbackLeaf: string,
): ResolvedValue<string> {
  const override = fromEnv(envName);
  if (override !== undefined) return { value: resolve(override), source: "env" };
  return { value: join(fallbackBase, fallbackLeaf), source: "default" };
}

function resolvePort(): ResolvedValue<number> {
  const override = fromEnv("DND_SIDECAR_PORT");
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      return { value: parsed, source: "env" };
    }
    // An unusable override is reported as the default rather than crashing the
    // CLI before it can print anything useful; `pipeline config` shows both.
  }
  return { value: DEFAULT_SIDECAR_PORT, source: "default" };
}

export function resolveConfig(cwd: string = process.cwd()): ResolvedConfig {
  const repoRoot = findRepoRoot(cwd);
  const base = repoRoot ?? cwd;
  return {
    repoRoot,
    cwd,
    sessionsRoot: resolvePath("DND_SESSIONS_ROOT", base, "sessions"),
    campaignRoot: resolvePath("DND_CAMPAIGN_ROOT", base, "campaign"),
    sidecarPort: resolvePort(),
    nodeVersion: process.versions.node,
  };
}

export function formatConfig(config: ResolvedConfig): string {
  const mark = (v: ResolvedValue<unknown>): string => (v.source === "env" ? " (env)" : "");
  return [
    `repo root     ${config.repoRoot ?? "(not inside a checkout)"}`,
    `working dir   ${config.cwd}`,
    `sessions      ${config.sessionsRoot.value}${mark(config.sessionsRoot)}`,
    `campaign      ${config.campaignRoot.value}${mark(config.campaignRoot)}`,
    `sidecar port  ${String(config.sidecarPort.value)}${mark(config.sidecarPort)}`,
    `node          v${config.nodeVersion}`,
  ].join("\n");
}
