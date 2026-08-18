import type { ReactNode } from "react";
import { PageIntro, StatePanel } from "./components.js";
import type { Route } from "./router.js";

export { SessionsPage } from "./pages/Sessions.js";
export type { SessionDraft, SessionScaffold, SessionsPageProps } from "./pages/Sessions.js";
export { filterAndSortSessions } from "./pages/Sessions.js";
export type { SessionListFilter } from "./pages/Sessions.js";
export { IntakePage } from "./pages/Intake.js";
export type {
  IntakeDropKind,
  IntakeDropPaths,
  IntakeCopyProgress,
  IntakePageProps,
  IntakeProgress,
  IntakeQaEntry,
  MappingCandidate,
  MappingDecision,
  MappingSuggestion,
} from "./pages/Intake.js";
export { decisionsForSuggestions, isMappingCode, orderQaEntries } from "./pages/Intake.js";

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
          message="Reading local configuration..."
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
        message={`The route "${route}" is not available.`}
        title="Unknown page"
      />
    </div>
  );
}
