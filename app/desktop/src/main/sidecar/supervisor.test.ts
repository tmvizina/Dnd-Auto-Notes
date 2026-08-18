import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SidecarError, type HealthReport, type SidecarClient, type SidecarRecord } from "@dnd/core";
import {
  DesktopSidecarSupervisor,
  restartDelay,
  type CoreSidecarSupervisorLike,
} from "./supervisor.js";

const record = (ownedByUs: boolean, port = 8477): SidecarRecord => ({
  pid: ownedByUs ? 1234 : null,
  port,
  version: "test",
  startedAt: "2026-01-01T00:00:00.000Z",
  ownedByUs,
});

const healthy = (): HealthReport => ({
  status: "ok",
  version: "test",
  capabilities: {},
});

class FakeClient {
  healthCalls = 0;
  readonly healthResults: Array<HealthReport | Error> = [];
  runResult: unknown = { ok: true };
  runPending = false;

  async health(): Promise<HealthReport> {
    this.healthCalls += 1;
    const next = this.healthResults.shift();
    if (next instanceof Error) throw next;
    return next ?? healthy();
  }

  async runJob<T>(): Promise<T> {
    if (this.runPending) return new Promise<T>(() => undefined);
    return this.runResult as T;
  }
}

class FakeCore implements CoreSidecarSupervisorLike {
  owns: boolean;
  ensureCalls = 0;
  stopCalls = 0;
  readonly records: SidecarRecord[];
  readonly fakeClient: FakeClient;
  ensureError: Error | null = null;
  ensurePromise: Promise<SidecarRecord> | null = null;

  constructor(ownedByUs = true, fakeClient = new FakeClient()) {
    this.owns = ownedByUs;
    this.records = [record(ownedByUs)];
    this.fakeClient = fakeClient;
  }

  async ensureRunning(): Promise<SidecarRecord> {
    this.ensureCalls += 1;
    if (this.ensureError !== null) throw this.ensureError;
    if (this.ensurePromise !== null) return this.ensurePromise;
    return this.records[Math.min(this.ensureCalls - 1, this.records.length - 1)]!;
  }

  client(): SidecarClient {
    return this.fakeClient as unknown as SidecarClient;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

const managers: DesktopSidecarSupervisor[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
});

function makeManager(
  core: FakeCore,
  extra: Record<string, unknown> = {},
): DesktopSidecarSupervisor {
  const manager = new DesktopSidecarSupervisor({
    repoRoot: process.cwd(),
    supervisor: core,
    activePollIntervalMs: 2,
    idlePollIntervalMs: 30,
    healthFailureThreshold: 1,
    restartBackoffMs: 5,
    restartBackoffMaxMs: 10,
    ...extra,
  });
  managers.push(manager);
  return manager;
}

describe("desktop sidecar supervision", () => {
  it("starts only on pipeline demand and publishes ready state", async () => {
    const core = new FakeCore();
    const manager = makeManager(core);
    const states: string[] = [];
    manager.onState((state) => states.push(state.status));

    expect(core.ensureCalls).toBe(0);
    await expect(manager.runJob("intake", {})).resolves.toEqual({ ok: true });

    expect(core.ensureCalls).toBe(1);
    expect(states).toEqual(["stopped", "starting", "ready"]);
  });

  it("surfaces an environment remedy without installing anything", async () => {
    const core = new FakeCore();
    core.ensureError = new SidecarError(
      "env_missing",
      "no Python environment for the sidecar",
      "cd sidecar && python3.12 -m venv .venv",
    );
    const manager = makeManager(core);
    const states: Array<{ status: string; setupCommand?: string }> = [];
    manager.onState((state) => states.push(state));

    await expect(manager.ensureRunning()).rejects.toMatchObject({ code: "env_missing" });
    expect(manager.state).toMatchObject({
      status: "unavailable",
      setupCommand: "cd sidecar && python3.12 -m venv .venv",
    });
    expect(states.at(-1)).toMatchObject({ status: "unavailable" });
    expect(core.stopCalls).toBe(0);
  });

  it("adopts an external sidecar and never terminates it", async () => {
    const core = new FakeCore(false);
    const manager = makeManager(core);

    await manager.ensureRunning();
    expect(manager.state).toMatchObject({ status: "ready", ownedByUs: false });
    await manager.stop();

    expect(core.stopCalls).toBe(0);
    expect(manager.state.status).toBe("stopped");
  });

  it("fails a running job when health goes down and schedules a capped restart", async () => {
    const client = new FakeClient();
    client.runPending = true;
    client.healthResults.push(healthy(), new Error("connection reset"));
    const core = new FakeCore(true, client);
    core.records.push(record(true, 8478));
    const manager = makeManager(core);

    await manager.ensureRunning();
    const run = manager.runJob("transcribe", {});
    await expect(run).rejects.toMatchObject({ code: "unhealthy" });
    expect(manager.state.status).toBe("unhealthy");

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(core.stopCalls).toBeGreaterThanOrEqual(1);
    expect(core.ensureCalls).toBeGreaterThanOrEqual(2);
    expect(manager.state.status).toBe("ready");
    expect(restartDelay(1, 5, 10)).toBe(5);
    expect(restartDelay(2, 5, 10)).toBe(10);
    expect(restartDelay(10, 5, 10)).toBe(10);
  });

  it("backs off health checks while idle", async () => {
    const client = new FakeClient();
    const core = new FakeCore(true, client);
    const manager = makeManager(core, { idlePollIntervalMs: 40 });

    await manager.ensureRunning();
    expect(client.healthCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(client.healthCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(client.healthCalls).toBeGreaterThanOrEqual(2);
  });

  it("returns only a bounded suffix of sidecar logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "dnd-desktop-sidecar-"));
    try {
      const logDir = join(root, "logs");
      const logPath = join(logDir, "sidecar.log");
      await mkdir(logDir, { recursive: true });
      await writeFile(logPath, "one\ntwo\nthree\nfour\n", "utf8");
      const manager = makeManager(new FakeCore(), { logDir });

      await expect(manager.getLogTail(2)).resolves.toEqual(["three", "four"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not publish ready after stop wins a pending startup", async () => {
    const core = new FakeCore();
    let release!: (value: SidecarRecord) => void;
    core.owns = false;
    core.ensurePromise = new Promise<SidecarRecord>((resolve) => {
      release = resolve;
    });
    const manager = makeManager(core);
    const start = manager.ensureRunning();
    await Promise.resolve();
    const stop = manager.stop();
    core.owns = true;
    release(record(true));

    await expect(start).rejects.toMatchObject({ code: "stopped" });
    await expect(stop).resolves.toBeUndefined();
    expect(manager.state.status).toBe("stopped");
    expect(core.stopCalls).toBe(1);
  });

  it("transitions to unavailable after the configured restart cap", async () => {
    const client = new FakeClient();
    client.runPending = true;
    client.healthResults.push(healthy(), new Error("connection reset"), new Error("still down"));
    const core = new FakeCore(true, client);
    const manager = makeManager(core, { maxRestartAttempts: 1, restartBackoffMs: 1 });

    await manager.ensureRunning();
    await expect(manager.runJob("transcribe", {})).rejects.toMatchObject({ code: "unhealthy" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.state.status).toBe("unavailable");
    expect(manager.state.reason).toContain("restart limit");
    expect(core.stopCalls).toBe(1);
  });

  it("waits for a started restart before stopping a late-owned child", async () => {
    const client = new FakeClient();
    client.healthResults.push(healthy(), new Error("connection reset"));
    client.runPending = true;
    const core = new FakeCore(true, client);
    let releaseRestart!: (value: SidecarRecord) => void;
    const pendingRestart = new Promise<SidecarRecord>((resolve) => {
      releaseRestart = resolve;
    });
    core.ensureRunning = async () => {
      core.ensureCalls += 1;
      return core.ensureCalls === 2 ? pendingRestart : record(true);
    };
    const originalStop = core.stop.bind(core);
    core.stop = async () => {
      await originalStop();
      core.owns = false;
    };
    const manager = makeManager(core, { restartBackoffMs: 0, healthFailureThreshold: 1 });

    await manager.ensureRunning();
    await expect(manager.runJob("transcribe", {})).rejects.toMatchObject({ code: "unhealthy" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(core.ensureCalls).toBeGreaterThanOrEqual(2);

    const stopping = manager.stop();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    core.owns = true;
    releaseRestart(record(true, 8478));
    await stopping;
    expect(core.stopCalls).toBe(2);
    expect(manager.state.status).toBe("stopped");
  });
});
