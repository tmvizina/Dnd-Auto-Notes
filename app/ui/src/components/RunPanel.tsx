import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DesktopEvent, RendererTransport, RunEvent } from "../transport.js";

export type RunPanelStageStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export interface RunPanelStage {
  readonly name: string;
  readonly status: RunPanelStageStatus;
  readonly progress: number;
  readonly message?: string;
  readonly error?: string;
}

export interface RunPanelModel {
  readonly status: "waiting" | "running" | "completed" | "failed" | "cancelled";
  readonly stages: readonly RunPanelStage[];
  readonly progress: number;
  readonly elapsedMs: number;
  readonly lastLog?: string;
  readonly error?: string;
}

export interface RunPanelProps {
  readonly transport: Pick<RendererTransport, "pipeline" | "runs">;
  readonly runId: string | null;
  readonly stageNames?: readonly string[];
  readonly replayCursor?: number;
  readonly title?: string;
  readonly initialEvents?: readonly RunEvent[];
  /** Injectable clock keeps the view model deterministic and avoids test timers. */
  readonly now?: () => number;
}

const EMPTY_EVENTS: readonly RunEvent[] = [];

function isStageEvent(event: RunEvent): event is Extract<
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

function parseAt(at: string): number | undefined {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
}

function uniqueStageNames(events: readonly RunEvent[], names: readonly string[]): string[] {
  const result = [...names];
  for (const event of events) {
    if (isStageEvent(event) && !result.includes(event.stage)) result.push(event.stage);
  }
  return result;
}

/** Merge live/replayed events without allowing a duplicate sequence. */
export function mergeRunEvent(
  events: readonly RunEvent[],
  incoming: RunEvent,
): readonly RunEvent[] {
  if (events.some((event) => event.sequence === incoming.sequence)) return events;
  return [...events, incoming].sort((left, right) => left.sequence - right.sequence);
}

/** Detect a missing sequence only between events already observed. */
export function hasRunEventGap(events: readonly RunEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.sequence !== previous.sequence + 1
    )
      return true;
  }
  return false;
}

/** Pure projection used by the component and deterministic renderer tests. */
export function deriveRunPanelModel(
  events: readonly RunEvent[],
  stageNames: readonly string[] = [],
  now = Date.now(),
): RunPanelModel {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  const names = uniqueStageNames(sorted, stageNames);
  const stages = new Map<string, RunPanelStage>();
  for (const name of names) stages.set(name, { name, status: "pending", progress: 0 });

  let startedAt: number | undefined;
  let lastLog: string | undefined;
  let error: string | undefined;
  let terminal: RunPanelModel["status"] = "running";
  for (const event of sorted) {
    if (event.type === "log") {
      lastLog = event.message;
      continue;
    }
    if (event.type === "run_completed") {
      terminal = "completed";
      continue;
    }
    if (event.type === "run_failed") {
      terminal = event.error.code === "cancelled" ? "cancelled" : "failed";
      error = event.error.message;
      continue;
    }
    if (!isStageEvent(event)) continue;
    const current = stages.get(event.stage) ?? {
      name: event.stage,
      status: "pending" as const,
      progress: 0,
    };
    if (event.type === "stage_started") {
      startedAt ??= parseAt(event.at);
      stages.set(event.stage, { ...current, status: "running", progress: 0 });
    } else if (event.type === "stage_progress") {
      stages.set(event.stage, {
        ...current,
        status: "running",
        progress: clampProgress(event.progress),
        ...(event.message === undefined ? {} : { message: event.message }),
      });
    } else if (event.type === "stage_skipped") {
      stages.set(event.stage, { ...current, status: "skipped", progress: 1 });
    } else if (event.type === "stage_completed") {
      stages.set(event.stage, { ...current, status: "completed", progress: 1 });
    } else {
      stages.set(event.stage, {
        ...current,
        status: "failed",
        ...(event.error.message === "" ? {} : { error: event.error.message }),
      });
      error ??= event.error.message;
    }
  }

  const stageList = [...stages.values()];
  const progress =
    terminal === "completed"
      ? 1
      : stageList.length === 0
        ? 0
        : stageList.reduce((sum, stage) => sum + stage.progress, 0) / stageList.length;
  return {
    status: events.length === 0 ? "waiting" : terminal,
    stages: stageList,
    progress: clampProgress(progress),
    elapsedMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
    ...(lastLog === undefined ? {} : { lastLog }),
    ...(error === undefined ? {} : { error }),
  };
}

function statusLabel(status: RunPanelModel["status"]): string {
  switch (status) {
    case "waiting":
      return "Waiting for events";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
  }
}

function stageLabel(status: RunPanelStageStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "completed":
      return "Complete";
    case "skipped":
      return "Skipped";
    case "failed":
      return "Failed";
  }
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

function percent(progress: number): number {
  return Math.round(clampProgress(progress) * 100);
}

export function RunPanel({
  transport,
  runId,
  stageNames = [],
  replayCursor,
  title = "Pipeline run",
  initialEvents = EMPTY_EVENTS,
  now: providedNow,
}: RunPanelProps): ReactNode {
  const [events, setEvents] = useState<readonly RunEvent[]>(initialEvents);
  const [replayTruncated, setReplayTruncated] = useState(false);
  const [gapDetected, setGapDetected] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string>();
  const [cancelError, setCancelError] = useState<string>();
  const [clock, setClock] = useState(() => providedNow?.() ?? Date.now());
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    setClock(providedNow?.() ?? Date.now());
    if (providedNow !== undefined) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [providedNow]);

  useEffect(() => {
    setEvents(initialEvents);
    setReplayTruncated(false);
    setGapDetected(false);
    setSubscriptionError(undefined);
    setCancelError(undefined);
    setCancelling(false);
    if (runId === null) return;

    let mounted = true;
    let subscriptionId: string | undefined;
    let liveEvents: readonly RunEvent[] = [];
    const accept = (event: RunEvent): void => {
      if (!mounted || event.runId !== runId) return;
      liveEvents = mergeRunEvent(liveEvents, event);
      setEvents(liveEvents);
      if (hasRunEventGap(liveEvents)) setGapDetected(true);
    };
    const acceptDesktopEvent = (event: DesktopEvent): void => {
      if (event.type !== "sidecar_status") accept(event);
    };
    let removeListener: (() => void) | undefined;
    try {
      // Register before subscribe: an event emitted during replay setup is either
      // delivered live or present in replay, and sequence de-duplication handles both.
      removeListener = transport.runs.onEvent(acceptDesktopEvent);
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : "Run events are unavailable.");
      return () => undefined;
    }

    void (async () => {
      try {
        const response = await transport.runs.subscribe({
          runId,
          ...(replayCursor === undefined ? {} : { cursor: replayCursor }),
        });
        if (!mounted) {
          void transport.runs.unsubscribe({ subscriptionId: response.subscriptionId });
          return;
        }
        subscriptionId = response.subscriptionId;
        for (const event of response.replay) accept(event);
        liveEvents = [...liveEvents].sort((left, right) => left.sequence - right.sequence);
        setEvents(liveEvents);
        setReplayTruncated(response.replayTruncated);
        if (response.replayTruncated || hasRunEventGap(liveEvents)) setGapDetected(true);
      } catch (error) {
        if (mounted)
          setSubscriptionError(
            error instanceof Error ? error.message : "Run events could not be replayed.",
          );
      }
    })();

    return () => {
      mounted = false;
      removeListener?.();
      if (subscriptionId !== undefined)
        void transport.runs.unsubscribe({ subscriptionId }).catch(() => undefined);
    };
  }, [initialEvents, replayCursor, runId, transport]);

  const model = useMemo(
    () => deriveRunPanelModel(events, stageNames, clock),
    [clock, events, stageNames],
  );
  const cancelRun = useCallback(async (): Promise<void> => {
    if (runId === null || cancelling || model.status !== "running") return;
    setCancelling(true);
    setCancelError(undefined);
    try {
      const response = await transport.pipeline.cancel({
        runId,
        reason: "cancelled from run panel",
      });
      if (!response.cancelled) setCancelError("The run was already finished.");
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "The run could not be cancelled.");
    } finally {
      setCancelling(false);
    }
  }, [cancelling, model.status, runId, transport]);

  if (runId === null) {
    return (
      <section aria-label={title} className="run-panel run-panel--empty">
        <h2>{title}</h2>
        <p>No pipeline run is selected.</p>
      </section>
    );
  }

  return (
    <section aria-label={title} className="run-panel">
      <header className="run-panel__header">
        <div>
          <p className="eyebrow">Pipeline</p>
          <h2>{title}</h2>
        </div>
        <div aria-live="polite" className="run-panel__status">
          <strong>{statusLabel(model.status)}</strong>
          <span>{formatElapsed(model.elapsedMs)}</span>
        </div>
      </header>
      {subscriptionError === undefined ? null : (
        <p className="run-panel__error" role="alert">
          {subscriptionError}
        </p>
      )}
      {gapDetected || replayTruncated ? (
        <p className="run-panel__warning" role="alert">
          Some run events are unavailable. Reattach to the run to recover its latest state.
        </p>
      ) : null}
      {cancelError === undefined ? null : (
        <p className="run-panel__error" role="alert">
          {cancelError}
        </p>
      )}
      <div
        aria-label="Overall run progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent(model.progress)}
        className="run-panel__progress"
        role="progressbar"
      >
        <span style={{ width: `${String(percent(model.progress))}%` }} />
      </div>
      <div className="run-panel__summary">
        <span>{percent(model.progress)}%</span>
        {model.lastLog === undefined ? null : <span title={model.lastLog}>{model.lastLog}</span>}
      </div>
      <ol aria-label="Pipeline stages" className="run-panel__stages">
        {model.stages.map((stage) => (
          <li className={`run-panel__stage run-panel__stage--${stage.status}`} key={stage.name}>
            <div>
              <strong>{stage.name}</strong>
              <span>{stageLabel(stage.status)}</span>
            </div>
            <div
              aria-label={`${stage.name} progress`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent(stage.progress)}
              className="run-panel__stage-progress"
              role="progressbar"
            >
              <span style={{ width: `${String(percent(stage.progress))}%` }} />
            </div>
            {stage.message === undefined ? null : <p>{stage.message}</p>}
            {stage.error === undefined ? null : (
              <p className="run-panel__error" role="alert">
                {stage.error}
              </p>
            )}
          </li>
        ))}
      </ol>
      <div className="run-panel__actions">
        <button
          aria-label="Cancel pipeline run"
          disabled={cancelling || model.status !== "running"}
          onClick={() => void cancelRun()}
          type="button"
        >
          {cancelling ? "Cancelling..." : "Cancel run"}
        </button>
      </div>
      <details className="run-panel__logs">
        <summary>Logs</summary>
        <ol aria-label="Run log">
          {events
            .filter((event): event is Extract<RunEvent, { type: "log" }> => event.type === "log")
            .map((event) => (
              <li key={event.sequence}>
                <span>{event.level}</span> {event.message}
              </li>
            ))}
        </ol>
      </details>
    </section>
  );
}
