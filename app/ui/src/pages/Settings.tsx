import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PageIntro, StatePanel } from "../components.js";
import type {
  PathSettingKey,
  SettingKey,
  SettingsTestConnectionRequest,
  SettingsTestConnectionResponse,
} from "../../../desktop/src/shared/contracts.js";

export type SettingsMap = Partial<Record<SettingKey, string>>;
export type ConnectionTestRequest = SettingsTestConnectionRequest;
export type ConnectionTestResult = SettingsTestConnectionResponse;

export interface PersonaThresholds {
  readonly lo: number;
  readonly hi: number;
  readonly matchMinMargin: number;
}

export interface SettingsCapabilities {
  readonly available: boolean;
  readonly reason?: string;
  readonly asrBackends?: Readonly<Record<string, boolean>>;
  readonly asrModels?: readonly string[];
  readonly languages?: readonly string[];
  readonly glossary?: boolean;
}

export interface SettingsPageProps {
  readonly state?: "loading" | "ready" | "error";
  readonly error?: string;
  readonly settings?: SettingsMap;
  readonly capabilities?: SettingsCapabilities;
  readonly onRetry?: () => void;
  readonly onSave?: (key: SettingKey, value: string) => Promise<void> | void;
  readonly onRevealPath?: (
    key: PathSettingKey,
    path: string,
  ) => Promise<boolean | void> | boolean | void;
  readonly onTestConnection?: (request: ConnectionTestRequest) => Promise<ConnectionTestResult>;
  readonly onRerun?: () => Promise<void> | void;
}

const PATH_SETTING_KEYS = ["sessionsRoot", "campaignRoot", "sidecarPath"] as const;

export const DEFAULT_SETTINGS: Readonly<SettingsMap> = {
  provider: "none",
  providerModel: "",
  providerPermissionMode: "default",
  localEndpoint: "http://127.0.0.1:1234/v1",
  asrBackend: "auto",
  asrModel: "base",
  asrLanguage: "auto",
  asrGlossaryEnabled: "true",
  personaThresholds: JSON.stringify({ lo: 0.35, hi: 0.65, matchMinMargin: 0.1 }),
};

const PROVIDERS = [
  ["none", "Offline / no provider"],
  ["cli-claude", "Claude CLI"],
  ["cli-codex", "Codex CLI"],
  ["http-local", "OpenAI-compatible HTTP"],
] as const;

const PERMISSION_MODES = [
  ["default", "Default permissions"],
  ["acceptEdits", "Accept edits"],
  ["plan", "Plan only"],
  ["bypassPermissions", "Bypass permissions"],
] as const;

const ASR_BACKENDS = [
  ["auto", "Automatic"],
  ["mlx-whisper", "mlx-whisper"],
  ["faster-whisper", "faster-whisper"],
  ["whisper.cpp", "whisper.cpp"],
  ["fake", "Fixture backend"],
] as const;

const PATH_LABELS: Readonly<Record<PathSettingKey, string>> = {
  sessionsRoot: "Sessions root",
  campaignRoot: "Campaign root",
  sidecarPath: "Sidecar directory",
};

const PATH_DESCRIPTIONS: Readonly<Record<PathSettingKey, string>> = {
  sessionsRoot: "Where imported sessions and derived artifacts are stored.",
  campaignRoot: "The campaign registry containing players, characters and glossary data.",
  sidecarPath: "The local Python sidecar directory; restart after changing it.",
};

const RESTART_REQUIRED_KEYS = new Set<SettingKey>(["sessionsRoot", "campaignRoot", "sidecarPath"]);
const NOT_CONSUMED_KEYS = new Set<SettingKey>([
  "provider",
  "providerModel",
  "providerPermissionMode",
  "localEndpoint",
  "asrBackend",
  "asrModel",
  "asrLanguage",
  "asrGlossaryEnabled",
  "personaThresholds",
]);

function settingsWithDefaults(settings: SettingsMap | undefined): SettingsMap {
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export function parseThresholds(value: string | undefined): PersonaThresholds {
  if (value !== undefined) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const lo = record["lo"];
        const hi = record["hi"];
        const matchMinMargin = record["matchMinMargin"] ?? record["match_min_margin"];
        if (
          typeof lo === "number" &&
          typeof hi === "number" &&
          typeof matchMinMargin === "number" &&
          Number.isFinite(lo) &&
          Number.isFinite(hi) &&
          Number.isFinite(matchMinMargin)
        ) {
          return { lo, hi, matchMinMargin };
        }
      }
    } catch {
      // The desktop validator will explain malformed persisted values. Keep
      // the editor usable long enough for the user to replace it.
    }
  }
  return { lo: 0.35, hi: 0.65, matchMinMargin: 0.1 };
}

export function capabilityReason(
  capabilities: SettingsCapabilities | undefined,
  kind: "backend" | "model" | "language" | "glossary",
  value?: string,
): string | undefined {
  if (capabilities === undefined)
    return "The sidecar capability report is unavailable. Start the sidecar to enable this option.";
  if (!capabilities.available)
    return capabilities.reason ?? "The sidecar is unavailable; start it to use ASR settings.";
  if (kind === "backend") {
    if (capabilities.asrBackends === undefined)
      return "This option is disabled until the sidecar reports its installed backends.";
    if (value === "auto") {
      return Object.values(capabilities.asrBackends).some(Boolean)
        ? undefined
        : "No ASR backend is currently available.";
    }
    if (value === undefined || capabilities.asrBackends[value] !== true)
      return "This backend is not reported by the sidecar on this machine.";
    return undefined;
  }
  if (kind === "model") {
    return capabilities.asrModels === undefined
      ? "Models are disabled until the sidecar reports its capabilities."
      : capabilities.asrModels.length === 0
        ? "No ASR models are reported by the sidecar."
        : undefined;
  }
  if (kind === "language") {
    return capabilities.languages === undefined
      ? "Languages are disabled until the sidecar reports its capabilities."
      : capabilities.languages.length === 0
        ? "No ASR languages are reported by the sidecar."
        : undefined;
  }
  return capabilities.glossary === true
    ? undefined
    : "Glossary support is not reported by the selected sidecar backend.";
}

function PathSetting({
  keyName,
  value,
  busy,
  onChange,
  onSave,
  onReveal,
}: {
  readonly keyName: PathSettingKey;
  readonly value: string;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReveal: () => void;
}): ReactNode {
  return (
    <div className="settings-card__row">
      <div>
        <strong>{PATH_LABELS[keyName]}</strong>
        <p>{PATH_DESCRIPTIONS[keyName]}</p>
      </div>
      <div>
        <input
          aria-label={PATH_LABELS[keyName]}
          disabled={busy}
          onBlur={onSave}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder="Choose a local path"
          type="text"
          value={value}
        />
        <button
          className="button button--secondary"
          disabled={busy || value.trim() === ""}
          onClick={onReveal}
          type="button"
        >
          Reveal
        </button>
      </div>
    </div>
  );
}

function CapabilityNote({ message }: { readonly message: string | undefined }): ReactNode {
  return message === undefined ? null : (
    <p aria-live="polite" className="muted">
      {message}
    </p>
  );
}

export function SettingsPage({
  state = "ready",
  error,
  settings,
  capabilities,
  onRetry,
  onSave,
  onRevealPath,
  onTestConnection,
  onRerun,
}: SettingsPageProps): ReactNode {
  const initial = useMemo(() => settingsWithDefaults(settings), [settings]);
  const [draft, setDraft] = useState<SettingsMap>(initial);
  const [thresholds, setThresholds] = useState<PersonaThresholds>(() =>
    parseThresholds(initial.personaThresholds),
  );
  const [savingKey, setSavingKey] = useState<SettingKey>();
  const [message, setMessage] = useState<string>();
  const [connection, setConnection] = useState<ConnectionTestResult>();
  const [testingConnection, setTestingConnection] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  useEffect(() => {
    setDraft(initial);
    setThresholds(parseThresholds(initial.personaThresholds));
  }, [initial]);

  const save = async (key: SettingKey, value: string): Promise<void> => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (onSave === undefined) {
      setMessage("Changes are ready for the desktop settings bridge.");
      return;
    }
    setSavingKey(key);
    setMessage(undefined);
    try {
      await onSave(key, value);
      setMessage(
        RESTART_REQUIRED_KEYS.has(key)
          ? `${key} saved; restart the desktop app for this path to take effect.`
          : NOT_CONSUMED_KEYS.has(key)
            ? `${key} saved; the current pipeline does not consume this setting yet.`
            : `${key} saved; the change is active without restarting.`,
      );
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : `Could not save ${key}.`);
    } finally {
      setSavingKey(undefined);
    }
  };

  const updateText = (key: SettingKey, value: string): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const saveThreshold = (key: keyof PersonaThresholds, raw: string): void => {
    const numeric = Number(raw);
    const next = { ...thresholds, [key]: Number.isFinite(numeric) ? numeric : thresholds[key] };
    setThresholds(next);
    void save("personaThresholds", JSON.stringify(next));
  };

  const reveal = async (key: PathSettingKey): Promise<void> => {
    const path = draft[key]?.trim() ?? "";
    if (path === "") {
      setMessage(`${PATH_LABELS[key]} has not been configured.`);
      return;
    }
    if (onRevealPath === undefined) {
      setMessage("Reveal is available in the packaged desktop app.");
      return;
    }
    try {
      const result = await onRevealPath(key, path);
      setMessage(
        result === false ? `${PATH_LABELS[key]} could not be revealed.` : "Path revealed.",
      );
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The path could not be revealed.");
    }
  };

  const testConnection = async (): Promise<void> => {
    if (onTestConnection === undefined) {
      setConnection({
        ok: false,
        latencyMs: null,
        models: [],
        message: "Connection testing is available in the packaged desktop app.",
      });
      return;
    }
    setTestingConnection(true);
    setConnection(undefined);
    try {
      setConnection(
        await onTestConnection({
          baseUrl: draft.localEndpoint ?? "",
          ...(draft.providerModel === undefined ? {} : { model: draft.providerModel }),
        }),
      );
    } catch (caught) {
      setConnection({
        ok: false,
        latencyMs: null,
        models: [],
        message: caught instanceof Error ? caught.message : "The provider connection failed.",
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const rerun = async (): Promise<void> => {
    if (onRerun === undefined) {
      setMessage("Re-run is available from the session intake page.");
      return;
    }
    setRerunning(true);
    try {
      await onRerun();
      setMessage("Re-run requested.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The re-run could not be requested.");
    } finally {
      setRerunning(false);
    }
  };

  if (state === "loading")
    return (
      <div className="page-content">
        <PageIntro
          description="Keep provider choices and local paths explicit and under your control."
          kicker="Application"
          title="Settings"
        />
        <StatePanel
          kind="loading"
          message="Reading local configuration..."
          title="Loading settings"
        />
      </div>
    );
  if (state === "error")
    return (
      <div className="page-content">
        <PageIntro
          description="Keep provider choices and local paths explicit and under your control."
          kicker="Application"
          title="Settings"
        />
        <StatePanel
          action={
            onRetry === undefined ? undefined : (
              <button className="button button--secondary" onClick={onRetry} type="button">
                Try again
              </button>
            )
          }
          kind="error"
          message={error ?? "Settings are unavailable."}
          title="Settings are unavailable"
        />
      </div>
    );

  const backendReason = capabilityReason(capabilities, "backend", draft.asrBackend);
  const modelReason = capabilityReason(capabilities, "model");
  const languageReason = capabilityReason(capabilities, "language");
  const glossaryReason = capabilityReason(capabilities, "glossary");

  return (
    <div className="page-content">
      <PageIntro
        description="Keep provider choices, model paths and decision thresholds explicit and under your control."
        kicker="Application"
        title="Settings"
      />
      {message === undefined ? null : (
        <p aria-live="polite" className="muted">
          {message}
        </p>
      )}

      <section aria-label="Local paths" className="settings-card">
        <div className="list-card__header">
          <span>Local paths</span>
          <span className="muted">Changes are applied as they are saved.</span>
        </div>
        {PATH_SETTING_KEYS.map((key) => (
          <PathSetting
            busy={savingKey === key}
            key={key}
            keyName={key}
            onChange={(value) => updateText(key, value)}
            onReveal={() => void reveal(key)}
            onSave={() => void save(key, draft[key] ?? "")}
            value={draft[key] ?? ""}
          />
        ))}
      </section>

      <section aria-label="Language model provider" className="settings-card">
        <div className="list-card__header">
          <span>Provider</span>
          <span className="muted">No API keys are stored here.</span>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>Default provider</strong>
            <p>Choose the runner used by adjudication and prose features.</p>
          </div>
          <select
            aria-label="Default provider"
            disabled={savingKey === "provider"}
            onChange={(event) => void save("provider", event.currentTarget.value)}
            value={draft.provider ?? "none"}
          >
            {PROVIDERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>Model for the selected provider</strong>
            <p>The model name is passed to the selected provider; it is not a credential.</p>
          </div>
          <input
            aria-label="Provider model"
            disabled={savingKey === "providerModel"}
            onBlur={() => void save("providerModel", draft.providerModel ?? "")}
            onChange={(event) => updateText("providerModel", event.currentTarget.value)}
            placeholder="e.g. claude-sonnet"
            value={draft.providerModel ?? ""}
          />
        </div>
        <div className="settings-card__row">
          <div>
            <strong>CLI permission mode</strong>
            <p>Controls what a CLI provider may do while running in the repository.</p>
          </div>
          <select
            aria-label="Provider permission mode"
            disabled={savingKey === "providerPermissionMode"}
            onChange={(event) => void save("providerPermissionMode", event.currentTarget.value)}
            value={draft.providerPermissionMode ?? "default"}
          >
            {PERMISSION_MODES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>OpenAI-compatible base URL</strong>
            <p>Use a local or LAN endpoint. Credentials belong in the environment or keychain.</p>
          </div>
          <input
            aria-label="OpenAI-compatible base URL"
            disabled={savingKey === "localEndpoint"}
            onBlur={() => void save("localEndpoint", draft.localEndpoint ?? "")}
            onChange={(event) => updateText("localEndpoint", event.currentTarget.value)}
            placeholder="http://127.0.0.1:1234/v1"
            type="url"
            value={draft.localEndpoint ?? ""}
          />
          <button
            className="button button--secondary"
            disabled={testingConnection}
            onClick={() => void testConnection()}
            type="button"
          >
            {testingConnection ? "Testing..." : "Test connection"}
          </button>
        </div>
        {connection === undefined ? null : (
          <div aria-live="polite" className="settings-card__row">
            <div>
              <strong>{connection.ok ? "Provider reachable" : "Provider unavailable"}</strong>
              <p>{connection.message}</p>
              {connection.models.length === 0 ? null : (
                <p>Models: {connection.models.join(", ")}</p>
              )}
            </div>
            <span className={connection.ok ? "badge badge--good" : "badge"}>
              {connection.latencyMs === null ? "No response" : `${String(connection.latencyMs)} ms`}
            </span>
          </div>
        )}
      </section>

      <section aria-label="Automatic speech recognition" className="settings-card">
        <div className="list-card__header">
          <span>ASR</span>
          <span className="muted">Options follow the sidecar capability report.</span>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>Backend</strong>
            <p>Select the implementation used for transcription.</p>
            <CapabilityNote message={backendReason} />
          </div>
          <select
            aria-label="ASR backend"
            disabled={backendReason !== undefined}
            onChange={(event) => void save("asrBackend", event.currentTarget.value)}
            value={draft.asrBackend ?? "auto"}
          >
            {ASR_BACKENDS.map(([value, label]) => {
              const reason = capabilityReason(capabilities, "backend", value);
              return (
                <option disabled={reason !== undefined} key={value} value={value}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>Model size</strong>
            <p>Model identifiers are resolved by the configured sidecar.</p>
            <CapabilityNote message={modelReason} />
          </div>
          <select
            aria-label="ASR model"
            disabled={modelReason !== undefined}
            onChange={(event) => void save("asrModel", event.currentTarget.value)}
            value={draft.asrModel ?? "base"}
          >
            {(capabilities?.asrModels ?? []).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>Language</strong>
            <p>Use auto to let the selected ASR backend detect the language.</p>
            <CapabilityNote message={languageReason} />
          </div>
          <select
            aria-label="ASR language"
            disabled={languageReason !== undefined}
            onChange={(event) => void save("asrLanguage", event.currentTarget.value)}
            value={draft.asrLanguage ?? "auto"}
          >
            {(capabilities?.languages ?? []).map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>Glossary biasing</strong>
            <p>Bias transcription toward campaign names without changing the source audio.</p>
            <CapabilityNote message={glossaryReason} />
          </div>
          <input
            aria-label="Enable ASR glossary biasing"
            checked={draft.asrGlossaryEnabled === "true"}
            disabled={glossaryReason !== undefined || savingKey === "asrGlossaryEnabled"}
            onChange={(event) =>
              void save("asrGlossaryEnabled", String(event.currentTarget.checked))
            }
            type="checkbox"
          />
        </div>
      </section>

      <section aria-label="Persona thresholds" className="settings-card">
        <div className="list-card__header">
          <span>Attribution thresholds</span>
          <span className="badge">Re-run required</span>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>Decision bands</strong>
            <p>
              Changes invalidate existing attributions. Re-run the persona stage after saving so old
              decisions are not mistaken for results from the new thresholds.
            </p>
          </div>
          <div>
            <label>
              Out-of-character at or below
              <input
                aria-label="Out-of-character threshold"
                max={1}
                min={0}
                onChange={(event) => saveThreshold("lo", event.currentTarget.value)}
                step={0.01}
                type="number"
                value={thresholds.lo}
              />
            </label>
            <label>
              In-character at or above
              <input
                aria-label="In-character threshold"
                max={1}
                min={0}
                onChange={(event) => saveThreshold("hi", event.currentTarget.value)}
                step={0.01}
                type="number"
                value={thresholds.hi}
              />
            </label>
            <label>
              Minimum character match margin
              <input
                aria-label="Minimum character match margin"
                max={1}
                min={0}
                onChange={(event) => saveThreshold("matchMinMargin", event.currentTarget.value)}
                step={0.01}
                type="number"
                value={thresholds.matchMinMargin}
              />
            </label>
          </div>
        </div>
        <div className="settings-card__row">
          <div>
            <strong>Apply threshold changes</strong>
            <p>The re-run preserves source inputs and refreshes derived attribution artifacts.</p>
          </div>
          <button
            className="button button--secondary"
            disabled={rerunning}
            onClick={() => void rerun()}
            type="button"
          >
            {rerunning ? "Requesting..." : "Re-run attribution"}
          </button>
        </div>
      </section>

      <p className="muted">
        Credentials are never stored in the settings file or database. Configure environment or
        keychain references in the desktop host when a provider needs authentication.
      </p>
    </div>
  );
}
