import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppHeader, Rail, StatusStrip, type ProviderStatus } from "./components.js";
import { NotesPage, ReviewPage, SessionsPage, SettingsPage } from "./pages.js";
import { hashForRoute, routeFromHash, type Route } from "./router.js";
import {
  createTransport,
  errorMessage,
  isUnavailableOperation,
  type RendererTransport,
  type DesktopEvent,
  type SessionSummary,
  type SidecarStatus,
  type SidecarStatusEvent,
} from "./transport.js";

type SessionsState = "loading" | "ready" | "empty" | "error";
type SettingsState = "loading" | "ready" | "error";
type SidecarSnapshot =
  | SidecarStatus
  | { readonly status: "unknown"; readonly reason?: string; readonly setupCommand?: string };

const BROWSER_SIDECAR: SidecarSnapshot = {
  status: "unknown",
  reason: "The preload bridge is only available in the packaged desktop shell.",
};

function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => {
    if (typeof window === "undefined") return "sessions";
    return routeFromHash(window.location.hash);
  });

  useEffect(() => {
    const onHashChange = (): void => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const nextHash = hashForRoute(next);
    if (window.location.hash === nextHash) {
      setRoute(next);
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return [route, navigate];
}

function pageForRoute(
  route: Route,
  sessions: readonly SessionSummary[],
  sessionsState: SessionsState,
  sessionsError: string | undefined,
  retrySessions: () => void,
  selectSession: (session: SessionSummary) => void,
  selectedSession: SessionSummary | null,
  settingsState: SettingsState,
  settingsError: string | undefined,
  retrySettings: () => void,
): ReactNode {
  switch (route) {
    case "sessions":
      return (
        <SessionsPage
          {...(sessionsError === undefined ? {} : { error: sessionsError })}
          onRetry={retrySessions}
          onSelect={selectSession}
          sessions={sessions}
          state={sessionsState}
        />
      );
    case "review":
      return <ReviewPage hasSession={selectedSession !== null} />;
    case "notes":
      return <NotesPage hasSession={selectedSession !== null} />;
    case "settings":
      return (
        <SettingsPage
          {...(settingsError === undefined ? {} : { error: settingsError })}
          onRetry={retrySettings}
          state={settingsState}
        />
      );
  }
}

function isTerminalRunEvent(type: string): boolean {
  return type === "run_completed" || type === "run_failed";
}

function sidecarEventSnapshot(event: SidecarStatusEvent): SidecarSnapshot {
  return {
    status: event.status,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.setupCommand === undefined ? {} : { setupCommand: event.setupCommand }),
  };
}

export function App({
  transport: providedTransport,
}: {
  readonly transport?: RendererTransport;
}): ReactNode {
  const [route, navigate] = useHashRoute();
  const detectedTransport = useMemo(() => createTransport(), []);
  const transport = providedTransport ?? detectedTransport;
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [sessionsState, setSessionsState] = useState<SessionsState>("loading");
  const [sessionsError, setSessionsError] = useState<string>();
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [settingsState, setSettingsState] = useState<SettingsState>("loading");
  const [settingsError, setSettingsError] = useState<string>();
  const [provider, setProvider] = useState<ProviderStatus>("unavailable");
  const [sidecar, setSidecar] = useState<SidecarSnapshot>(
    transport.kind === "browser" ? BROWSER_SIDECAR : { status: "stopped" },
  );
  const [activeRuns, setActiveRuns] = useState<ReadonlySet<string>>(() => new Set());

  const loadSessions = useCallback(async () => {
    setSessionsState("loading");
    setSessionsError(undefined);
    try {
      const response = await transport.sessions.list({ limit: 1_000 });
      setSessions(response.sessions);
      setSelectedSession((current) => {
        if (current !== null) {
          const refreshed = response.sessions.find((item) => item.sessionId === current.sessionId);
          return refreshed ?? current;
        }
        return response.sessions[0] ?? null;
      });
      setSessionsState(response.sessions.length === 0 ? "empty" : "ready");
    } catch (error) {
      setSessionsState("error");
      setSessionsError(errorMessage(error, "The sessions list could not be read."));
    }
  }, [transport]);

  const loadSettings = useCallback(async () => {
    setSettingsState("loading");
    setSettingsError(undefined);
    try {
      const response = await transport.settings.get();
      setProvider(response.settings.provider === undefined ? "not-configured" : "available");
      setSettingsState("ready");
    } catch (error) {
      setProvider("unavailable");
      setSettingsState("error");
      setSettingsError(errorMessage(error, "Settings are unavailable."));
    }
  }, [transport]);

  const loadSidecar = useCallback(async () => {
    try {
      const response = await transport.sidecar.status();
      setSidecar({
        status: response.status,
        ...(response.reason === undefined ? {} : { reason: response.reason }),
        ...(response.setupCommand === undefined ? {} : { setupCommand: response.setupCommand }),
      });
    } catch (error) {
      if (!isUnavailableOperation(error)) {
        setSidecar({ status: "unknown", reason: errorMessage(error, "Status is unavailable.") });
      }
    }
  }, [transport]);

  useEffect(() => {
    void loadSessions();
    void loadSettings();
    void loadSidecar();

    const onEvent = (event: DesktopEvent): void => {
      if (event.type === "sidecar_status") {
        setSidecar(sidecarEventSnapshot(event));
        return;
      }
      if (isTerminalRunEvent(event.type)) {
        setActiveRuns((current) => {
          const next = new Set(current);
          next.delete(event.runId);
          return next;
        });
        return;
      }
      setActiveRuns((current) => {
        const next = new Set(current);
        next.add(event.runId);
        return next;
      });
    };

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = transport.runs.onEvent(onEvent);
    } catch (error) {
      if (!isUnavailableOperation(error)) {
        setSidecar({ status: "unknown", reason: errorMessage(error, "Events are unavailable.") });
      }
    }
    return () => unsubscribe?.();
  }, [loadSessions, loadSettings, loadSidecar, transport]);

  const sessionTitle = selectedSession?.title ?? "No session selected";
  const sessionDate = selectedSession?.date;
  const page = pageForRoute(
    route,
    sessions,
    sessionsState,
    sessionsError,
    loadSessions,
    setSelectedSession,
    selectedSession,
    settingsState,
    settingsError,
    loadSettings,
  );

  return (
    <div className="app-shell">
      <Rail onNavigate={navigate} route={route} />
      <div className="app-shell__main">
        <AppHeader
          route={route}
          sessionTitle={sessionTitle}
          {...(sessionDate === undefined ? {} : { sessionDate })}
        />
        <StatusStrip activeRunCount={activeRuns.size} provider={provider} sidecar={sidecar} />
        <main className="app-shell__body">{page}</main>
      </div>
    </div>
  );
}
