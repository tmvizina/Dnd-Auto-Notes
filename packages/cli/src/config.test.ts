import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { DEFAULT_SIDECAR_PORT, formatConfig, resolveConfig } from "./config.js";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("resolveConfig", () => {
  it("defaults the sidecar port and marks it as a default", () => {
    delete process.env["DND_SIDECAR_PORT"];
    const config = resolveConfig(process.cwd());
    expect(config.sidecarPort).toEqual({ value: DEFAULT_SIDECAR_PORT, source: "default" });
  });

  it("honours a valid port override and marks its source", () => {
    process.env["DND_SIDECAR_PORT"] = "9001";
    const config = resolveConfig(process.cwd());
    expect(config.sidecarPort).toEqual({ value: 9001, source: "env" });
    expect(formatConfig(config)).toContain("9001 (env)");
  });

  it.each(["0", "70000", "not-a-port", "  "])(
    "falls back to the default rather than crashing on port %j",
    (bad) => {
      process.env["DND_SIDECAR_PORT"] = bad;
      expect(resolveConfig(process.cwd()).sidecarPort).toEqual({
        value: DEFAULT_SIDECAR_PORT,
        source: "default",
      });
    },
  );

  it("resolves a relative sessions-root override to an absolute path", () => {
    process.env["DND_SESSIONS_ROOT"] = "./elsewhere";
    const config = resolveConfig(process.cwd());
    expect(config.sessionsRoot.source).toBe("env");
    expect(config.sessionsRoot.value).toMatch(/elsewhere$/);
    expect(config.sessionsRoot.value).not.toBe("./elsewhere");
    expect(config.databasePath.source).toBe("default");
    expect(config.databasePath.value).toMatch(/[\\/]data[\\/]notes\.db$/);
  });

  it("allows an explicit database path override", () => {
    process.env["DND_DATABASE_PATH"] = "./custom/notes.db";
    const config = resolveConfig(process.cwd());
    expect(config.databasePath).toEqual({
      value: resolve("./custom/notes.db"),
      source: "env",
    });
  });
});
