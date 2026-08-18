export const SIDECAR_STATUSES = [
  "stopped",
  "starting",
  "ready",
  "unhealthy",
  "unavailable",
] as const;

export type SidecarStatus = (typeof SIDECAR_STATUSES)[number];

/**
 * State pushed to the renderer-facing main-process handlers.  `setupCommand`
 * is deliberately separate from `reason` so the UI can offer a copy button
 * without having to parse prose.
 */
export interface SidecarState {
  readonly status: SidecarStatus;
  readonly reason?: string;
  readonly setupCommand?: string;
  readonly port?: number;
  readonly version?: string;
  readonly ownedByUs?: boolean;
  readonly restartAttempt: number;
}

export type SidecarStateListener = (state: SidecarState) => void;

export interface SidecarStateDetails {
  readonly reason?: string;
  readonly setupCommand?: string;
  readonly port?: number;
  readonly version?: string;
  readonly ownedByUs?: boolean;
}

export function isSidecarStatus(value: string): value is SidecarStatus {
  return (SIDECAR_STATUSES as readonly string[]).includes(value);
}
