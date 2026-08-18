/** Structured so callers can act, not just log. */
export type SidecarErrorCode =
  | "env_missing"
  | "start_failed"
  | "unhealthy"
  | "capability_missing"
  | "job_failed"
  | "job_cancelled"
  | "http";

export class SidecarError extends Error {
  constructor(
    readonly code: SidecarErrorCode,
    message: string,
    /** The exact command that fixes this, when there is one. */
    readonly remedy?: string,
  ) {
    super(remedy === undefined ? message : `${message}\n\nTo fix: ${remedy}`);
    this.name = "SidecarError";
  }
}
