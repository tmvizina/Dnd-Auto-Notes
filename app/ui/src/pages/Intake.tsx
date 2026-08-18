import { useMemo, useState, type ReactNode } from "react";
import { PageIntro, StatePanel } from "../components.js";
import { errorMessage, type SessionSummary } from "../transport.js";

export type IntakeDropKind = "craig" | "roll20";

export interface IntakeDropPaths {
  readonly craig: string;
  readonly roll20: string;
}

export interface IntakeProgress {
  readonly stage: string;
  readonly fraction: number;
  readonly message: string;
}

export interface IntakeCopyProgress {
  readonly fraction: number;
  readonly message?: string;
}

export interface IntakeQaEntry {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly hint?: string;
  readonly subject?: string;
  readonly mapping?: MappingSuggestion;
}

export interface MappingCandidate {
  readonly playerId: string;
  readonly displayName: string;
  readonly score: number;
  readonly matchedOn: string;
}

export interface MappingSuggestion {
  readonly observed: string;
  readonly kind: "discord" | "roll20";
  readonly exact: string | null;
  readonly candidates: readonly MappingCandidate[];
}

export interface MappingDecision {
  readonly observed: string;
  readonly kind: MappingSuggestion["kind"];
  readonly playerId: string | null;
}

export interface IntakePageProps {
  readonly session: SessionSummary | null;
  readonly paths?: IntakeDropPaths;
  readonly state?: "idle" | "running" | "complete" | "error";
  readonly progress?: IntakeProgress;
  readonly copyProgress?: Partial<Record<IntakeDropKind, IntakeCopyProgress>>;
  readonly qa: readonly IntakeQaEntry[];
  readonly suggestions?: readonly MappingSuggestion[];
  readonly error?: string;
  readonly onRunIntake: (force: boolean) => Promise<void>;
  readonly onDropFiles?: (
    kind: IntakeDropKind,
    files: readonly File[],
    onProgress: (fraction: number, message?: string) => void,
  ) => Promise<void> | void;
  readonly onRevealPath?: (path: string) => Promise<void> | void;
  readonly onCopyPath?: (path: string) => Promise<void> | void;
  readonly onSaveMappings?: (decisions: readonly MappingDecision[]) => Promise<void>;
  readonly onOpenMapping?: (suggestion?: MappingSuggestion) => void;
}

function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function severityRank(severity: IntakeQaEntry["severity"]): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

export function orderQaEntries(entries: readonly IntakeQaEntry[]): readonly IntakeQaEntry[] {
  return [...entries].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
}

/** QA codes whose repair can be made in the campaign registry editor. */
export const REGISTRY_EDIT_QA_CODES = Object.freeze([
  "TRACK_UNMAPPED",
  "TRACK_NAME_UNPARSED",
  "ROLL20_ACCOUNT_UNMAPPED",
  "PLAYER_NO_TRACK",
] as const);

const registryEditQaCodes: ReadonlySet<string> = new Set(REGISTRY_EDIT_QA_CODES);

export function isMappingCode(code: string): boolean {
  // Keep compatibility with older sidecars that used descriptive code names,
  // while making the current registry-edit contract explicit above.
  return (
    registryEditQaCodes.has(code) ||
    code.includes("UNMAPPED") ||
    code.includes("MAPPING") ||
    code.includes("IDENTITY")
  );
}

export function decisionsForSuggestions(
  suggestions: readonly MappingSuggestion[],
  choices: ReadonlyMap<string, string>,
): readonly MappingDecision[] {
  return suggestions.map((suggestion) => ({
    observed: suggestion.observed,
    kind: suggestion.kind,
    playerId: choices.get(`${suggestion.kind}:${suggestion.observed}`) ?? null,
  }));
}

async function copyPath(
  path: string,
  handler?: (value: string) => Promise<void> | void,
): Promise<void> {
  if (handler !== undefined) {
    await handler(path);
    return;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(path);
  }
}

function PathCard({
  paths,
  onRevealPath,
  onCopyPath,
}: {
  readonly paths: IntakeDropPaths;
  readonly onRevealPath?: (path: string) => Promise<void> | void;
  readonly onCopyPath?: (path: string) => Promise<void> | void;
}): ReactNode {
  const [message, setMessage] = useState<string>();
  const action = async (path: string, kind: "copy" | "reveal"): Promise<void> => {
    try {
      if (kind === "copy") {
        await copyPath(path, onCopyPath);
        setMessage("Path copied.");
      } else if (onRevealPath === undefined) {
        setMessage("Reveal is available in the desktop app.");
      } else {
        await onRevealPath(path);
      }
    } catch (caught) {
      setMessage(
        errorMessage(
          caught,
          kind === "copy" ? "The path could not be copied." : "The folder could not be revealed.",
        ),
      );
    }
  };
  return (
    <section aria-label="Input drop paths" className="intake-paths">
      <div className="intake-paths__heading">
        <div>
          <p className="eyebrow">Inputs</p>
          <h2>Drop files into the matching folder</h2>
        </div>
        {message === undefined ? null : <span className="muted">{message}</span>}
      </div>
      {(["craig", "roll20"] as const).map((kind) => {
        const path = paths[kind];
        const label = kind === "craig" ? "Craig audio" : "Roll20 capture";
        return (
          <div className="intake-path" key={kind}>
            <span>
              <strong>{label}</strong>
              <code>{path}</code>
            </span>
            <span className="intake-path__actions">
              <button
                className="button button--secondary"
                onClick={() => void action(path, "copy")}
                type="button"
              >
                Copy path
              </button>
              <button
                className="button button--secondary"
                onClick={() => void action(path, "reveal")}
                type="button"
              >
                Reveal
              </button>
            </span>
          </div>
        );
      })}
    </section>
  );
}

function DropZone({
  kind,
  onDropFiles,
  externalProgress,
}: {
  readonly kind: IntakeDropKind;
  readonly onDropFiles?: IntakePageProps["onDropFiles"];
  readonly externalProgress?: IntakeCopyProgress;
}): ReactNode {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const label = kind === "craig" ? "Craig audio" : "Roll20 capture";

  const accept = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    if (onDropFiles === undefined) {
      setError("File import is available in the packaged desktop app.");
      return;
    }
    setError(undefined);
    setProgress(0);
    try {
      await onDropFiles(kind, files, (fraction, nextMessage) => {
        setProgress(clampFraction(fraction));
        if (nextMessage !== undefined) setMessage(nextMessage);
      });
      setProgress(1);
      setMessage(`${String(files.length)} file${files.length === 1 ? "" : "s"} copied.`);
    } catch (caught) {
      setError(errorMessage(caught, "The dropped files could not be copied."));
      setProgress(undefined);
    }
  };

  const displayedProgress = externalProgress?.fraction ?? progress;
  const displayedMessage = externalProgress?.message ?? message;

  return (
    <div
      aria-label={`Drop ${label}`}
      className={dragging ? "intake-dropzone intake-dropzone--active" : "intake-dropzone"}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        setDragging(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void accept(Array.from(event.dataTransfer.files));
      }}
      role="group"
    >
      <strong>{label}</strong>
      <span>Drag files here; they are copied without loading the audio into the UI.</span>
      {displayedProgress === undefined ? null : (
        <progress aria-label={`${label} copy progress`} max={1} value={displayedProgress} />
      )}
      {displayedMessage === undefined ? null : <span className="muted">{displayedMessage}</span>}
      {error === undefined ? null : <span className="intake-error">{error}</span>}
    </div>
  );
}

function QaReport({
  entries,
  onOpenMapping,
}: {
  readonly entries: readonly IntakeQaEntry[];
  readonly onOpenMapping?: (suggestion?: MappingSuggestion) => void;
}): ReactNode {
  const ordered = useMemo(() => orderQaEntries(entries), [entries]);
  if (ordered.length === 0) {
    return (
      <StatePanel
        kind="empty"
        message="The intake stage has not reported any quality issues."
        title="No QA entries"
      />
    );
  }
  return (
    <section aria-label="Intake QA report" className="intake-qa">
      <div className="list-card__header">
        <span>QA report</span>
        <span className="muted">
          {ordered.length} entr{ordered.length === 1 ? "y" : "ies"}
        </span>
      </div>
      {ordered.map((entry, index) => (
        <article
          className={`intake-qa__entry intake-qa__entry--${entry.severity}`}
          key={`${entry.code}-${index}`}
        >
          <span className="badge">{entry.severity.toUpperCase()}</span>
          <div>
            <strong>{entry.code}</strong>
            {entry.subject === undefined ? null : <span className="muted">{entry.subject}</span>}
            <p>{entry.message}</p>
            {entry.hint === undefined ? null : (
              <p className="intake-qa__hint">Hint: {entry.hint}</p>
            )}
          </div>
          {isMappingCode(entry.code) && onOpenMapping !== undefined ? (
            <button
              className="button button--secondary"
              onClick={() => onOpenMapping(entry.mapping)}
              type="button"
            >
              Mapping editor
            </button>
          ) : null}
        </article>
      ))}
    </section>
  );
}

function MappingEditor({
  suggestions,
  onSave,
}: {
  readonly suggestions: readonly MappingSuggestion[];
  readonly onSave?: (decisions: readonly MappingDecision[]) => Promise<void>;
}): ReactNode {
  const [choices, setChoices] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  if (suggestions.length === 0) return null;
  const save = async (): Promise<void> => {
    if (onSave === undefined) {
      setMessage("Mapping edits are available in the packaged desktop app.");
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const decisions = decisionsForSuggestions(suggestions, choices);
      await onSave(decisions);
      setMessage("Mappings saved. Run intake again to validate them.");
    } catch (caught) {
      setMessage(errorMessage(caught, "The mappings could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Mapping editor" className="intake-mapping">
      <div className="list-card__header">
        <span>Mapping editor</span>
        <span className="muted">Suggestions require your choice</span>
      </div>
      {suggestions.map((suggestion) => {
        const key = `${suggestion.kind}:${suggestion.observed}`;
        const selected = choices.get(key) ?? "";
        return (
          <label className="intake-mapping__row" key={key}>
            <span>
              <strong>{suggestion.observed}</strong>
              <small>{suggestion.kind} identity; ranked by similarity</small>
            </span>
            <select
              aria-label={`Map ${suggestion.observed}`}
              disabled={busy}
              onChange={(event) => {
                const next = new Map(choices);
                if (event.currentTarget.value === "") next.delete(key);
                else next.set(key, event.currentTarget.value);
                setChoices(next);
              }}
              value={selected}
            >
              <option value="">Leave unmapped</option>
              {suggestion.candidates.map((candidate) => (
                <option key={candidate.playerId} value={candidate.playerId}>
                  {candidate.displayName} ({Math.round(candidate.score * 100)}%)
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <div className="session-create__actions">
        <button className="button" disabled={busy} onClick={() => void save()} type="button">
          {busy ? "Saving..." : "Save mappings"}
        </button>
        {message === undefined ? null : <span className="muted">{message}</span>}
      </div>
    </section>
  );
}

export function IntakePage({
  session,
  paths,
  state = "idle",
  progress,
  copyProgress,
  qa,
  suggestions = [],
  error,
  onRunIntake,
  onDropFiles,
  onRevealPath,
  onCopyPath,
  onSaveMappings,
  onOpenMapping,
}: IntakePageProps): ReactNode {
  const [runError, setRunError] = useState<string>();
  const [running, setRunning] = useState(false);
  const run = async (): Promise<void> => {
    setRunError(undefined);
    setRunning(true);
    try {
      // A run is intentionally never disabled after completion; users need to
      // re-run immediately after a registry edit or a replacement input.
      await onRunIntake(true);
    } catch (caught) {
      setRunError(errorMessage(caught, "The intake stage could not be started."));
    } finally {
      setRunning(false);
    }
  };
  if (session === null) {
    return (
      <div className="page-content">
        <PageIntro
          description="Bring the audio and Roll20 capture together."
          kicker="Intake"
          title="No session selected"
        />
        <StatePanel
          kind="empty"
          message="Choose a session before running intake."
          title="Select a session"
        />
      </div>
    );
  }
  const displayedProgress = progress === undefined ? undefined : clampFraction(progress.fraction);
  const runMessage = runError ?? error;
  return (
    <div className="page-content">
      <PageIntro
        action={
          <button
            className="button"
            disabled={running || state === "running"}
            onClick={() => void run()}
            type="button"
          >
            {running || state === "running" ? "Running intake..." : "Run intake"}
          </button>
        }
        description="Drop the two source files, check the QA report, and resolve identity suggestions before continuing."
        kicker="Session intake"
        title={session.title}
      />
      {runMessage === undefined ? null : <p className="intake-error">{runMessage}</p>}
      {paths === undefined ? null : (
        <PathCard
          {...(onCopyPath === undefined ? {} : { onCopyPath })}
          {...(onRevealPath === undefined ? {} : { onRevealPath })}
          paths={paths}
        />
      )}
      <div className="intake-dropzones">
        <DropZone
          {...(copyProgress?.craig === undefined ? {} : { externalProgress: copyProgress.craig })}
          kind="craig"
          onDropFiles={onDropFiles}
        />
        <DropZone
          {...(copyProgress?.roll20 === undefined ? {} : { externalProgress: copyProgress.roll20 })}
          kind="roll20"
          onDropFiles={onDropFiles}
        />
      </div>
      {displayedProgress === undefined ? null : (
        <section aria-label="Intake progress" className="intake-progress">
          <div>
            <strong>{progress?.stage ?? "intake"}</strong>
            <span>{progress?.message ?? "Working..."}</span>
          </div>
          <progress max={1} value={displayedProgress} />
          <span>{String(Math.round(displayedProgress * 100))}%</span>
        </section>
      )}
      <QaReport entries={qa} {...(onOpenMapping === undefined ? {} : { onOpenMapping })} />
      <MappingEditor
        suggestions={suggestions}
        {...(onSaveMappings === undefined ? {} : { onSave: onSaveMappings })}
      />
    </div>
  );
}
