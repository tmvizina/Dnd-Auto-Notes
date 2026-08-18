import { describe, expect, it, vi } from "vitest";
import { openDb, recordStageRun, upsertSession } from "@dnd/core";
import type { RunEvent } from "../../shared/contracts.js";
import { RunManager } from "./manager.js";

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function eventTypes(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("RunManager", () => {
  it("assigns contiguous sequences and synthesises completion", async () => {
    const manager = new RunManager({ now: () => 1_000, nowIso: () => "2026-01-01T00:00:00.000Z" });
    const seen: RunEvent[] = [];
    const gate = deferred();
    const handle = manager.run({
      runId: "run-sequence",
      sessionId: "session-a",
      stages: ["intake"],
      producer: async (context) => {
        context.stageStarted("intake");
        context.stageProgress("intake", 0.5, "halfway");
        await gate.promise;
      },
    });
    const subscription = manager.subscribe({ runId: handle.runId }, (event) => seen.push(event));
    gate.release();

    const result = await handle.done;
    expect(eventTypes(seen)).toEqual(["stage_started", "stage_progress", "run_completed"]);
    expect(seen.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(result.snapshot.status).toBe("completed");
    expect(result.terminal.type).toBe("run_completed");
    expect(subscription.replay.map((event) => event.sequence)).toEqual([]);
    expect(manager.get(handle.runId).terminal?.type).toBe("run_completed");
    expect(manager.unsubscribe(subscription.subscriptionId)).toBe(true);
  });

  it("registers live delivery before replay and reports truncation", async () => {
    const gate = deferred();
    let injected = false;
    const manager = new RunManager({
      replayLimit: 2,
      beforeReplaySnapshot: (runId) => {
        if (injected) return;
        injected = true;
        manager.emit(runId, { type: "log", level: "info", message: "race" });
      },
    });
    const handle = manager.run({
      runId: "run-replay",
      sessionId: "session-a",
      producer: async (context) => {
        await gate.promise;
        context.emit({ type: "log", level: "info", message: "one" });
        context.emit({ type: "log", level: "info", message: "two" });
        context.emit({ type: "log", level: "info", message: "three" });
      },
    });
    const live: RunEvent[] = [];
    const first = manager.subscribe({ runId: handle.runId }, (event) => live.push(event));
    gate.release();
    await handle.done;

    expect(first.replay.map((event) => event.sequence)).toEqual([1]);
    expect(live.some((event) => event.type === "log" && event.message === "race")).toBe(true);
    const replay = manager.subscribe({ runId: handle.runId, cursor: 0 });
    expect(replay.replayTruncated).toBe(true);
    expect(replay.replay.map((event) => event.sequence)).toEqual([4, 5]);
    expect(replay.replayCursor).toBe(5);
  });

  it("propagates cancellation to registered sidecar and child handlers", async () => {
    const gate = deferred();
    let sidecarCancelled = false;
    const child = { kill: vi.fn(() => true) };
    const manager = new RunManager();
    const handle = manager.run({
      runId: "run-cancel",
      sessionId: "session-a",
      producer: async (context) => {
        context.onCancel(() => {
          sidecarCancelled = true;
        });
        context.registerChild(child);
        await gate.promise;
      },
    });

    await Promise.resolve();
    const cancellation = handle.cancel("user stopped the run");
    gate.release();
    await expect(cancellation).resolves.toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(sidecarCancelled).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    const result = await handle.done;
    expect(result.snapshot.status).toBe("cancelled");
    expect(result.terminal).toMatchObject({
      type: "run_failed",
      error: { code: "cancelled", message: "user stopped the run" },
    });
  });

  it("escalates an uncooperative child before the cancellation deadline", async () => {
    const child = { kill: vi.fn(() => true) };
    const manager = new RunManager({ cancellationTimeoutMs: 10 });
    const handle = manager.run({
      runId: "run-escalate",
      sessionId: "session-a",
      producer: async (context) => {
        context.registerChild(child);
        await new Promise<void>(() => undefined);
      },
    });
    await Promise.resolve();
    await expect(handle.cancel("deadline")).resolves.toBe(true);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await expect(handle.done).resolves.toMatchObject({ terminal: { type: "run_failed" } });
  });

  it("synthesises a stack-free failure when a producer throws", async () => {
    const manager = new RunManager();
    const events: RunEvent[] = [];
    const handle = manager.run({
      runId: "run-error",
      sessionId: "session-a",
      stages: ["intake"],
      producer: async (context) => {
        context.stageStarted("intake");
        throw new Error("fixture failed");
      },
    });
    manager.subscribe({ runId: handle.runId }, (event) => events.push(event));
    const result = await handle.done;
    expect(eventTypes(events)).toEqual(["stage_started", "stage_failed", "run_failed"]);
    expect(result.snapshot.status).toBe("failed");
    expect(result.terminal).toMatchObject({
      type: "run_failed",
      error: { code: "internal_error", message: "fixture failed" },
    });
    expect("stack" in result.terminal).toBe(false);
  });

  it("isolates concurrent run subscriptions and sequences", async () => {
    const manager = new RunManager();
    const gate = deferred();
    const a: RunEvent[] = [];
    const b: RunEvent[] = [];
    const runA = manager.run({
      runId: "run-a",
      sessionId: "session-a",
      producer: async (context) => {
        context.emit({ type: "log", level: "info", message: "a" });
        await gate.promise;
      },
    });
    const runB = manager.run({
      runId: "run-b",
      sessionId: "session-b",
      producer: async (context) => {
        context.emit({ type: "log", level: "info", message: "b" });
        await gate.promise;
      },
    });
    manager.subscribe({ runId: runA.runId }, (event) => a.push(event));
    manager.subscribe({ runId: runB.runId }, (event) => b.push(event));
    gate.release();
    await Promise.all([runA.done, runB.done]);

    expect(a.every((event) => event.runId === runA.runId)).toBe(true);
    expect(b.every((event) => event.runId === runB.runId)).toBe(true);
    expect(a.map((event) => event.sequence)).toEqual([1, 2]);
    expect(b.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("persists stage outcomes and resolves running rows after relaunch", async () => {
    const db = openDb(":memory:");
    try {
      upsertSession(db, {
        session_id: "session-ledger",
        title: "Ledger fixture",
        number: null,
        date: "2026-01-01",
        root_path: "fixture/session-ledger",
      });
      const manager = new RunManager({
        db,
        now: () => 2_000,
        nowIso: () => "2026-01-01T00:00:02.000Z",
      });
      const pendingGate = deferred();
      const pending = manager.run({
        runId: "run-pending",
        sessionId: "session-ledger",
        stages: ["align"],
        producer: async () => {
          await pendingGate.promise;
        },
      });
      const running = db
        .prepare("SELECT status FROM stage_runs WHERE session_id = ? AND stage = ?")
        .get("session-ledger", "align") as { status: string };
      expect(running.status).toBe("running");
      const cancellation = pending.cancel();
      pendingGate.release();
      await cancellation;
      await pending.done;

      const handle = manager.run({
        runId: "run-ledger",
        sessionId: "session-ledger",
        producer: async (context) => {
          context.stageStarted("intake", "2026-01-01T00:00:00.000Z");
        },
      });
      await handle.done;
      const completed = db
        .prepare(
          "SELECT status, skipped, finished_at FROM stage_runs WHERE session_id = ? AND stage = ?",
        )
        .get("session-ledger", "intake") as {
        status: string;
        skipped: number;
        finished_at: string | null;
      };
      expect(completed).toMatchObject({ status: "ok", skipped: 0 });
      expect(completed.finished_at).toBe("2026-01-01T00:00:02.000Z");

      recordStageRun(db, {
        session_id: "session-ledger",
        stage: "transcript",
        version: 1,
        status: "running",
        started_at: "2026-01-01T00:00:00.000Z",
      });
      new RunManager({ db });
      const interrupted = db
        .prepare("SELECT status, finished_at FROM stage_runs WHERE stage = ?")
        .get("transcript") as { status: string; finished_at: string | null };
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.finished_at).toEqual(expect.any(String));
    } finally {
      db.close();
    }
  });
});
