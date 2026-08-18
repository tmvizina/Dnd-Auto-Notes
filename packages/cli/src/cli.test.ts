import { describe, expect, it } from "vitest";
import { CLI_VERSION, run } from "./cli.js";

describe("pipeline argument handling", () => {
  it("prints usage and exits 0 with no arguments", () => {
    const outcome = run([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("Usage:");
  });

  it.each(["--help", "-h", "help"])("prints usage for %s", (flag) => {
    const outcome = run([flag]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("pipeline <command> [options]");
  });

  it("prints the version", () => {
    expect(run(["--version"])).toEqual({ stdout: `${CLI_VERSION}\n`, exitCode: 0 });
  });

  it("prints resolved config for a known cwd", () => {
    const outcome = run(["config"], process.cwd());
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("sidecar port");
    expect(outcome.stdout).toContain("sessions");
  });

  it("names the delivering ticket for an unimplemented command, and fails", () => {
    const outcome = run(["notes", "--session", "s42"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("P3-08");
    expect(outcome.stdout).toContain("--session s42");
  });

  it("exits 2 on an unknown command and shows usage", () => {
    const outcome = run(["definitely-not-a-command"]);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toContain("Unknown command");
    expect(outcome.stdout).toContain("Usage:");
  });
});
