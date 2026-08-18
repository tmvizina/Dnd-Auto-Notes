import { dirname, join } from "node:path";
import {
  SidecarError,
  SidecarSupervisor as CoreSidecarSupervisor,
  type HealthReport,
  type RunJobOptions,
  type SidecarClient,
  type SidecarRecord,
  type SupervisorOptions as CoreSupervisorOptions,
} from "@dnd/core";
import { DesktopSidecarError } from "./errors.js";
import { DEFAULT_LOG_TAIL_BYTES, DEFAULT_LOG_TAIL_LINES, readLogTail } from "./logs.js";
import {
  type SidecarState,
  type SidecarStateDetails,
  type SidecarStateListener,
  type SidecarStatus,
} from "./state.js";

const DEFAULT_ACTIVE_POLL_INTERVAL_MS = 250;
const DEFAULT_IDLE_POLL_INTERVAL_MS = 15_000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;
const DEFAULT_RESTART_BACKOFF_MS = 250;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 10_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 5;
const DEFAULT_STOP_GRACE_MS = 5_000;

type TimerHandle = ReturnType<typeof setTimeout>;

/** The small part of P1-02 that the desktop lifecycle needs. */
export interface CoreSidecarSupervisorLike {
  readonly owns: boolean;
  ensureRunning(): Promise<SidecarRecord>;
  client(port: number): SidecarClient;
  stop(graceMs?: number): Promise<void>;
}

export interface DesktopSidecarSupervisorOptions {
  /** Repository or packaged resource root containing the `sidecar` folder. */
  readonly repoRoot: string;
  /** App log directory. Sidecar output is written to `<logDir>/sidecar.log`. */
  readonly logDir?: string;
  /** Directory for the core supervisor's sidecar record and rotated logs. */
  readonly stateDir?: string;
  readonly port?: number;
  readonly startTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly activePollIntervalMs?: number;
  readonly idlePollIntervalMs?: number;
  readonly healthFailureThreshold?: number;
  readonly restartBackoffMs?: number;
  readonly restartBackoffMaxMs?: number;
  readonly maxRestartAttempts?: number;
  readonly stopGraceMs?: number;
  /** Injectable for deterministic lifecycle tests; production uses P1-02. */
  readonly supervisor?: CoreSidecarSupervisorLike;
  readonly createSupervisor?: (options: CoreSupervisorOptions) => CoreSidecarSupervisorLike;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly fail: (error: DesktopSidecarError) => void;
}

interface RestartWaiter {
  readonly promise: Promise<SidecarState>;
  readonly reject: (error: DesktopSidecarError) => void;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/** Pure backoff calculation so the retry policy can be tested without timers. */
export function restartDelay(attempt: number, baseMs: number, maxMs: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const safeBase = Math.max(0, baseMs);
  const safeMax = Math.max(safeBase, maxMs);
  return Math.min(safeMax, safeBase * 2 ** (safeAttempt - 1));
}

function coreOptions(options: DesktopSidecarSupervisorOptions): CoreSupervisorOptions {
  // The core supervisor writes `<stateDir>/logs/sidecar.log`; when the app
  // gives us an explicit log directory, make that path authoritative so the
  // bytes streamed by the child land in the app's log directory as promised.
  const stateDir = options.logDir === undefined ? options.stateDir : dirname(options.logDir);
  return {
    repoRoot: options.repoRoot,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

function setupCommand(error: unknown): string | undefined {
  if (error instanceof SidecarError) return error.remedy;
  if (typeof error !== "object" || error === null || !("remedy" in error)) return undefined;
  const remedy = (error as { remedy?: unknown }).remedy;
  return typeof remedy === "string" ? remedy : undefined;
}

function healthFailureMessage(health: HealthReport | undefined, error: unknown): string {
  if (health !== undefined && health.status !== "ok") {
    return `sidecar health is ${health.status}`;
  }
  return `sidecar health check failed: ${errorMessage(error, "sidecar did not answer /health")}`;
}

/**
 * Desktop policy around the core supervisor.
 *
 * The class is intentionally demand-driven: constructing it does no process
 * work and creates no polling timer. Call `runJob` (or `ensureRunning`) when a
 * pipeline actually needs the model host. The core supervisor remains the
 * authority for process ownership and adoption.
 */
export class DesktopSidecarSupervisor {
  private readonly core: CoreSidecarSupervisorLike;
  private readonly logDir: string;
  private readonly activePollIntervalMs: number;
  private readonly idlePollIntervalMs: number;
  private readonly healthFailureThreshold: number;
  private readonly restartBackoffMs: number;
  private readonly restartBackoffMaxMs: number;
  private readonly maxRestartAttempts: number;
  private readonly stopGraceMs: number;
  private readonly listeners = new Set<SidecarStateListener>();
  private readonly activeRuns = new Set<ActiveRun>();

  private currentState: SidecarState = Object.freeze({
    status: "stopped",
    restartAttempt: 0,
  });
  private currentClient: SidecarClient | null = null;
  private currentRecord: SidecarRecord | null = null;
  private healthTimer: TimerHandle | null = null;
  private restartTimer: TimerHandle | null = null;
  private restartExecution: Promise<SidecarState> | null = null;
  private restartWaiter: RestartWaiter | null = null;
  private ensurePromise: Promise<SidecarState> | null = null;
  private stopPromise: Promise<void> | null = null;
  private healthFailures = 0;
  private restartAttempt = 0;
  private lifecycleGeneration = 0;
  private stopping = false;
  private coreStopPromise: Promise<void> | null = null;
  private coreStopGeneration: number | null = null;

  constructor(options: DesktopSidecarSupervisorOptions) {
    this.logDir =
      options.logDir ?? join(options.stateDir ?? join(options.repoRoot, ".dnd"), "logs");
    this.activePollIntervalMs = positiveNumber(
      options.activePollIntervalMs,
      DEFAULT_ACTIVE_POLL_INTERVAL_MS,
    );
    this.idlePollIntervalMs = positiveNumber(
      options.idlePollIntervalMs,
      DEFAULT_IDLE_POLL_INTERVAL_MS,
    );
    this.healthFailureThreshold = positiveInteger(
      options.healthFailureThreshold,
      DEFAULT_HEALTH_FAILURE_THRESHOLD,
    );
    this.restartBackoffMs = positiveNumber(options.restartBackoffMs, DEFAULT_RESTART_BACKOFF_MS);
    this.restartBackoffMaxMs = Math.max(
      this.restartBackoffMs,
      positiveNumber(options.restartBackoffMaxMs, DEFAULT_RESTART_BACKOFF_MAX_MS),
    );
    this.maxRestartAttempts = positiveInteger(
      options.maxRestartAttempts,
      DEFAULT_MAX_RESTART_ATTEMPTS,
    );
    this.stopGraceMs = positiveNumber(options.stopGraceMs, DEFAULT_STOP_GRACE_MS);

    this.core =
      options.supervisor ??
      (options.createSupervisor === undefined
        ? new CoreSidecarSupervisor(coreOptions(options))
        : options.createSupervisor(coreOptions(options)));
  }

  /** Last published state; the object is frozen before it reaches callers. */
  get state(): SidecarState {
    return this.currentState;
  }

  getStatus(): SidecarState {
    return this.currentState;
  }

  get status(): SidecarStatus {
    return this.currentState.status;
  }

  get owns(): boolean {
    return this.core.owns;
  }

  get record(): SidecarRecord | null {
    return this.currentRecord;
  }

  get logPath(): string {
    return join(this.logDir, "sidecar.log");
  }

  /** Subscribe to state transitions. The current state is sent immediately. */
  onState(listener: SidecarStateListener, emitCurrent = true): () => void {
    this.listeners.add(listener);
    if (emitCurrent) {
      try {
        listener(this.currentState);
      } catch {
        // A renderer subscriber cannot be allowed to break process supervision.
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Alias used by main-process handlers that call all push streams events. */
  onStatus(listener: SidecarStateListener, emitCurrent = true): () => void {
    return this.onState(listener, emitCurrent);
  }

  subscribe(listener: SidecarStateListener, emitCurrent = true): () => void {
    return this.onState(listener, emitCurrent);
  }

  /** Return the P1-02 client only after a successful health check. */
  client(): SidecarClient {
    if (this.currentClient === null || this.currentState.status !== "ready") {
      throw new DesktopSidecarError(
        "unavailable",
        "the sidecar is not ready",
        this.currentState.setupCommand,
      );
    }
    return this.currentClient;
  }

  /** Start on demand and deduplicate concurrent callers. */
  async ensureRunning(): Promise<SidecarState> {
    if (this.stopping) {
      throw new DesktopSidecarError("stopped", "the sidecar is stopping");
    }
    if (this.currentState.status === "ready" && this.currentClient !== null) {
      return this.currentState;
    }
    if (this.restartWaiter !== null) return this.restartWaiter.promise;
    if (this.ensurePromise !== null) return this.ensurePromise;

    const promise = this.startInternal();
    this.ensurePromise = promise;
    try {
      return await promise;
    } finally {
      if (this.ensurePromise === promise) this.ensurePromise = null;
    }
  }

  /** Explicit name for callers whose intent is a pipeline demand. */
  startOnDemand(): Promise<SidecarState> {
    return this.ensureRunning();
  }

  /**
   * Run a model job through the sidecar. Health failure rejects the call even
   * when the HTTP client itself is still polling a degraded process.
   */
  async runJob<T>(kind: string, payload: unknown, options: RunJobOptions = {}): Promise<T> {
    if (options.signal?.aborted === true) {
      throw new DesktopSidecarError("cancelled", `${kind} job was cancelled before starting`);
    }
    await this.ensureRunning();
    const client = this.client();
    const controller = new AbortController();
    let failRun: ((error: DesktopSidecarError) => void) | null = null;
    const failure = new Promise<never>((_resolve, reject) => {
      failRun = reject;
    });
    const activeRun: ActiveRun = {
      controller,
      fail: (error) => failRun?.(error),
    };
    this.activeRuns.add(activeRun);
    this.scheduleHealthCheck(0);

    const onAbort = (): void => {
      controller.abort();
      failRun?.(new DesktopSidecarError("cancelled", `${kind} job was cancelled`));
    };
    if (options.signal !== undefined)
      options.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const runPromise = client.runJob<T>(kind, payload, {
        ...options,
        signal: controller.signal,
      });
      return await Promise.race([runPromise, failure]);
    } catch (error) {
      if (error instanceof DesktopSidecarError) throw error;
      if (error instanceof SidecarError && error.code === "http") {
        throw new DesktopSidecarError(
          "unhealthy",
          `the sidecar became unreachable while running ${kind}`,
        );
      }
      if (this.currentState.status === "unhealthy") {
        throw new DesktopSidecarError(
          "unhealthy",
          `the sidecar became unhealthy while running ${kind}`,
        );
      }
      throw error;
    } finally {
      if (options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);
      this.activeRuns.delete(activeRun);
      this.scheduleHealthCheck();
    }
  }

  /** Alias matching pipeline-oriented callers. */
  runPipeline<T>(kind: string, payload: unknown, options: RunJobOptions = {}): Promise<T> {
    return this.runJob(kind, payload, options);
  }

  /** Read the bounded troubleshooting tail; missing logs are an empty tail. */
  getLogTail(
    maxLines = DEFAULT_LOG_TAIL_LINES,
    maxBytes = DEFAULT_LOG_TAIL_BYTES,
  ): Promise<readonly string[]> {
    return readLogTail(this.logPath, maxLines, maxBytes);
  }

  tailLogs(
    maxLines = DEFAULT_LOG_TAIL_LINES,
    maxBytes = DEFAULT_LOG_TAIL_BYTES,
  ): Promise<readonly string[]> {
    return this.getLogTail(maxLines, maxBytes);
  }

  /** Stop only a process owned by this app; adopted processes are untouched. */
  async stop(graceMs = this.stopGraceMs): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;

    const promise = this.stopInternal(graceMs);
    this.stopPromise = promise;
    try {
      await promise;
    } finally {
      if (this.stopPromise === promise) this.stopPromise = null;
    }
  }

  private async stopInternal(graceMs: number): Promise<void> {
    this.lifecycleGeneration += 1;
    this.stopping = true;
    this.clearHealthTimer();
    this.clearRestartTimer(new DesktopSidecarError("stopped", "the sidecar was stopped"));

    const stopError = new DesktopSidecarError("stopped", "the sidecar was stopped");
    for (const run of this.activeRuns) {
      run.fail(stopError);
      run.controller.abort();
    }

    // ensureRunning can cross the ownership boundary after stop begins. Wait
    // for that attempt to settle before checking ownership, otherwise a child
    // created by the core supervisor can be orphaned.
    const startup = this.ensurePromise;
    if (startup !== null) await startup.catch(() => undefined);
    const restart = this.restartExecution;
    if (restart !== null) await restart.catch(() => undefined);

    let thrown: unknown;
    try {
      // Core's `owns` is false for an adopted process. Do not even call stop
      // in that case: an adapter is allowed to make stop destructive.
      await this.stopOwnedCore(graceMs);
    } catch (error) {
      thrown = error;
    } finally {
      this.currentClient = null;
      this.currentRecord = null;
      this.healthFailures = 0;
      this.restartAttempt = 0;
      this.stopping = false;
      this.publish("stopped");
    }
    if (thrown !== undefined) throw thrown;
  }

  private async startInternal(startingReason?: string): Promise<SidecarState> {
    const generation = this.lifecycleGeneration;
    this.clearHealthTimer();
    this.publish("starting", startingReason === undefined ? {} : { reason: startingReason });

    let record: SidecarRecord;
    try {
      record = await this.core.ensureRunning();
    } catch (error) {
      if (generation !== this.lifecycleGeneration || this.stopping) {
        throw new DesktopSidecarError("stopped", "the sidecar start was cancelled");
      }
      this.currentClient = null;
      this.currentRecord = null;
      const command = setupCommand(error);
      const reason = errorMessage(error, "the sidecar could not be started");
      this.publish("unavailable", {
        reason,
        ...(command === undefined ? {} : { setupCommand: command }),
      });
      throw error;
    }

    if (generation !== this.lifecycleGeneration || this.stopping) {
      await this.stopOwnedCore(this.stopGraceMs);
      throw new DesktopSidecarError("stopped", "the sidecar start was cancelled");
    }

    this.currentRecord = record;
    let client: SidecarClient;
    try {
      client = this.core.client(record.port);
      this.currentClient = client;
    } catch (error) {
      return this.handleStartupHealthFailure(error);
    }

    try {
      const health = await client.health();
      if (generation !== this.lifecycleGeneration || this.stopping) {
        throw new DesktopSidecarError("stopped", "the sidecar start was cancelled");
      }
      if (health.status !== "ok") {
        return this.handleStartupHealthFailure(
          new DesktopSidecarError("unhealthy", healthFailureMessage(health, undefined)),
          health,
        );
      }
      this.healthFailures = 0;
      this.publish("ready", {
        port: record.port,
        ...(health.version === undefined ? {} : { version: health.version }),
        ownedByUs: record.ownedByUs,
      });
      this.scheduleHealthCheck();
      return this.currentState;
    } catch (error) {
      if (error instanceof DesktopSidecarError && error.code === "stopped") throw error;
      return this.handleStartupHealthFailure(error);
    }
  }

  private async handleStartupHealthFailure(
    error: unknown,
    health?: HealthReport,
  ): Promise<SidecarState> {
    const reason = healthFailureMessage(health, error);
    const lifecycleError =
      error instanceof DesktopSidecarError ? error : new DesktopSidecarError("unhealthy", reason);
    this.publish("unhealthy", { reason });
    this.failActiveRuns(lifecycleError);
    this.scheduleRestart(reason);
    throw lifecycleError;
  }

  private failActiveRuns(error: DesktopSidecarError): void {
    for (const run of this.activeRuns) {
      run.fail(error);
      run.controller.abort();
    }
  }

  private scheduleHealthCheck(delay?: number): void {
    this.clearHealthTimer();
    if (
      this.currentClient === null ||
      this.stopping ||
      this.currentState.status === "stopped" ||
      this.currentState.status === "unavailable" ||
      this.restartWaiter !== null
    )
      return;
    const pollDelay =
      delay ?? (this.activeRuns.size > 0 ? this.activePollIntervalMs : this.idlePollIntervalMs);
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      void this.checkHealth();
    }, pollDelay);
    const timer = this.healthTimer as TimerHandle & { unref?: () => void };
    timer.unref?.();
  }

  private async checkHealth(): Promise<void> {
    const client = this.currentClient;
    if (
      client === null ||
      this.stopping ||
      this.currentState.status === "stopped" ||
      this.currentState.status === "unavailable" ||
      this.restartWaiter !== null
    )
      return;

    try {
      const health = await client.health();
      if (client !== this.currentClient || this.stopping) return;
      if (health.status !== "ok") {
        this.handleHealthFailure(healthFailureMessage(health, undefined));
      } else {
        this.healthFailures = 0;
        if (this.currentState.status === "unhealthy") {
          const record = this.currentRecord;
          this.publish("ready", {
            ...(record === null ? {} : { port: record.port, ownedByUs: record.ownedByUs }),
            ...(health.version === undefined ? {} : { version: health.version }),
          });
        }
      }
    } catch (error) {
      if (client !== this.currentClient || this.stopping) return;
      this.handleHealthFailure(healthFailureMessage(undefined, error));
    }

    if (this.restartWaiter === null) this.scheduleHealthCheck();
  }

  private handleHealthFailure(reason: string): void {
    this.healthFailures += 1;
    const error = new DesktopSidecarError("unhealthy", reason);
    if (this.currentState.status !== "unhealthy") this.publish("unhealthy", { reason });
    this.failActiveRuns(error);
    if (this.healthFailures >= this.healthFailureThreshold) this.scheduleRestart(reason);
  }

  private scheduleRestart(reason: string): void {
    if (this.restartWaiter !== null || this.stopping) return;
    if (this.restartAttempt >= this.maxRestartAttempts) {
      this.clearHealthTimer();
      this.publish("unavailable", {
        reason: `sidecar restart limit reached after ${String(this.maxRestartAttempts)} attempts: ${reason}`,
      });
      return;
    }
    this.restartAttempt += 1;
    const delay = restartDelay(
      this.restartAttempt,
      this.restartBackoffMs,
      this.restartBackoffMaxMs,
    );

    let rejectWaiter: ((error: DesktopSidecarError) => void) | null = null;
    const promise = new Promise<SidecarState>((resolve, reject) => {
      rejectWaiter = reject;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        const execution = this.restartInternal(reason);
        this.restartExecution = execution;
        void execution.then(resolve, reject).finally(() => {
          if (this.restartExecution === execution) this.restartExecution = null;
        });
      }, delay);
      const timer = this.restartTimer as TimerHandle & { unref?: () => void };
      timer.unref?.();
    });
    this.restartWaiter = {
      promise,
      reject: (error) => rejectWaiter?.(error),
    };
    void promise.then(
      () => {
        if (this.restartWaiter?.promise === promise) this.restartWaiter = null;
      },
      (error: unknown) => {
        if (this.restartWaiter?.promise === promise) this.restartWaiter = null;
        if (!this.stopping && error instanceof DesktopSidecarError && error.code === "unhealthy") {
          this.scheduleRestart(error.message);
        }
      },
    );
  }

  private async restartInternal(reason: string): Promise<SidecarState> {
    if (this.stopping) throw new DesktopSidecarError("stopped", "the sidecar was stopped");
    this.clearHealthTimer();
    // Calling stop on the core is guarded by ownership. An adopted sidecar is
    // left alone; ensureRunning will probe it again or start once its port is free.
    await this.stopOwnedCore(this.stopGraceMs);
    this.currentClient = null;
    this.currentRecord = null;
    return this.startInternal(`restarting sidecar: ${reason}`);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer === null) return;
    clearTimeout(this.healthTimer);
    this.healthTimer = null;
  }

  private async stopOwnedCore(graceMs: number): Promise<void> {
    if (!this.core.owns) return;
    if (this.stopping && this.coreStopGeneration === this.lifecycleGeneration) return;
    if (this.coreStopPromise !== null) return this.coreStopPromise;
    const promise = this.core.stop(graceMs);
    if (this.stopping) this.coreStopGeneration = this.lifecycleGeneration;
    this.coreStopPromise = promise;
    try {
      await promise;
    } finally {
      if (this.coreStopPromise === promise) this.coreStopPromise = null;
    }
  }

  private clearRestartTimer(error: DesktopSidecarError): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartWaiter?.reject(error);
    this.restartWaiter = null;
  }

  private publish(status: SidecarStatus, details: SidecarStateDetails = {}): void {
    const next: SidecarState = Object.freeze({
      status,
      restartAttempt: this.restartAttempt,
      ...(details.reason === undefined ? {} : { reason: details.reason }),
      ...(details.setupCommand === undefined ? {} : { setupCommand: details.setupCommand }),
      ...(details.port === undefined ? {} : { port: details.port }),
      ...(details.version === undefined ? {} : { version: details.version }),
      ...(details.ownedByUs === undefined ? {} : { ownedByUs: details.ownedByUs }),
    });
    this.currentState = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // A renderer subscriber cannot be allowed to break process supervision.
      }
    }
  }
}

/** Short aliases keep the class discoverable from the desktop sidecar folder. */
export const SidecarManager = DesktopSidecarSupervisor;
export const AppSidecarSupervisor = DesktopSidecarSupervisor;
export const SidecarSupervisor = DesktopSidecarSupervisor;
