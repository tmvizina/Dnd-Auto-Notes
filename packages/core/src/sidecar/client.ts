import { SidecarError } from "./errors.js";

export interface JobRecord {
  job_id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  message: string;
  result: unknown;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface HealthReport {
  status: "ok" | "degraded";
  version?: string;
  python?: string;
  device?: string;
  capabilities: Record<string, boolean>;
  fakes?: { asr: boolean; embed: boolean };
}

export interface RunJobOptions {
  onProgress?: (fraction: number, message: string) => void;
  signal?: AbortSignal;
  /** Poll interval bounds. Short at first so quick jobs stay snappy. */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
}

const TERMINAL = new Set(["done", "error", "cancelled"]);

export class SidecarClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      throw new SidecarError(
        "http",
        `sidecar unreachable at ${this.baseUrl}${path}: ${(error as Error).message}`,
      );
    }
    if (!response.ok) {
      throw new SidecarError("http", `${path} returned ${String(response.status)}`);
    }
    return (await response.json()) as T;
  }

  async health(): Promise<HealthReport> {
    return this.request<HealthReport>("/health");
  }

  async submit(kind: string, payload: unknown): Promise<string> {
    const body = await this.request<{ job_id: string }>(`/jobs/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    return body.job_id;
  }

  async poll(jobId: string): Promise<JobRecord> {
    return this.request<JobRecord>(`/jobs/${jobId}`);
  }

  async cancel(jobId: string): Promise<void> {
    await this.request(`/jobs/${jobId}/cancel`, { method: "POST" });
  }

  async listJobs(): Promise<JobRecord[]> {
    const body = await this.request<{ jobs: JobRecord[] }>("/jobs");
    return body.jobs;
  }

  /**
   * Submits and polls to completion. Backs off from `minIntervalMs` to
   * `maxIntervalMs` so a four-hour transcription is not polled 40,000 times,
   * while a two-second probe still returns promptly.
   */
  async runJob<T>(kind: string, payload: unknown, options: RunJobOptions = {}): Promise<T> {
    const {
      onProgress,
      signal,
      minIntervalMs = 50,
      maxIntervalMs = 2000,
      timeoutMs = 6 * 60 * 60 * 1000,
    } = options;

    const jobId = await this.submit(kind, payload);
    const deadline = Date.now() + timeoutMs;
    let interval = minIntervalMs;
    let lastProgress = -1;

    // Cancellation propagates to the sidecar rather than just abandoning the
    // job: an orphaned Whisper run would hold the GPU gate against everything.
    const onAbort = (): void => {
      void this.cancel(jobId).catch(() => undefined);
    };
    // The listener cannot be attached before submit — there is no job id yet —
    // so an abort raised *during* submission would otherwise be missed and
    // leave the job running on the sidecar.
    if (signal?.aborted === true) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    try {
      for (;;) {
        const job = await this.poll(jobId);

        if (onProgress !== undefined && job.progress !== lastProgress) {
          lastProgress = job.progress;
          onProgress(job.progress, job.message);
        }

        if (TERMINAL.has(job.status)) {
          if (job.status === "done") return job.result as T;
          if (job.status === "cancelled") {
            throw new SidecarError("job_cancelled", `${kind} job was cancelled`);
          }
          throw new SidecarError("job_failed", `${kind} job failed: ${job.error ?? "unknown"}`);
        }

        if (Date.now() > deadline) {
          await this.cancel(jobId).catch(() => undefined);
          throw new SidecarError("job_failed", `${kind} job exceeded its time budget`);
        }

        await new Promise((resolve) => setTimeout(resolve, interval));
        interval = Math.min(maxIntervalMs, Math.round(interval * 1.5));
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Fails with the install line rather than deep inside Python. A stage that
   * needs a model should say so before it starts, not after an hour.
   */
  async requireCapability(name: string): Promise<void> {
    const report = await this.health();
    if (report.capabilities[name] === true) return;
    throw new SidecarError(
      "capability_missing",
      `the sidecar reports '${name}' is not available`,
      REMEDIES[name] ?? "see sidecar/pyproject.toml for the install line",
    );
  }
}

const REMEDIES: Record<string, string> = {
  mlx_whisper: "cd sidecar && uv pip install mlx-whisper   (Apple Silicon only)",
  faster_whisper: "cd sidecar && uv pip install faster-whisper",
  torch: "install torch from pytorch.org matching your CUDA, then restart the sidecar",
  speechbrain: "cd sidecar && uv pip install speechbrain",
  silero_vad: "cd sidecar && uv pip install silero-vad",
  ffmpeg: "install ffmpeg and put it on PATH",
  ffprobe: "install ffmpeg (ffprobe ships with it) and put it on PATH",
};
