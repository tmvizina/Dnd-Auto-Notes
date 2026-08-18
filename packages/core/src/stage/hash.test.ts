import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashFile, hashFileIfPresent, hashParams } from "./hash.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dnd-hash-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("hashFile", () => {
  it("is stable and changes with a single byte", async () => {
    const path = join(dir, "a.txt");
    writeFileSync(path, "hello");
    const first = await hashFile(path);
    expect(await hashFile(path)).toBe(first);

    writeFileSync(path, "hellp");
    expect(await hashFile(path)).not.toBe(first);
  });

  it("returns null for an absent file instead of throwing", async () => {
    expect(await hashFileIfPresent(join(dir, "missing.txt"))).toBeNull();
  });
});

describe("hashParams", () => {
  it("ignores key order", () => {
    expect(hashParams({ a: 1, b: 2 })).toBe(hashParams({ b: 2, a: 1 }));
    expect(hashParams({ nested: { x: 1, y: 2 } })).toBe(hashParams({ nested: { y: 2, x: 1 } }));
  });

  it("respects array order, which is meaningful", () => {
    expect(hashParams([1, 2])).not.toBe(hashParams([2, 1]));
  });

  it("distinguishes values that stringify alike", () => {
    expect(hashParams({ a: 1 })).not.toBe(hashParams({ a: "1" }));
    expect(hashParams({ a: null })).not.toBe(hashParams({}));
  });

  it("treats an explicit undefined as absent", () => {
    expect(hashParams({ a: 1, b: undefined })).toBe(hashParams({ a: 1 }));
  });
});
