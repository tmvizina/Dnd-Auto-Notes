/** Errors raised by the desktop lifecycle wrapper are safe to show in the UI. */
export type DesktopSidecarErrorCode = "unavailable" | "unhealthy" | "stopped" | "cancelled";

export class DesktopSidecarError extends Error {
  constructor(
    readonly code: DesktopSidecarErrorCode,
    message: string,
    /** A setup command is data for the onboarding UI; it is never executed here. */
    readonly setupCommand?: string,
  ) {
    super(message);
    this.name = "DesktopSidecarError";
  }
}
