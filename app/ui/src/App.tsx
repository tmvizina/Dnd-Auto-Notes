import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppHeader, Rail, StatusStrip, type ProviderStatus } from "./components.js";
import { RunPanel } from "./components/RunPanel.js";
import {
  IntakePage,
  NotesPage,
  ReviewPage,
  SessionsPage,
  SettingsPage,
  type SettingsCapabilities,
  type SettingsPageProps,
  type IntakeCopyProgress,
  type IntakeDropKind,
  type IntakePageProps,
  type IntakeProgress,
  type MappingDecision,
  type MappingSuggestion,
  type SessionDraft,
  type SessionScaffold,
} from "./pages.js";
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
import type { SettingKey } from "../../desktop/src/shared/contracts.js";

type SessionsState = "loading" | "ready" | "empty" | "error";
type SettingsState = "loading" | "ready" | "error";
type SidecarSnapshot =
  | (SidecarStatus & { readonly capabilities?: SettingsCapabilities })
  | {
      readonly status: "unknown";
      readonly reason?: string;
      readonly setupCommand?: string;
      readonly capabilities?: SettingsCapabilities;
    };

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

function isIntakeHash(hash: string): boolean {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw === "/sessions/intake" || raw === "sessions/intake";
}

function useIntakeView(): [boolean, () => void] {
  const [open, setOpen] = useState(() =>
    typeof window !== "undefined" ? isIntakeHash(window.location.hash) : false,
  );

  useEffect(() => {
    const onHashChange = (): void => setOpen(isIntakeHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openIntake = useCallback(() => {
    if (typeof window === "undefined") {
      setOpen(true);
      return;
    }
    const hash = "#/sessions/intake";
    if (window.location.hash === hash) setOpen(true);
    else window.location.hash = hash;
  }, []);

  return [open, openIntake];
}

function localSessionId(date: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${date}-${slug || "session"}`;
}

function dropKindForPath(path: string, paths: IntakePageProps["paths"]): IntakeDropKind | null {
  if (paths === undefined) return null;
  if (path === paths.craig) return "craig";
  if (path === paths.roll20) return "roll20";
  return null;
}

function fileSystemPath(file: File): string {
  const candidate = (file as File & { readonly path?: unknown }).path;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("The desktop file path is unavailable; use the packaged app to import files.");
  }
  return candidate;
}

function copyToClipboard(path: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined)
    return Promise.reject(new Error("Clipboard access is unavailable in this renderer."));
  return navigator.clipboard.writeText(path);
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
  settings: NonNullable<SettingsPageProps["settings"]>,
  settingsCapabilities: SettingsCapabilities | undefined,
  onSaveSetting: (key: SettingKey, value: string) => Promise<void>,
  onRevealSettingPath: SettingsPageProps["onRevealPath"],
  onTestConnection: SettingsPageProps["onTestConnection"],
  onRerunAttribution: SettingsPageProps["onRerun"],
  transport: RendererTransport,
  onCreate?: (draft: SessionDraft) => Promise<SessionScaffold>,
  onRevealPath?: (path: string) => Promise<void> | void,
  onCopyPath?: (path: string) => Promise<void> | void,
): ReactNode {
  switch (route) {
    case "sessions":
      return (
        <SessionsPage
          {...(sessionsError === undefined ? {} : { error: sessionsError })}
          onRetry={retrySessions}
          {...(onCopyPath === undefined ? {} : { onCopyPath })}
          {...(onCreate === undefined ? {} : { onCreate })}
          {...(onRevealPath === undefined ? {} : { onRevealPath })}
          onSelect={selectSession}
          sessions={sessions}
          state={sessionsState}
        />
      );
    case "review":
      return <ReviewPage sessionId={selectedSession?.sessionId ?? null} transport={transport} />;
    case "notes":
      return <NotesPage hasSession={selectedSession !== null} />;
    case "settings":
      return (
        <SettingsPage
          {...(settingsError === undefined ? {} : { error: settingsError })}
          onRetry={retrySettings}
          {...(settingsCapabilities === undefined ? {} : { capabilities: settingsCapabilities })}
          {...(onRevealSettingPath === undefined ? {} : { onRevealPath: onRevealSettingPath })}
          {...(onRerunAttribution === undefined ? {} : { onRerun: onRerunAttribution })}
          onSave={onSaveSetting}
          {...(onTestConnection === undefined ? {} : { onTestConnection })}
          settings={settings}
          state={settingsState}
        />
      );
  }
}

function isTerminalRunEvent(type: string): boolean {
  return type === "run_completed" || type === "run_failed";
}

function sidecarEventSnapshot(event: SidecarStatusEvent): SidecarSnapshot {
  const capabilities = settingsCapabilitiesFromReport(
    event.status,
    event.reason,
    event.capabilities,
  );
  return {
    status: event.status,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.setupCommand === undefined ? {} : { setupCommand: event.setupCommand }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function settingsCapabilitiesFromReport(
  status: SidecarStatusEvent["status"],
  reason: string | undefined,
  capabilities: Readonly<Record<string, boolean>> | undefined,
): SettingsCapabilities | undefined {
  if (capabilities === undefined) return undefined;
  return {
    available: status === "ready",
    ...(reason === undefined ? {} : { reason }),
    asrBackends: {
      auto:
        capabilities["mlx_whisper"] === true ||
        capabilities["faster_whisper"] === true ||
        capabilities["whisper_cpp"] === true ||
        capabilities["fake_asr"] === true,
      "mlx-whisper": capabilities["mlx_whisper"] === true,
      "faster-whisper": capabilities["faster_whisper"] === true,
      "whisper.cpp": capabilities["whisper_cpp"] === true,
      fake: capabilities["fake_asr"] === true,
    },
  };
}

export function App({
  transport: providedTransport,
}: {
  readonly transport?: RendererTransport;
}): ReactNode {
  const [route, navigate] = useHashRoute();
  const [intakeOpen, openIntake] = useIntakeView();
  const detectedTransport = useMemo(() => createTransport(), []);
  const transport = providedTransport ?? detectedTransport;
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [sessionsState, setSessionsState] = useState<SessionsState>("loading");
  const [sessionsError, setSessionsError] = useState<string>();
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [settingsState, setSettingsState] = useState<SettingsState>("loading");
  const [settingsError, setSettingsError] = useState<string>();
  const [settings, setSettings] = useState<NonNullable<SettingsPageProps["settings"]>>({});
  const [provider, setProvider] = useState<ProviderStatus>("unavailable");
  const [sidecar, setSidecar] = useState<SidecarSnapshot>(
    transport.kind === "browser" ? BROWSER_SIDECAR : { status: "stopped" },
  );
  const [activeRuns, setActiveRuns] = useState<ReadonlySet<string>>(() => new Set());
  const [runIdsBySession, setRunIdsBySession] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [intakePaths, setIntakePaths] = useState<IntakePageProps["paths"]>();
  const [intakeQa, setIntakeQa] = useState<IntakePageProps["qa"]>([]);
  const [intakeSuggestions, setIntakeSuggestions] = useState<readonly MappingSuggestion[]>([]);
  const [intakeState, setIntakeState] = useState<NonNullable<IntakePageProps["state"]>>("idle");
  const [intakeProgress, setIntakeProgress] = useState<IntakeProgress>();
  const [intakeCopyProgress, setIntakeCopyProgress] = useState<
    Partial<Record<IntakeDropKind, IntakeCopyProgress>>
  >({});
  const [intakeError, setIntakeError] = useState<string>();

  const loadIntakeData = useCallback(
    async (sessionId: string, afterRun = false): Promise<void> => {
      setIntakeError(undefined);
      try {
        const detail = await transport.sessions.get({ sessionId });
        if (detail.session === null)
          throw new Error("The selected session is no longer available.");
        setSelectedSession(detail.session);
        setIntakePaths(detail.paths);
        const report = await transport.sessions.qa({ sessionId });
        setIntakeQa(report.entries);
        setIntakeSuggestions(report.suggestions);
        if (afterRun) setIntakeState("complete");
        else setIntakeState("idle");
      } catch (error) {
        setIntakeState("error");
        setIntakeError(errorMessage(error, "The intake report could not be read."));
      }
    },
    [transport],
  );

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
      setSettings(response.settings);
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
      const capabilities = settingsCapabilitiesFromReport(
        response.status,
        response.reason,
        response.capabilities,
      );
      setSidecar({
        status: response.status,
        ...(response.reason === undefined ? {} : { reason: response.reason }),
        ...(response.setupCommand === undefined ? {} : { setupCommand: response.setupCommand }),
        ...(capabilities === undefined ? {} : { capabilities }),
      });
    } catch (error) {
      if (!isUnavailableOperation(error)) {
        setSidecar({ status: "unknown", reason: errorMessage(error, "Status is unavailable.") });
      }
    }
  }, [transport]);

  const saveSetting = useCallback(
    async (key: SettingKey, value: string): Promise<void> => {
      const response = await transport.settings.set({ key, value });
      setSettings((current) => ({ ...current, [response.key]: response.value }));
      if (response.key === "provider")
        setProvider(response.value === "none" ? "not-configured" : "available");
    },
    [transport],
  );

  const revealSettingPath = useCallback<NonNullable<SettingsPageProps["onRevealPath"]>>(
    async (key) => {
      const response = await transport.settings.reveal({ key });
      return response.revealed;
    },
    [transport],
  );

  const testSettingsConnection = useCallback<NonNullable<SettingsPageProps["onTestConnection"]>>(
    (request) => transport.settings.testConnection(request),
    [transport],
  );

  const startPipeline = useCallback(
    async (request: {
      sessionId: string;
      stages: readonly string[];
      force: boolean;
    }): Promise<string> => {
      const response = await transport.pipeline.run(request);
      setRunIdsBySession((current) => {
        const next = new Map(current);
        next.set(request.sessionId, response.runId);
        return next;
      });
      return response.runId;
    },
    [transport],
  );

  const rerunAttribution = useCallback<NonNullable<SettingsPageProps["onRerun"]>>(async () => {
    if (selectedSession === null)
      throw new Error("Choose a session before re-running attribution.");
    await startPipeline({
      sessionId: selectedSession.sessionId,
      stages: ["persona"],
      force: true,
    });
  }, [selectedSession, startPipeline]);

  const selectSession = useCallback(
    (session: SessionSummary): void => {
      setSelectedSession(session);
      setIntakeQa([]);
      setIntakeSuggestions([]);
      setIntakeProgress(undefined);
      setIntakeError(undefined);
      void loadIntakeData(session.sessionId);
      openIntake();
    },
    [loadIntakeData, openIntake],
  );

  const createSession = useCallback(
    async (draft: SessionDraft): Promise<SessionScaffold> => {
      const response = await transport.sessions.create({
        sessionId: localSessionId(draft.date, draft.title),
        title: draft.title,
        number: draft.number,
        date: draft.date,
      });
      await loadSessions();
      setSelectedSession(response.session);
      setIntakeQa([]);
      setIntakeSuggestions([]);
      setIntakeProgress(undefined);
      setIntakeError(undefined);
      const paths =
        response.paths ??
        (await transport.sessions.get({ sessionId: response.session.sessionId })).paths;
      if (paths === undefined)
        throw new Error("The new session drop folders could not be created.");
      setIntakePaths(paths);
      openIntake();
      return {
        session: response.session,
        craigPath: paths.craig,
        roll20Path: paths.roll20,
      };
    },
    [loadSessions, openIntake, transport],
  );

  const revealPath = useCallback(
    async (path: string): Promise<void> => {
      if (selectedSession === null) throw new Error("Choose a session before revealing a path.");
      const kind = dropKindForPath(path, intakePaths);
      if (kind === null) throw new Error("That path is no longer associated with this session.");
      const result = await transport.sessions.reveal({
        sessionId: selectedSession.sessionId,
        kind,
      });
      if (!result.revealed)
        throw new Error("The folder could not be revealed in the file manager.");
    },
    [intakePaths, selectedSession, transport],
  );

  const copyDroppedFiles = useCallback(
    async (
      kind: IntakeDropKind,
      files: readonly File[],
      onProgress: (fraction: number, message?: string) => void,
    ): Promise<void> => {
      if (selectedSession === null) throw new Error("Choose a session before importing files.");
      if (files.length === 0) return;
      for (const [index, file] of files.entries()) {
        const sourcePath = fileSystemPath(file);
        const base = index / files.length;
        const span = 1 / files.length;
        onProgress(base, `Copying ${file.name || "input"}...`);
        const response = await transport.sessions.copy({
          sessionId: selectedSession.sessionId,
          kind,
          sourcePath,
        });
        onProgress(base + span, `Copied ${response.destinationName}.`);
      }
      setIntakeCopyProgress((current) => ({
        ...current,
        [kind]: {
          fraction: 1,
          message: `${String(files.length)} file${files.length === 1 ? "" : "s"} copied.`,
        },
      }));
      await loadIntakeData(selectedSession.sessionId);
    },
    [loadIntakeData, selectedSession, transport],
  );

  const runIntake = useCallback(
    async (force: boolean): Promise<void> => {
      if (selectedSession === null) throw new Error("Choose a session before running intake.");
      setIntakeError(undefined);
      setIntakeState("running");
      setIntakeProgress({ stage: "intake", fraction: 0, message: "Starting intake..." });
      try {
        await startPipeline({
          sessionId: selectedSession.sessionId,
          stages: ["intake"],
          force,
        });
      } catch (error) {
        setIntakeState("error");
        setIntakeError(errorMessage(error, "The intake stage could not be started."));
        throw error;
      }
    },
    [selectedSession, startPipeline],
  );

  const saveMappings = useCallback(
    async (decisions: readonly MappingDecision[]): Promise<void> => {
      if (selectedSession === null) throw new Error("Choose a session before saving mappings.");
      const response = await transport.sessions.mapping({
        sessionId: selectedSession.sessionId,
        decisions,
      });
      if (!response.saved) throw new Error("The mapping registry was not changed.");
      await loadIntakeData(selectedSession.sessionId);
    },
    [loadIntakeData, selectedSession, transport],
  );

  const openMapping = useCallback((): void => {
    if (typeof document === "undefined") return;
    document.querySelector('[aria-label="Mapping editor"]')?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadSettings();
    void loadSidecar();

    const onEvent = (event: DesktopEvent): void => {
      if (event.type === "sidecar_status") {
        const snapshot = sidecarEventSnapshot(event);
        setSidecar((current) =>
          snapshot.capabilities === undefined && current.capabilities !== undefined
            ? { ...snapshot, capabilities: current.capabilities }
            : snapshot,
        );
        return;
      }
      if (event.type === "copy_progress") {
        setIntakeCopyProgress((current) => ({
          ...current,
          [event.kind]: {
            fraction: event.progress,
            message:
              event.message ??
              `Copied ${String(event.bytesCopied)} of ${String(event.totalBytes)} bytes.`,
          },
        }));
        return;
      }
      if (event.type === "stage_started" && event.stage === "intake") {
        setIntakeState("running");
        setIntakeProgress({ stage: event.stage, fraction: 0, message: "Starting intake..." });
      } else if (event.type === "stage_progress" && event.stage === "intake") {
        setIntakeProgress({
          stage: event.stage,
          fraction: event.progress,
          message: event.message ?? "Working...",
        });
      } else if (event.type === "stage_skipped" && event.stage === "intake") {
        setIntakeProgress({
          stage: event.stage,
          fraction: 1,
          message: "Intake is already current.",
        });
      } else if (event.type === "stage_failed" && event.stage === "intake") {
        setIntakeState("error");
        setIntakeError(event.error.message);
      }
      if (isTerminalRunEvent(event.type)) {
        setActiveRuns((current) => {
          const next = new Set(current);
          next.delete(event.runId);
          return next;
        });
        if (event.type === "run_failed") {
          setIntakeState("error");
          setIntakeError(event.error.message);
        } else {
          setIntakeState("complete");
          setIntakeProgress((current) =>
            current === undefined
              ? { stage: "intake", fraction: 1, message: "Intake complete." }
              : { ...current, fraction: 1, message: "Intake complete." },
          );
          if (selectedSession !== null) void loadIntakeData(selectedSession.sessionId, true);
        }
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
  }, [loadIntakeData, loadSessions, loadSettings, loadSidecar, selectedSession, transport]);

  const sessionTitle = selectedSession?.title ?? "No session selected";
  const sessionDate = selectedSession?.date;
  const page =
    intakeOpen && route === "sessions" ? (
      <>
        <IntakePage
          {...(intakeError === undefined ? {} : { error: intakeError })}
          {...(intakePaths === undefined ? {} : { paths: intakePaths })}
          copyProgress={intakeCopyProgress}
          onCopyPath={copyToClipboard}
          onDropFiles={copyDroppedFiles}
          onOpenMapping={openMapping}
          onRevealPath={revealPath}
          onRunIntake={runIntake}
          onSaveMappings={saveMappings}
          {...(intakeProgress === undefined ? {} : { progress: intakeProgress })}
          qa={intakeQa}
          session={selectedSession}
          state={intakeState}
          suggestions={intakeSuggestions}
        />
        <RunPanel
          runId={
            selectedSession === null
              ? null
              : (runIdsBySession.get(selectedSession.sessionId) ?? null)
          }
          stageNames={["intake"]}
          title="Pipeline run"
          transport={transport}
        />
      </>
    ) : (
      pageForRoute(
        route,
        sessions,
        sessionsState,
        sessionsError,
        loadSessions,
        selectSession,
        selectedSession,
        settingsState,
        settingsError,
        loadSettings,
        settings,
        sidecar.capabilities,
        saveSetting,
        revealSettingPath,
        testSettingsConnection,
        rerunAttribution,
        transport,
        createSession,
        revealPath,
      )
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
