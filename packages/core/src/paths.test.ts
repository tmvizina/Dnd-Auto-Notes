import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "./paths.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "dnd-paths-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("findRepoRoot", () => {
  it("finds the root from a nested directory", () => {
    const root = join(scratch, "repo");
    const nested = join(root, "packages", "core", "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));

    expect(findRepoRoot(nested)).toBe(root);
  });

  it("ignores a workspace package.json that declares no workspaces", () => {
    const root = join(scratch, "repo");
    const pkg = join(root, "packages", "core");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@dnd/core" }));

    // The nearest package.json is the package's own; the root is still correct.
    expect(findRepoRoot(pkg)).toBe(root);
  });

  it("returns null outside any repository", () => {
    const bare = join(scratch, "not-a-repo");
    mkdirSync(bare, { recursive: true });

    expect(findRepoRoot(bare)).toBeNull();
  });

  it("survives an unreadable or malformed package.json", () => {
    const root = join(scratch, "repo");
    const nested = join(root, "sub");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), "{ this is not json");
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));

    expect(findRepoRoot(nested)).toBe(root);
  });
});
