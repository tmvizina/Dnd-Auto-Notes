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
export { SettingsPage } from "./pages/Settings.js";
export type { SettingsCapabilities, SettingsPageProps } from "./pages/Settings.js";

export { ReviewPage } from "./pages/Review.js";
export type { ReviewPageProps } from "./pages/Review.js";

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
