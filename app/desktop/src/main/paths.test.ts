import { describe, expect, it } from "vitest";
import { getPackagedResourcePath, getUserDataPaths } from "./paths.js";

describe("desktop paths", () => {
  it("creates the documented user-data layout", () => {
    expect(getUserDataPaths("./profile")).toEqual({
      userData: expect.stringMatching(/[\\/]profile$/),
      data: expect.stringMatching(/[\\/]profile[\\/]data$/),
      logs: expect.stringMatching(/[\\/]profile[\\/]logs$/),
      sessions: expect.stringMatching(/[\\/]profile[\\/]sessions$/),
    });
  });

  it("rejects traversal and rooted paths for packaged resources", () => {
    expect(getPackagedResourcePath("/resources/ui", "index.html")).toMatch(
      /[\\/]resources[\\/]ui[\\/]index\.html$/,
    );
    expect(getPackagedResourcePath("/resources/ui", "../secrets.txt")).toBeNull();
    expect(getPackagedResourcePath("/resources/ui", "..\\secrets.txt")).toBeNull();
    expect(getPackagedResourcePath("/resources/ui", "/etc/passwd")).toBeNull();
    expect(getPackagedResourcePath("/resources/ui", "")).toBeNull();
  });
});
