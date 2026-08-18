import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { recordStageRun, resolveOrphanedRuns, type Db } from "@dnd/core";
import {
  structuredError,
  type RunEvent,
  type RunsSubscribeRequest,
  type RunsSubscribeResponse,
  type StructuredError,
} from "../../shared/contracts.js";

const DEFAULT_REPLAY_LIMIT = 512;
const DEFAULT_MAX_SUBSCRIPTIONS = 64;
const DEFAULT_STAGE_VERSION = 1;

export type RunLifecycleStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** A producer event before the manager assigns its run-local sequence. */
export type RunEventInput = {
  [Kind in RunEvent["type"]]: Omit<Extract<RunEvent, { type: Kind }>, "sequence" | "runId"> & {
    readonly runId?: string;
  };
}[RunEvent["type"]];

export type RunEventListener = (event: RunEvent) => void;
export type CancellationHandler = () => void | Promise<void>;

/** The small child-process surface needed for cancellation without coupling to Electron. */
export type KillableChild = Pick<ChildProcess, "kill">;

export interface RunLedgerStart {
  readonly runId: string;
  readonly sessionId: string;
  readonly stage: string;
  readonly version: number;
  readonly startedAt: string;
}

export interface RunLedgerFinish {
  readonly status: "ok" | "error" | "interrupted" | "cancelled";
  readonly skipped: boolean;
  readonly error?: string | null;
  readonly finishedAt: string;
  readonly durationS: number;
}

/** Persistence is synchronous because Node owns the SQLite connection. */
export interface RunLedger {
  readonly recoverInterrupted?: () => void;
  readonly startStage: (run: RunLedgerStart) => string;
  readonly finishStage: (stageRunId: string, outcome: RunLedgerFinish) => void;
}

/** SQLite-backed stage ledger used by the desktop composition root. */
export function createSqliteRunLedger(db: Db): RunLedger {
  return {
    recoverInterrupted: () => {
      resolveOrphanedRuns(db);
    },
    startStage: (run) =>
      recordStageRun(db, {
        session_id: run.sessionId,
        stage: run.stage,
        version: run.version,
        status: "running",
        skipped: false,
        started_at: run.startedAt,
      }),
    finishStage: (stageRunId, outcome) => {
      db.prepare(
        `UPDATE stage_runs
         SET status = @status, skipped = @skipped, error = @error,
             finished_at = @finished_at, duration_s = @duration_s
         WHERE stage_run_id = @stage_run_id`,
      ).run({
        stage_run_id: stageRunId,
        status: outcome.status,
        skipped: outcome.skipped ? 1 : 0,
        error: outcome.error ?? null,
        finished_at: outcome.finishedAt,
        duration_s: outcome.durationS,
      });
    },
  };
}

/** Explicit startup hook for hosts that construct their manager lazily. */
export function recoverInterruptedRuns(db: Db): void {
  resolveOrphanedRuns(db);
}

export interface RunProducerContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly stages: readonly string[];
  readonly signal: AbortSignal;
  readonly emit: (event: RunEventInput) => RunEvent | undefined;
  /** Register sidecar/job cancellation; the returned function removes it. */
  readonly onCancel: (handler: CancellationHandler) => () => void;
  /** Register a child so cancellation sends it a termination signal. */
  readonly registerChild: (child: KillableChild) => () => void;
  readonly stageStarted: (stage: string, at?: string) => RunEvent | undefined;
  readonly stageProgress: (
    stage: string,
    progress: number,
    message?: string,
  ) => RunEvent | undefined;
}

export type RunProducer = (context: RunProducerContext) => void | Promise<void>;

export interface RunStartOptions {
  readonly sessionId: string;
  readonly stages?: readonly string[];
  readonly version?: number;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly producer: RunProducer;
  /** Optional host-level cancellation (for example, a sidecar job id). */
  readonly onCancel?: CancellationHandler;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: RunLifecycleStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly terminal?: RunEvent;
  readonly cancelRequested: boolean;
}

export interface RunResult {
  readonly snapshot: RunSnapshot;
  readonly terminal: RunEvent;
}

export interface RunHandle {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly done: Promise<RunResult>;
  readonly promise: Promise<RunResult>;
  readonly cancel: (reason?: string) => Promise<boolean>;
}

export interface RunManagerOptions {
  readonly replayLimit?: number;
  readonly maxSubscriptions?: number;
  readonly idFactory?: () => string;
  readonly subscriptionIdFactory?: () => string;
  readonly now?: () => number;
  readonly nowIso?: () => string;
  readonly ledger?: RunLedger;
  readonly db?: Db;
  /** Test hook: invoked after live delivery is registered and before replay is copied. */
  readonly beforeReplaySnapshot?: (runId: string) => void;
  readonly cancellationTimeoutMs?: number;
}

export class RunNotFoundError extends Error {
  readonly code = "run_not_found" as const;

  constructor(runId: string) {
    super(`run ${runId} was not found`);
    this.name = "RunNotFoundError";
  }
}

interface StageLedgerRecord {
  readonly stage: string;
  readonly startedAt: number;
  readonly ledgerId: string;
  announced: boolean;
  closed: boolean;
}

interface ActiveRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly stages: readonly string[];
  readonly version: number;
  readonly producer: RunProducer;
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly done: Promise<RunResult>;
  readonly resolveDone: (result: RunResult) => void;
  readonly buffer: RunEvent[];
  readonly stagesByName: Map<string, StageLedgerRecord>;
  readonly cancellationHandlers: Set<CancellationHandler>;
  readonly children: Set<KillableChild>;
  sequence: number;
  status: RunLifecycleStatus;
  finishedAt: number | undefined;
  terminal: RunEvent | undefined;
  cancelRequested: boolean;
  producerError: StructuredError | undefined;
  stageFailure: StructuredError | undefined;
  replayTruncated: boolean;
  finalized: boolean;
  cancelPromise: Promise<boolean> | undefined;
  execution: Promise<void> | undefined;
  cancelReason: string | undefined;
}

interface Subscription {
  readonly runId: string;
  readonly listener: RunEventListener | undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function errorFromUnknown(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): StructuredError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly details?: unknown;
    };
    if (typeof candidate.message === "string" && candidate.message.length > 0) {
      const code = typeof candidate.code === "string" ? candidate.code : fallbackCode;
      const details =
        typeof candidate.details === "object" && candidate.details !== null
          ? (candidate.details as Record<string, string | number | boolean | null>)
          : undefined;
      return structuredError(code, candidate.message, details);
    }
  }
  if (error instanceof Error && error.message.length > 0) {
    return structuredError(fallbackCode, error.message);
  }
  return structuredError(fallbackCode, fallbackMessage);
}

function terminalEvent(
  event: RunEvent,
): event is Extract<RunEvent, { type: "run_completed" | "run_failed" }> {
  return event.type === "run_completed" || event.type === "run_failed";
}

function stageEvent(event: RunEvent): event is Extract<
  RunEvent,
  {
    type: "stage_started" | "stage_progress" | "stage_skipped" | "stage_completed" | "stage_failed";
  }
> {
  return (
    event.type === "stage_started" ||
    event.type === "stage_progress" ||
    event.type === "stage_skipped" ||
    event.type === "stage_completed" ||
    event.type === "stage_failed"
  );
}

function terminalStatus(
  event: Extract<RunEvent, { type: "run_completed" | "run_failed" }>,
): RunLifecycleStatus {
  if (event.type === "run_completed") return "completed";
  return event.error.code === "cancelled" ? "cancelled" : "failed";
}

export class RunManager {
  private readonly replayLimit: number;
  private readonly maxSubscriptions: number;
  private readonly idFactory: () => string;
  private readonly subscriptionIdFactory: () => string;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly ledger: RunLedger | undefined;
  private readonly beforeReplaySnapshot: ((runId: string) => void) | undefined;
  private readonly cancellationTimeoutMs: number;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(options: RunManagerOptions = {}) {
    this.replayLimit = positiveInteger(options.replayLimit, DEFAULT_REPLAY_LIMIT);
    this.maxSubscriptions = positiveInteger(options.maxSubscriptions, DEFAULT_MAX_SUBSCRIPTIONS);
    this.idFactory = options.idFactory ?? randomUUID;
    this.subscriptionIdFactory = options.subscriptionIdFactory ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date(this.now()).toISOString());
    this.ledger =
      options.ledger ?? (options.db === undefined ? undefined : createSqliteRunLedger(options.db));
    this.beforeReplaySnapshot = options.beforeReplaySnapshot;
    this.cancellationTimeoutMs = positiveInteger(options.cancellationTimeoutMs, 5_000);
    this.ledger?.recoverInterrupted?.();
  }

  /** Start a producer and return a handle that remains valid after completion for replay. */
  run(options: RunStartOptions): RunHandle {
    const runId = options.runId ?? this.idFactory();
    if (this.runs.has(runId)) throw new Error(`run ${runId} already exists`);
    const controller = new AbortController();
    let resolveDone!: (result: RunResult) => void;
    const done = new Promise<RunResult>((resolve) => {
      resolveDone = resolve;
    });
    const active: ActiveRun = {
      runId,
      sessionId: options.sessionId,
      stages: [...(options.stages ?? [])],
      version: options.version ?? DEFAULT_STAGE_VERSION,
      producer: options.producer,
      controller,
      startedAt: this.now(),
      done,
      resolveDone,
      buffer: [],
      stagesByName: new Map(),
      cancellationHandlers: new Set(),
      children: new Set(),
      sequence: 0,
      status: "running",
      finishedAt: undefined,
      terminal: undefined,
      cancelRequested: false,
      producerError: undefined,
      stageFailure: undefined,
      replayTruncated: false,
      finalized: false,
      cancelPromise: undefined,
      execution: undefined,
      cancelReason: undefined,
    };
    this.runs.set(runId, active);
    this.primeLedger(active);
    if (options.onCancel !== undefined) active.cancellationHandlers.add(options.onCancel);
    const removeExternalAbort = (): void => {
      options.signal?.removeEventListener("abort", onExternalAbort);
    };
    const onExternalAbort = (): void => {
      void this.cancel(runId, "run cancelled by its owner");
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) onExternalAbort();
      else options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    // Let the host attach a subscription before a synchronous producer emits
    // its first stage event; the replay buffer still covers later reattaches.
    queueMicrotask(() => {
      active.execution = this.execute(active, removeExternalAbort);
    });
    return {
      runId,
      signal: controller.signal,
      done,
      promise: done,
      cancel: (reason) => this.cancel(runId, reason),
    };
  }

  /** Alias for hosts that name the operation startRun. */
  start(options: RunStartOptions): RunHandle {
    return this.run(options);
  }

  /** Explicit alias for callers that distinguish creation from execution. */
  startRun(options: RunStartOptions): RunHandle {
    return this.run(options);
  }

  get(runId: string): RunSnapshot {
    const active = this.runs.get(runId);
    if (active === undefined) throw new RunNotFoundError(runId);
    return this.snapshot(active);
  }

  list(): readonly RunSnapshot[] {
    return [...this.runs.values()]
      .sort(
        (left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
      )
      .map((run) => this.snapshot(run));
  }

  events(runId: string): readonly RunEvent[] {
    const run = this.runs.get(runId);
    if (run === undefined) throw new RunNotFoundError(runId);
    return [...run.buffer];
  }

  /**
   * Register live delivery before taking the replay snapshot. A callback may
   * therefore receive an event that is also present in `replay`; consumers
   * must de-duplicate by sequence as the renderer does.
   */
  subscribe(request: RunsSubscribeRequest, listener?: RunEventListener): RunsSubscribeResponse;
  subscribe(runId: string, cursor?: number, listener?: RunEventListener): RunsSubscribeResponse;
  subscribe(runId: string, listener: RunEventListener, cursor?: number): RunsSubscribeResponse;
  subscribe(
    requestOrRunId: RunsSubscribeRequest | string,
    cursorOrListener?: number | RunEventListener,
    listenerOrCursor?: RunEventListener | number,
  ): RunsSubscribeResponse {
    const request: RunsSubscribeRequest =
      typeof requestOrRunId === "string"
        ? {
            runId: requestOrRunId,
            ...(typeof cursorOrListener === "number" ? { cursor: cursorOrListener } : {}),
          }
        : requestOrRunId;
    const listener =
      typeof cursorOrListener === "function"
        ? cursorOrListener
        : typeof listenerOrCursor === "function"
          ? listenerOrCursor
          : undefined;
    const run = this.runs.get(request.runId);
    if (run === undefined) throw new RunNotFoundError(request.runId);
    if (this.subscriptions.size >= this.maxSubscriptions)
      throw new Error("run subscription limit reached");
    const subscriptionId = this.subscriptionIdFactory();
    this.subscriptions.set(subscriptionId, { runId: request.runId, listener });
    this.beforeReplaySnapshot?.(request.runId);
    const cursor = request.cursor;
    const replay = run.buffer.filter((event) => cursor === undefined || event.sequence > cursor);
    const oldest = run.buffer[0]?.sequence;
    const replayTruncated =
      run.replayTruncated &&
      (cursor === undefined || (oldest !== undefined && cursor < oldest - 1));
    return {
      subscriptionId,
      replay,
      replayCursor: run.sequence,
      replayTruncated,
    };
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /** Publish a producer event through the same sequence/replay path as live events. */
  emit(runId: string, event: RunEventInput): RunEvent | undefined {
    const run = this.runs.get(runId);
    if (run === undefined) throw new RunNotFoundError(runId);
    return this.publish(run, event);
  }

  async cancel(runId: string, reason = "run cancelled"): Promise<boolean> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new RunNotFoundError(runId);
    if (run.finalized) return false;
    if (run.cancelPromise !== undefined) return run.cancelPromise;
    run.cancelRequested = true;
    run.cancelReason = reason;
    run.controller.abort();
    run.cancelPromise = (async () => {
      const handlers = [...run.cancellationHandlers];
      let handlerTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(handlers.map((handler) => Promise.resolve().then(handler))),
        new Promise<void>((resolve) => {
          handlerTimer = setTimeout(resolve, this.cancellationTimeoutMs);
        }),
      ]);
      if (handlerTimer !== undefined) clearTimeout(handlerTimer);
      if (run.execution !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          run.execution,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.cancellationTimeoutMs);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (!run.finalized) {
          for (const child of run.children) {
            try {
              child.kill("SIGKILL");
            } catch {
              // The child may have exited while escalation was in flight.
            }
          }
        }
      }
      if (!run.finalized) this.finishWithFailure(run, structuredError("cancelled", reason));
      return true;
    })();
    try {
      return await run.cancelPromise;
    } finally {
      run.cancelPromise = undefined;
    }
  }

  private async execute(run: ActiveRun, removeExternalAbort: () => void): Promise<void> {
    const context: RunProducerContext = {
      runId: run.runId,
      sessionId: run.sessionId,
      stages: run.stages,
      signal: run.controller.signal,
      emit: (event) => this.publish(run, event),
      onCancel: (handler) => this.registerCancellation(run, handler),
      registerChild: (child) => {
        run.children.add(child);
        const remove = this.registerCancellation(run, () => {
          try {
            child.kill("SIGTERM");
          } catch {
            // A child that exited between the abort and kill calls is already stopped.
          }
        });
        return () => {
          run.children.delete(child);
          remove();
        };
      },
      stageStarted: (stage, at = this.nowIso()) =>
        this.publish(run, { type: "stage_started", stage, at }),
      stageProgress: (stage, progress, message) =>
        this.publish(run, {
          type: "stage_progress",
          stage,
          progress,
          ...(message === undefined ? {} : { message }),
        }),
    };
    try {
      if (!run.finalized) await run.producer(context);
    } catch (error) {
      run.producerError = errorFromUnknown(error, "internal_error", "pipeline run failed");
    } finally {
      removeExternalAbort();
      if (!run.finalized) {
        if (run.cancelRequested || run.controller.signal.aborted) {
          this.finishWithFailure(
            run,
            structuredError("cancelled", run.cancelReason ?? "run cancelled"),
          );
        } else if (run.producerError !== undefined) {
          this.finishWithFailure(run, run.producerError);
        } else if (run.stageFailure !== undefined) {
          this.finishWithFailure(run, run.stageFailure);
        } else {
          this.finishWithSuccess(run);
        }
      }
    }
  }

  private registerCancellation(run: ActiveRun, handler: CancellationHandler): () => void {
    if (run.cancelRequested) {
      void Promise.resolve()
        .then(handler)
        .catch(() => undefined);
      return () => undefined;
    }
    run.cancellationHandlers.add(handler);
    return () => run.cancellationHandlers.delete(handler);
  }

  /** Create a running ledger row before the producer can do any work. */
  private primeLedger(run: ActiveRun): void {
    if (this.ledger === undefined) return;
    const stage = run.stages[0] ?? "pipeline";
    try {
      const ledgerId = this.ledger.startStage({
        runId: run.runId,
        sessionId: run.sessionId,
        stage,
        version: run.version,
        startedAt: this.nowIso(),
      });
      run.stagesByName.set(stage, {
        stage,
        startedAt: run.startedAt,
        ledgerId,
        announced: false,
        closed: false,
      });
    } catch {
      // A missing session row is reported by the pipeline producer; it must
      // not prevent the in-memory run from emitting a terminal failure.
    }
  }

  private publish(run: ActiveRun, input: RunEventInput): RunEvent | undefined {
    if (run.finalized) return undefined;
    if (input.runId !== undefined && input.runId !== run.runId)
      throw new Error(`event run id ${input.runId} does not match ${run.runId}`);
    const event = Object.freeze({
      ...input,
      runId: run.runId,
      sequence: run.sequence + 1,
    }) as RunEvent;
    run.sequence = event.sequence;
    run.buffer.push(event);
    if (run.buffer.length > this.replayLimit) {
      run.buffer.shift();
      run.replayTruncated = true;
    }
    this.observeStage(run, event);
    if (terminalEvent(event)) run.terminal = event;
    const listeners = [...this.subscriptions.entries()]
      .filter(([, subscription]) => subscription.runId === run.runId)
      .map(([subscriptionId, subscription]) => ({
        subscriptionId,
        listener: subscription.listener,
      }));
    for (const subscription of listeners) {
      try {
        subscription.listener?.(event);
      } catch {
        // A renderer listener cannot break persistence or another subscriber.
      }
    }
    if (terminalEvent(event)) this.complete(run, event);
    return event;
  }

  private observeStage(run: ActiveRun, event: RunEvent): void {
    if (!stageEvent(event)) return;
    if (event.type === "stage_started") {
      const previous = run.stagesByName.get(event.stage);
      if (previous !== undefined && !previous.closed && !previous.announced) {
        previous.announced = true;
        return;
      }
      if (previous !== undefined && !previous.closed)
        this.finishLedger(run, previous, "error", false, "stage restarted");
      let ledgerId: string;
      try {
        ledgerId =
          this.ledger?.startStage({
            runId: run.runId,
            sessionId: run.sessionId,
            stage: event.stage,
            version: run.version,
            startedAt: event.at,
          }) ?? `${run.runId}:${event.stage}`;
      } catch {
        ledgerId = `${run.runId}:${event.stage}`;
      }
      run.stagesByName.set(event.stage, {
        stage: event.stage,
        startedAt: (() => {
          const parsed = Date.parse(event.at);
          return Number.isFinite(parsed) ? parsed : run.startedAt;
        })(),
        ledgerId,
        announced: true,
        closed: false,
      });
      return;
    }
    if (event.type === "stage_progress") return;
    const stage = run.stagesByName.get(event.stage);
    if (stage === undefined || stage.closed) return;
    if (event.type === "stage_failed") {
      run.stageFailure = event.error;
      this.finishLedger(run, stage, "error", false, event.error.message);
    } else if (event.type === "stage_skipped") {
      this.finishLedger(run, stage, "ok", true);
    } else {
      this.finishLedger(run, stage, "ok", false);
    }
  }

  private finishLedger(
    run: ActiveRun,
    stage: StageLedgerRecord,
    status: RunLedgerFinish["status"],
    skipped: boolean,
    error?: string,
  ): void {
    if (stage.closed) return;
    stage.closed = true;
    try {
      this.ledger?.finishStage(stage.ledgerId, {
        status,
        skipped,
        ...(error === undefined ? {} : { error }),
        finishedAt: this.nowIso(),
        durationS: Math.max(0, (this.now() - stage.startedAt) / 1000),
      });
    } catch {
      // A ledger failure must not strand the sidecar job or suppress its terminal event.
    }
  }

  private closeStages(run: ActiveRun, outcome: RunLedgerFinish["status"]): void {
    for (const stage of run.stagesByName.values()) {
      if (!stage.closed) this.finishLedger(run, stage, outcome, false);
    }
  }

  private finishWithSuccess(run: ActiveRun): void {
    if (run.finalized) return;
    const stage = [...run.stagesByName.values()].find((item) => !item.closed);
    if (stage !== undefined) this.finishLedger(run, stage, "ok", false);
    this.closeStages(run, "ok");
    this.publish(run, { type: "run_completed" });
  }

  private finishWithFailure(run: ActiveRun, error: StructuredError): void {
    if (run.finalized) return;
    const stage = [...run.stagesByName.values()].find((item) => !item.closed);
    if (stage !== undefined && run.stageFailure === undefined) {
      this.publish(run, { type: "stage_failed", stage: stage.stage, error });
    }
    this.closeStages(run, error.code === "cancelled" ? "cancelled" : "error");
    this.publish(run, {
      type: "run_failed",
      error,
    });
  }

  private complete(
    run: ActiveRun,
    terminal: Extract<RunEvent, { type: "run_completed" | "run_failed" }>,
  ): void {
    if (run.finalized) return;
    run.finalized = true;
    run.status = terminalStatus(terminal);
    run.finishedAt = this.now();
    run.cancellationHandlers.clear();
    const stageStatus: RunLedgerFinish["status"] =
      run.status === "completed"
        ? "ok"
        : run.status === "cancelled"
          ? "cancelled"
          : run.status === "interrupted"
            ? "interrupted"
            : "error";
    this.closeStages(run, stageStatus);
    run.resolveDone({ snapshot: this.snapshot(run), terminal });
  }

  private snapshot(run: ActiveRun): RunSnapshot {
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.terminal === undefined ? {} : { terminal: run.terminal }),
      cancelRequested: run.cancelRequested,
    };
  }
}
