import type { ReactNode } from "react";
import { VirtualList } from "./VirtualList.js";
import { PageIntro, StatePanel } from "./components.js";
import type { Route } from "./router.js";
import type { SessionSummary } from "./transport.js";

export interface SessionsPageProps {
  readonly sessions: readonly SessionSummary[];
  readonly state: "loading" | "ready" | "empty" | "error";
  readonly error?: string;
  readonly onRetry: () => void;
  readonly onSelect: (session: SessionSummary) => void;
}

function sessionDate(session: SessionSummary): string {
  if (session.date.length === 0) return "Date unknown";
  return session.date;
}

function sessionStatus(session: SessionSummary): string {
  if (session.status.length === 0) return "Unprocessed";
  return session.status;
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
        {session.number === null ? "—" : `#${String(session.number)}`}
      </span>
      <span className="session-row__main">
        <strong>{session.title}</strong>
        <span>
          {sessionDate(session)} · {sessionStatus(session)}
        </span>
      </span>
      <span className="session-row__meta">
        {session.durationS === null ? "No audio" : `${Math.round(session.durationS / 60)} min`}
        <span aria-hidden="true" className="session-row__arrow">
          →
        </span>
      </span>
    </button>
  );
}

export function SessionsPage({
  sessions,
  state,
  error,
  onRetry,
  onSelect,
}: SessionsPageProps): ReactNode {
  return (
    <div className="page-content">
      <PageIntro
        description="Your captured campaigns and the work still waiting to become notes."
        kicker="Workspace"
        title="Sessions"
      />
      {state === "loading" ? (
        <StatePanel
          kind="loading"
          message="Reading sessions from the local workspace…"
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
      ) : state === "empty" ? (
        <StatePanel
          kind="empty"
          message="Capture a Roll20 session and bring in the recording to see it here."
          title="No sessions yet"
        />
      ) : (
        <div className="list-card">
          <div className="list-card__header">
            <span>All sessions</span>
            <span className="muted">{sessions.length} total</span>
          </div>
          <VirtualList
            ariaLabel="Sessions"
            className="session-list"
            getKey={(session) => session.sessionId}
            items={sessions}
            renderRow={(session) => (
              <SessionRow onSelect={() => onSelect(session)} session={session} />
            )}
            rowHeight={72}
          />
        </div>
      )}
    </div>
  );
}

export function ReviewPage({ hasSession }: { readonly hasSession: boolean }): ReactNode {
  return (
    <div className="page-content">
      <PageIntro
        description="Resolve uncertain speakers and keep every attribution decision explainable."
        kicker="Quality"
        title="Review"
      />
      <StatePanel
        kind="empty"
        message={
          hasSession
            ? "This session has no flagged lines waiting for review."
            : "Choose a session first; review items will appear here when processing finds uncertainty."
        }
        title={hasSession ? "Nothing needs review" : "No session selected"}
      />
    </div>
  );
}

export function NotesPage({ hasSession }: { readonly hasSession: boolean }): ReactNode {
  return (
    <div className="page-content">
      <PageIntro
        description="A clean, searchable account of what happened at the table."
        kicker="Session record"
        title="Notes"
      />
      <StatePanel
        kind="empty"
        message={
          hasSession
            ? "Run the intake pipeline to turn this session into notes."
            : "Choose a session to open its notes and timeline."
        }
        title={hasSession ? "Notes are not processed yet" : "No session selected"}
      />
    </div>
  );
}

export function SettingsPage({
  state,
  error,
  onRetry,
}: {
  readonly state: "loading" | "ready" | "error";
  readonly error?: string;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="page-content">
      <PageIntro
        description="Keep provider choices and local paths explicit and under your control."
        kicker="Application"
        title="Settings"
      />
      {state === "loading" ? (
        <StatePanel
          kind="loading"
          message="Reading local configuration…"
          title="Loading settings"
        />
      ) : state === "error" ? (
        <StatePanel
          action={
            <button className="button button--secondary" onClick={onRetry} type="button">
              Try again
            </button>
          }
          kind="error"
          message={error ?? "Settings are unavailable."}
          title="Settings are unavailable"
        />
      ) : (
        <section className="settings-card">
          <div className="settings-card__row">
            <div>
              <strong>Local-first mode</strong>
              <p>Nothing leaves this workspace unless you explicitly configure a provider.</p>
            </div>
            <span className="badge badge--good">On</span>
          </div>
          <div className="settings-card__row">
            <div>
              <strong>Provider</strong>
              <p>Provider configuration is managed by the desktop setup.</p>
            </div>
            <span className="badge">Read-only</span>
          </div>
        </section>
      )}
    </div>
  );
}

export function UnknownRoutePage({ route }: { readonly route: Route }): ReactNode {
  return (
    <div className="page-content">
      <StatePanel
        kind="error"
        message={`The route “${route}” is not available.`}
        title="Unknown page"
      />
    </div>
  );
}
