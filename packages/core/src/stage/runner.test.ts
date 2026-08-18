import { describe, expect, it } from "vitest";
import { runStage } from "./runner.js";
import type { FileIo } from "../session/io.js";
import type { Session } from "../session/session.js";

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("runStage cancellation", () => {
  it("waits for blocked work and never writes an artifact after abort", async () => {
    const gate = deferred();
    const controller = new AbortController();
    const writes: string[] = [];
    const io: FileIo = {
      mkdir: async () => undefined,
      writeFile: async (path) => {
        writes.push(path);
      },
      rename: async () => undefined,
      rm: async () => undefined,
    };
    const session = {
      paths: {
        root: "C:\\session",
        stageMeta: () => "C:\\session\\work\\stage.json",
        artifact: () => "C:\\session\\work\\artifact.json",
      },
    } as unknown as Session;
    const running = runStage(
      {
        session,
        stage: "blocked",
        version: 1,
        output: "manifest",
        inputs: [],
        force: true,
        signal: controller.signal,
        io,
      },
      async () => {
        await gate.promise;
        return { ok: true };
      },
    );
    await Promise.resolve();
    controller.abort();
    gate.release();
    await expect(running).rejects.toThrow("stage cancelled");
    expect(writes).toEqual([]);
  });
});
