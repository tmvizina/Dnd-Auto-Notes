import type { ArtifactName } from "../contracts/artifacts.js";

/**
 * One source of truth for what stages exist, what each consumes and produces,
 * and in what order. The CLI and the desktop app both enumerate from here, so
 * adding a stage never means editing two lists that then drift.
 */

export interface StageDefinition {
  readonly name: string;
  readonly order: number;
  readonly version: number;
  readonly output: ArtifactName;
  /** Artifacts of earlier stages this one reads. */
  readonly requires: readonly ArtifactName[];
  /** True when the stage needs the Python sidecar to be running. */
  readonly needsSidecar: boolean;
  readonly ticket: string;
  readonly description: string;
}

export const STAGES: readonly StageDefinition[] = Object.freeze([
  {
    name: "intake",
    order: 1,
    version: 1,
    output: "manifest",
    requires: [],
    needsSidecar: true,
    ticket: "P1-09",
    description: "Discover tracks and the Roll20 capture; bind both to campaign identities.",
  },
  {
    name: "transcript",
    order: 2,
    version: 1,
    output: "transcript",
    requires: ["manifest"],
    needsSidecar: true,
    ticket: "P2-03",
    description: "VAD, ASR with word timestamps, and the cross-track merge.",
  },
  {
    name: "features",
    order: 3,
    version: 1,
    output: "features",
    requires: ["transcript"],
    needsSidecar: true,
    ticket: "P2-04",
    description: "Per-utterance speaker embeddings and prosody.",
  },
  {
    name: "align",
    order: 4,
    version: 1,
    output: "timeline",
    requires: ["manifest", "transcript"],
    needsSidecar: false,
    ticket: "P2-09",
    description: "Anchor Roll20 events onto the audio clock.",
  },
  {
    name: "persona",
    order: 5,
    version: 1,
    output: "attribution",
    requires: ["transcript", "features", "timeline"],
    needsSidecar: false,
    ticket: "P2-07",
    description: "Player vs character, which character, and what could not be decided.",
  },
  {
    name: "outline",
    order: 6,
    version: 1,
    output: "events",
    requires: ["transcript", "attribution", "timeline"],
    needsSidecar: false,
    ticket: "P3-01",
    description: "Assemble the event stream, beats, encounters and checks.",
  },
  {
    name: "notes",
    order: 7,
    version: 1,
    output: "notesQa",
    requires: ["events"],
    needsSidecar: false,
    ticket: "P3-06",
    description: "Render session.md and the session QA report.",
  },
] as const);

const BY_NAME = new Map(STAGES.map((stage) => [stage.name, stage]));

export function getStage(name: string): StageDefinition | undefined {
  return BY_NAME.get(name);
}

export function stageNames(): string[] {
  return [...STAGES].sort((a, b) => a.order - b.order).map((stage) => stage.name);
}

/**
 * Stages to run for a request, in dependency order. `from` starts partway
 * through a pipeline; `only` runs a single stage.
 */
export function planStages(options: { only?: string; from?: string } = {}): StageDefinition[] {
  const ordered = [...STAGES].sort((a, b) => a.order - b.order);
  if (options.only !== undefined) {
    const stage = BY_NAME.get(options.only);
    return stage === undefined ? [] : [stage];
  }
  if (options.from !== undefined) {
    const start = BY_NAME.get(options.from);
    return start === undefined ? [] : ordered.filter((stage) => stage.order >= start.order);
  }
  return ordered;
}
