import { describe, expect, it } from "vitest";
import { ARTIFACT_SCHEMAS, isValidatedArtifact } from "../contracts/artifacts.js";
import { STAGES, getStage, planStages, stageNames } from "./registry.js";

describe("stage registry", () => {
  it("is ordered, uniquely named, and uniquely ordered", () => {
    const names = STAGES.map((s) => s.name);
    const orders = STAGES.map((s) => s.order);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(orders).size).toBe(orders.length);
    expect(stageNames()).toEqual([...STAGES].sort((a, b) => a.order - b.order).map((s) => s.name));
  });

  it("only produces artifacts that have a contract", () => {
    for (const stage of STAGES) {
      expect(isValidatedArtifact(stage.output)).toBe(true);
      expect(ARTIFACT_SCHEMAS[stage.output as keyof typeof ARTIFACT_SCHEMAS]).toBeDefined();
    }
  });

  it("never requires an artifact no earlier stage produces", () => {
    const producedBy = new Map(STAGES.map((s) => [s.output, s.order]));
    for (const stage of STAGES) {
      for (const required of stage.requires) {
        const producer = producedBy.get(required);
        expect(
          producer,
          `${stage.name} requires ${required}, which nothing produces`,
        ).toBeDefined();
        expect(producer).toBeLessThan(stage.order);
      }
    }
  });

  it("plans the whole pipeline in dependency order by default", () => {
    expect(planStages().map((s) => s.name)).toEqual(stageNames());
  });

  it("plans a single stage with --only and a suffix with --from", () => {
    expect(planStages({ only: "features" }).map((s) => s.name)).toEqual(["features"]);
    const from = planStages({ from: "persona" }).map((s) => s.name);
    expect(from[0]).toBe("persona");
    expect(from).toContain("notes");
    expect(from).not.toContain("intake");
  });

  it("returns nothing for an unknown stage rather than guessing", () => {
    expect(planStages({ only: "transcribe" })).toEqual([]);
    expect(getStage("transcribe")).toBeUndefined();
  });
});
