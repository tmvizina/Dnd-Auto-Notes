import type { ReactNode } from "react";
import type { Route } from "./router.js";
import type { SidecarStatus } from "./transport.js";

export const ROUTE_LABELS: Readonly<Record<Route, string>> = {
  sessions: "Sessions",
  review: "Review",
  notes: "Notes",
  settings: "Settings",
};

export const ROUTE_ICONS: Readonly<Record<Route, string>> = {
  sessions: "S",
  review: "R",
  notes: "N",
  settings: "G",
};

export interface RailProps {
  readonly route: Route;
  readonly onNavigate: (route: Route) => void;
}

export function Rail({ route, onNavigate }: RailProps): ReactNode {
  return (
    <aside className="rail">
      <div className="rail__brand" aria-label="D&D Auto Notes">
        <span aria-hidden="true" className="rail__mark">
          +
        </span>
        <span className="rail__brand-name">Auto Notes</span>
      </div>
      <nav aria-label="Primary navigation" className="rail__nav">
        {(Object.keys(ROUTE_LABELS) as Route[]).map((item) => {
          const selected = item === route;
          return (
            <button
              aria-current={selected ? "page" : undefined}
              className={selected ? "rail__link rail__link--active" : "rail__link"}
              key={item}
              onClick={() => onNavigate(item)}
              type="button"
            >
              <span aria-hidden="true" className="rail__icon">
                {ROUTE_ICONS[item]}
              </span>
              <span>{ROUTE_LABELS[item]}</span>
            </button>
          );
        })}
      </nav>
      <div className="rail__footer">
        <span className="rail__local-dot" aria-hidden="true" />
        <span>Local workspace</span>
      </div>
    </aside>
  );
}

export interface AppHeaderProps {
  readonly route: Route;
  readonly sessionTitle: string;
  readonly sessionDate?: string;
}

export function AppHeader({ route, sessionTitle, sessionDate }: AppHeaderProps): ReactNode {
  return (
    <header className="app-header">
      <div>
        <p className="eyebrow">{ROUTE_LABELS[route]}</p>
        <h1>{sessionTitle}</h1>
      </div>
      <div className="app-header__session" aria-label="Current session">
        <span className="session-chip">Current session</span>
        {sessionDate === undefined ? null : <span>{sessionDate}</span>}
      </div>
    </header>
  );
}

export type ProviderStatus = "available" | "unavailable" | "not-configured";

export interface StatusStripProps {
  readonly sidecar:
    | SidecarStatus
    | { readonly status: "unknown"; readonly reason?: string; readonly setupCommand?: string };
  readonly activeRunCount: number;
  readonly provider: ProviderStatus;
}

function sidecarLabel(status: StatusStripProps["sidecar"]): string {
  if (status.status === "unknown") return "Unavailable in browser";
  switch (status.status) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "unhealthy":
      return "Needs attention";
    case "unavailable":
      return "Unavailable";
    case "stopped":
      return "Stopped";
  }
}

function statusTone(status: StatusStripProps["sidecar"]): string {
  if (status.status === "ready") return "status-strip__item--good";
  if (status.status === "starting") return "status-strip__item--pending";
  return "status-strip__item--muted";
}

function providerLabel(provider: ProviderStatus): string {
  if (provider === "available") return "Configured";
  if (provider === "not-configured") return "Not configured";
  return "Unavailable";
}

export function StatusStrip({ sidecar, activeRunCount, provider }: StatusStripProps): ReactNode {
  const setupCommand = sidecar.setupCommand;
  return (
    <section aria-label="System status" className="status-strip">
      <div className={`status-strip__item ${statusTone(sidecar)}`}>
        <span aria-hidden="true" className="status-strip__dot" />
        <span className="status-strip__label">Sidecar</span>
        <strong>{sidecarLabel(sidecar)}</strong>
        {sidecar.reason === undefined ? null : (
          <span className="status-strip__detail" title={sidecar.reason}>
            {sidecar.reason}
          </span>
        )}
        {setupCommand === undefined ? null : (
          <button
            className="status-strip__copy"
            onClick={() => {
              void navigator.clipboard?.writeText(setupCommand);
            }}
            title="Copy the sidecar setup command"
            type="button"
          >
            Copy setup command
          </button>
        )}
      </div>
      <div className="status-strip__item status-strip__item--muted">
        <span className="status-strip__label">Active runs</span>
        <strong>{activeRunCount}</strong>
      </div>
      <div className="status-strip__item status-strip__item--muted">
        <span className="status-strip__label">Provider</span>
        <strong>{providerLabel(provider)}</strong>
      </div>
    </section>
  );
}

export interface StatePanelProps {
  readonly kind: "loading" | "empty" | "error";
  readonly title: string;
  readonly message: string;
  readonly action?: ReactNode;
}

export function StatePanel({ kind, title, message, action }: StatePanelProps): ReactNode {
  return (
    <section
      aria-live={kind === "loading" ? "polite" : "assertive"}
      className={`state-panel state-panel--${kind}`}
    >
      <div aria-hidden="true" className="state-panel__icon">
        {kind === "loading" ? "..." : kind === "empty" ? "-" : "!"}
      </div>
      <div>
        <h2>{title}</h2>
        <p>{message}</p>
        {action === undefined ? null : <div className="state-panel__action">{action}</div>}
      </div>
    </section>
  );
}

export function PageIntro({
  kicker,
  title,
  description,
  action,
}: {
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <div className="page-intro">
      <div>
        <p className="eyebrow">{kicker}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action === undefined ? null : <div className="page-intro__action">{action}</div>}
    </div>
  );
}
