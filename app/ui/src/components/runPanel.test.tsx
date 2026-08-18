import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunsSubscribeResponse } from "../../../desktop/src/shared/contracts.js";
import type { RendererTransport } from "../transport.js";
import { RunPanel, deriveRunPanelModel, hasRunEventGap, mergeRunEvent } from "./RunPanel.js";

const transport: Pick<RendererTransport, "pipeline" | "runs"> = {
  pipeline: {
    run: async () => ({ runId: "run" }),
    cancel: async () => ({ cancelled: true }),
  },
  runs: {
    subscribe: async (): Promise<RunsSubscribeResponse> => ({
      subscriptionId: "sub",
      replay: [],
      replayCursor: 0,
      replayTruncated: false,
    }),
    unsubscribe: async () => ({ unsubscribed: true }),
    onEvent: () => () => undefined,
  },
};

const events: readonly RunEvent[] = [
  {
    type: "stage_started",
    sequence: 1,
    runId: "run",
    stage: "intake",
    at: "2026-01-01T00:00:00.000Z",
  },
  {
    type: "stage_progress",
    sequence: 2,
    runId: "run",
    stage: "intake",
    progress: 0.5,
    message: "halfway",
  },
  { type: "log", sequence: 3, runId: "run", level: "info", message: "working" },
  { type: "stage_completed", sequence: 4, runId: "run", stage: "intake" },
  { type: "run_completed", sequence: 5, runId: "run" },
];

describe("RunPanel model and accessibility", () => {
  it("projects progress, elapsed time and the last log deterministically", () => {
    const model = deriveRunPanelModel(events, ["intake"], Date.parse("2026-01-01T00:00:08.000Z"));
    expect(model).toMatchObject({
      status: "completed",
      progress: 1,
      elapsedMs: 8_000,
      lastLog: "working",
    });
    expect(model.stages).toEqual([
      { name: "intake", status: "completed", progress: 1, message: "halfway" },
    ]);
  });

  it("deduplicates replay/live overlap and detects a real gap", () => {
    const duplicate = mergeRunEvent(events.slice(0, 2), events[1]!);
    expect(duplicate).toHaveLength(2);
    expect(hasRunEventGap([events[0]!, events[2]!])).toBe(true);
    expect(hasRunEventGap(duplicate)).toBe(false);
  });

  it("renders accessible status, progress, cancel and collapsible log controls", () => {
    const markup = renderToStaticMarkup(
      <RunPanel
        initialEvents={events}
        now={() => Date.parse("2026-01-01T00:00:08.000Z")}
        runId="run"
        stageNames={["intake"]}
        transport={transport}
      />,
    );
    expect(markup).toContain('aria-label="Pipeline run"');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Cancel pipeline run"');
    expect(markup).toContain("<details");
    expect(markup).toContain("Run log");
    expect(markup).toContain("working");
  });
});
