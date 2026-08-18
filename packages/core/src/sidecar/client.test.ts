import { describe, expect, it, vi } from "vitest";
import { SidecarClient } from "./client.js";
import type { JobRecord } from "./client.js";
import type { SidecarError } from "./errors.js";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    job_id: "job_1",
    kind: "probe",
    status: "running",
    progress: 0,
    message: "running",
    result: null,
    error: null,
    created_at: "2026-08-16T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

/** A fetch stub that replays a scripted sequence of job states. */
function stubFetch(states: JobRecord[], extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let index = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path.replace(/^http:\/\/[^/]+/, "")}`);
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

    if (path.endsWith("/health"))
      return respond(extra["health"] ?? { status: "ok", capabilities: {} });
    if (path.endsWith("/cancel")) return respond({ cancelling: true });
    if (/\/jobs\/[a-z]+$/.test(path) && init?.method === "POST")
      return respond({ job_id: "job_1" });
    const state = states[Math.min(index, states.length - 1)];
    index += 1;
    return respond(state);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("runJob", () => {
  it("submits, polls to completion and returns the result", async () => {
    const { impl, calls } = stubFetch([
      job({ progress: 0.5 }),
      job({ status: "done", progress: 1, result: { ok: true } }),
    ]);
    const client = new SidecarClient("http://x", impl);

    await expect(client.runJob("probe", {}, { minIntervalMs: 1 })).resolves.toEqual({ ok: true });
    expect(calls[0]).toBe("POST /jobs/probe");
  });

  it("reports progress once per change, not once per poll", async () => {
    const { impl } = stubFetch([
      job({ progress: 0.25 }),
      job({ progress: 0.25 }),
      job({ progress: 0.75 }),
      job({ status: "done", progress: 1, result: 1 }),
    ]);
    const seen: number[] = [];
    await new SidecarClient("http://x", impl).runJob(
      "probe",
      {},
      {
        minIntervalMs: 1,
        onProgress: (fraction) => seen.push(fraction),
      },
    );
    expect(seen).toEqual([0.25, 0.75, 1]);
  });

  it("turns a failed job into a structured error naming the cause", async () => {
    const { impl } = stubFetch([job({ status: "error", error: "model missing" })]);
    await expect(
      new SidecarClient("http://x", impl).runJob("transcribe", {}, { minIntervalMs: 1 }),
    ).rejects.toThrow(/transcribe job failed: model missing/);
  });

  it("distinguishes cancellation from failure", async () => {
    const { impl } = stubFetch([job({ status: "cancelled" })]);
    const error = await new SidecarClient("http://x", impl)
      .runJob("probe", {}, { minIntervalMs: 1 })
      .catch((e: unknown) => e as SidecarError);
    expect((error as SidecarError).code).toBe("job_cancelled");
  });

  it("cancels the sidecar job when the caller aborts, not just abandons it", async () => {
    const { impl, calls } = stubFetch([job(), job(), job({ status: "cancelled" })]);
    const controller = new AbortController();
    const client = new SidecarClient("http://x", impl);
    const promise = client.runJob("probe", {}, { minIntervalMs: 1, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
    // An abandoned job would hold the GPU gate against everything else.
    expect(calls.some((call) => call.includes("/cancel"))).toBe(true);
  });

  it("surfaces an unreachable sidecar as a structured error", async () => {
    const failing = (() => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const error = await new SidecarClient("http://x", failing)
      .health()
      .catch((e: unknown) => e as SidecarError);
    expect((error as SidecarError).code).toBe("http");
    expect((error as Error).message).toContain("ECONNREFUSED");
  });
});

describe("requireCapability", () => {
  it("passes when the capability is present", async () => {
    const { impl } = stubFetch([], { health: { status: "ok", capabilities: { torch: true } } });
    await expect(
      new SidecarClient("http://x", impl).requireCapability("torch"),
    ).resolves.toBeUndefined();
  });

  it("fails with the install command rather than deep inside Python", async () => {
    const { impl } = stubFetch([], {
      health: { status: "ok", capabilities: { mlx_whisper: false } },
    });
    const error = await new SidecarClient("http://x", impl)
      .requireCapability("mlx_whisper")
      .catch((e: unknown) => e as SidecarError);
    expect((error as SidecarError).code).toBe("capability_missing");
    expect((error as Error).message).toContain("uv pip install mlx-whisper");
    expect((error as Error).message).toContain("To fix:");
  });
});
