import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { VirtualList } from "../VirtualList.js";
import { PageIntro, StatePanel } from "../components.js";
import { errorMessage, type SessionSummary } from "../transport.js";

export interface SessionDraft {
  readonly title: string;
  readonly number: number | null;
  readonly date: string;
}

export interface SessionScaffold {
  readonly session: SessionSummary;
  readonly craigPath: string;
  readonly roll20Path: string;
}

export interface SessionsPageProps {
  readonly sessions: readonly SessionSummary[];
  readonly state: "loading" | "ready" | "empty" | "error";
  readonly error?: string;
  readonly onRetry: () => void;
  readonly onSelect: (session: SessionSummary) => void;
  readonly onCreate?: (draft: SessionDraft) => Promise<SessionScaffold>;
  readonly onRevealPath?: (path: string) => Promise<void> | void;
  readonly onCopyPath?: (path: string) => Promise<void> | void;
}

type DateOrder = "newest" | "oldest";

export interface SessionListFilter {
  readonly dateOrder: DateOrder;
  readonly grade: string;
  readonly fromDate: string;
  readonly toDate: string;
}

export function filterAndSortSessions(
  sessions: readonly SessionSummary[],
  filter: SessionListFilter,
): readonly SessionSummary[] {
  const result = sessions.filter((session) => {
    if (filter.grade !== "all" && (session.grade ?? "pending") !== filter.grade) return false;
    if (filter.fromDate !== "" && session.date < filter.fromDate) return false;
    if (filter.toDate !== "" && session.date > filter.toDate) return false;
    return true;
  });
  result.sort((left, right) => {
    const dateComparison = left.date.localeCompare(right.date);
    if (dateComparison !== 0)
      return filter.dateOrder === "newest" ? -dateComparison : dateComparison;
    return left.sessionId.localeCompare(right.sessionId);
  });
  return result;
}

function dateText(session: SessionSummary): string {
  return session.date.length === 0 ? "Date unknown" : session.date;
}

function durationText(session: SessionSummary): string {
  if (session.durationS === null) return "No duration";
  const minutes = Math.max(0, Math.round(session.durationS / 60));
  return `${String(minutes)} min`;
}

function statusText(session: SessionSummary): string {
  return session.status.length === 0 ? "Unprocessed" : session.status;
}

function gradeText(session: SessionSummary): string {
  return session.grade === null || session.grade.length === 0
    ? "QA pending"
    : `QA ${session.grade}`;
}

function gradeRank(value: string | null): number {
  if (value === "A") return 0;
  if (value === "B") return 1;
  if (value === "C") return 2;
  if (value === "D") return 3;
  return 4;
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

function SessionRow({
  session,
  onSelect,
}: {
  readonly session: SessionSummary;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <button className="session-row" onClick={onSelect} type="button">
      <span className="session-row__number">
        {session.number === null ? "-" : `#${String(session.number)}`}
      </span>
      <span className="session-row__main">
        <strong>{session.title}</strong>
        <span>
          {dateText(session)} - {durationText(session)}
        </span>
        <span className="session-row__badges">
          <span className="badge">{statusText(session)}</span>
          <span className={session.grade === null ? "badge" : "badge badge--good"}>
            {gradeText(session)}
          </span>
          <span className="badge">{session.hasNotes ? "Notes ready" : "No notes"}</span>
        </span>
      </span>
      <span aria-hidden="true" className="session-row__arrow">
        &gt;
      </span>
    </button>
  );
}

function NewSessionForm({
  onCreate,
  onCreated,
}: {
  readonly onCreate: (draft: SessionDraft) => Promise<SessionScaffold>;
  readonly onCreated: (scaffold: SessionScaffold) => void;
}): ReactNode {
  const [title, setTitle] = useState("");
  const [number, setNumber] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (cleanTitle === "") {
      setError("A session title is required.");
      return;
    }
    const parsedNumber = number.trim() === "" ? null : Number.parseInt(number, 10);
    if (parsedNumber !== null && (!Number.isInteger(parsedNumber) || parsedNumber <= 0)) {
      setError("Session number must be a positive whole number.");
      return;
    }
    if (date.trim() === "") {
      setError("A session date is required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const scaffold = await onCreate({ title: cleanTitle, number: parsedNumber, date });
      onCreated(scaffold);
      setTitle("");
      setNumber("");
    } catch (caught) {
      setError(errorMessage(caught, "The session could not be created."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="New session" className="list-card">
      <form className="session-create" onSubmit={(event) => void submit(event)}>
        <div className="session-create__fields">
          <label>
            Title
            <input
              autoFocus
              disabled={busy}
              onChange={(event) => setTitle(event.currentTarget.value)}
              value={title}
            />
          </label>
          <label>
            Number
            <input
              disabled={busy}
              inputMode="numeric"
              min={1}
              onChange={(event) => setNumber(event.currentTarget.value)}
              type="number"
              value={number}
            />
          </label>
          <label>
            Date
            <input
              disabled={busy}
              onChange={(event) => setDate(event.currentTarget.value)}
              type="date"
              value={date}
            />
          </label>
        </div>
        {error === undefined ? null : <p className="intake-error">{error}</p>}
        <div className="session-create__actions">
          <button className="button" disabled={busy} type="submit">
            {busy ? "Creating..." : "Create session"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ScaffoldCard({
  scaffold,
  onRevealPath,
  onCopyPath,
}: {
  readonly scaffold: SessionScaffold;
  readonly onRevealPath?: (path: string) => Promise<void> | void;
  readonly onCopyPath?: (path: string) => Promise<void> | void;
}): ReactNode {
  const [message, setMessage] = useState<string>();
  const reveal = async (path: string): Promise<void> => {
    try {
      if (onRevealPath === undefined) {
        setMessage("Reveal is available in the desktop app.");
        return;
      }
      await onRevealPath(path);
    } catch (caught) {
      setMessage(errorMessage(caught, "The folder could not be revealed."));
    }
  };
  const copy = async (path: string): Promise<void> => {
    try {
      await copyPath(path, onCopyPath);
      setMessage("Path copied.");
    } catch (caught) {
      setMessage(errorMessage(caught, "The path could not be copied."));
    }
  };
  const rows = [
    ["Craig audio", scaffold.craigPath],
    ["Roll20 capture", scaffold.roll20Path],
  ] as const;
  return (
    <section aria-label="Session drop folders" className="intake-scaffold">
      <div>
        <p className="eyebrow">Session ready</p>
        <h2>Drop the inputs into these folders</h2>
      </div>
      {rows.map(([label, path]) => (
        <div className="intake-path" key={label}>
          <span>
            <strong>{label}</strong>
            <code>{path}</code>
          </span>
          <span className="intake-path__actions">
            <button
              className="button button--secondary"
              onClick={() => void copy(path)}
              type="button"
            >
              Copy path
            </button>
            <button
              className="button button--secondary"
              onClick={() => void reveal(path)}
              type="button"
            >
              Reveal
            </button>
          </span>
        </div>
      ))}
      {message === undefined ? null : <p className="muted">{message}</p>}
    </section>
  );
}

export function SessionsPage({
  sessions,
  state,
  error,
  onRetry,
  onSelect,
  onCreate,
  onRevealPath,
  onCopyPath,
}: SessionsPageProps): ReactNode {
  const [dateOrder, setDateOrder] = useState<DateOrder>("newest");
  const [gradeFilter, setGradeFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [scaffold, setScaffold] = useState<SessionScaffold>();

  const filtered = useMemo(
    () => filterAndSortSessions(sessions, { dateOrder, grade: gradeFilter, fromDate, toDate }),
    [dateOrder, fromDate, gradeFilter, sessions, toDate],
  );

  return (
    <div className="page-content">
      <PageIntro
        action={
          onCreate === undefined ? null : (
            <button className="button" onClick={() => setShowCreate((open) => !open)} type="button">
              {showCreate ? "Close" : "New session"}
            </button>
          )
        }
        description="Your captured campaigns and the work still waiting to become notes."
        kicker="Workspace"
        title="Sessions"
      />
      {showCreate && onCreate !== undefined ? (
        <NewSessionForm
          onCreate={onCreate}
          onCreated={(created) => {
            setScaffold(created);
            setShowCreate(false);
          }}
        />
      ) : null}
      {scaffold === undefined ? null : (
        <ScaffoldCard
          {...(onCopyPath === undefined ? {} : { onCopyPath })}
          {...(onRevealPath === undefined ? {} : { onRevealPath })}
          scaffold={scaffold}
        />
      )}
      {state === "loading" ? (
        <StatePanel
          kind="loading"
          message="Reading sessions from the local workspace..."
          title="Loading sessions"
        />
      ) : state === "error" ? (
        <StatePanel
          action={
            <button className="button button--secondary" onClick={onRetry} type="button">
              Try again
            </button>
          }
          kind="error"
          message={error ?? "The sessions list could not be read."}
          title="Sessions are unavailable"
        />
      ) : state === "empty" || filtered.length === 0 ? (
        <StatePanel
          kind="empty"
          message={
            sessions.length === 0
              ? "Capture a Roll20 session and bring in the recording to see it here."
              : "No sessions match the selected date and QA filters."
          }
          title={sessions.length === 0 ? "No sessions yet" : "No matching sessions"}
        />
      ) : (
        <div className="list-card">
          <div className="list-card__header">
            <span>All sessions</span>
            <span className="muted">
              {filtered.length} shown / {sessions.length} total
            </span>
          </div>
          <div aria-label="Session filters" className="session-filters">
            <label>
              Sort
              <select
                onChange={(event) => setDateOrder(event.currentTarget.value as DateOrder)}
                value={dateOrder}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
            <label>
              QA grade
              <select
                onChange={(event) => setGradeFilter(event.currentTarget.value)}
                value={gradeFilter}
              >
                <option value="all">All grades</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="D">D</option>
                <option value="pending">Pending</option>
              </select>
            </label>
            <label>
              From
              <input
                onChange={(event) => setFromDate(event.currentTarget.value)}
                type="date"
                value={fromDate}
              />
            </label>
            <label>
              To
              <input
                onChange={(event) => setToDate(event.currentTarget.value)}
                type="date"
                value={toDate}
              />
            </label>
          </div>
          <VirtualList
            ariaLabel="Sessions"
            className="session-list"
            getKey={(session) => session.sessionId}
            items={filtered}
            renderRow={(session) => (
              <SessionRow onSelect={() => onSelect(session)} session={session} />
            )}
            rowHeight={96}
          />
        </div>
      )}
    </div>
  );
}

export { gradeRank };
