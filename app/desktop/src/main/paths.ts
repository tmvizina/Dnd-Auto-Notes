import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface DesktopUserDataPaths {
  userData: string;
  data: string;
  logs: string;
  sessions: string;
}

export interface UiRootOptions {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}

/** Resolve the stable on-disk layout without depending on the working directory. */
export function getUserDataPaths(userData: string): DesktopUserDataPaths {
  const root = resolve(userData);
  return {
    userData: root,
    data: join(root, "data"),
    logs: join(root, "logs"),
    sessions: join(root, "sessions"),
  };
}

/**
 * Resolve static renderer assets for both an installed app and an unpackaged
 * desktop launch. The packaged path is outside the asar so it can be served
 * through Electron's privileged protocol without exposing arbitrary files.
 */
export function getUiRoot(options: UiRootOptions): string {
  if (options.isPackaged) return resolve(options.resourcesPath, "ui");

  const appRoot = resolve(options.appPath);
  const candidates = [
    resolve(appRoot, "renderer"),
    resolve(appRoot, "dist", "renderer"),
    resolve(appRoot, "..", "ui", "dist"),
    resolve(appRoot, "..", "..", "app", "ui", "dist"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/**
 * Resolve a renderer request below its configured root. URL paths are kept
 * separate from filesystem paths so encoded traversal and Windows roots are
 * rejected before any file operation occurs.
 */
export function getPackagedResourcePath(
  resourcesPath: string,
  relativePath: string,
): string | null {
  if (!relativePath || relativePath.includes("\0")) return null;
  if (relativePath.includes("\\") || relativePath.startsWith("/") || isAbsolute(relativePath))
    return null;
  if (/^[a-zA-Z]:/.test(relativePath)) return null;

  const root = resolve(resourcesPath);
  const candidate = resolve(root, relativePath);
  const child = relative(root, candidate);
  if (child === ".." || child.startsWith(`..${sep}`) || child === "" || isAbsolute(child))
    return null;
  return candidate;
}
