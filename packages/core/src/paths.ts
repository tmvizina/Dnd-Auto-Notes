import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Files that only ever appear at the repository root. `package.json` alone is
 * not enough — every workspace has one — so the root is identified by a
 * package.json that declares workspaces.
 */
const ROOT_MARKERS = ["AGENTS.md", ".git"] as const;

function declaresWorkspaces(packageJsonPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { workspaces?: unknown }).workspaces)
    );
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` to the repository root. Returns null rather than
 * throwing so callers can decide whether being outside the repo is an error;
 * the CLI, for instance, is expected to run from anywhere.
 */
export function findRepoRoot(startDir: string): string | null {
  let current = startDir;
  const { root } = parse(current);

  for (;;) {
    const packageJson = join(current, "package.json");
    if (existsSync(packageJson) && declaresWorkspaces(packageJson)) return current;
    if (ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) return current;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
