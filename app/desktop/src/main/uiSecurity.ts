export const UI_SCHEME = "dnd-auto-notes";
export const UI_HOST = "app";

/** Build the only origin used by packaged renderer navigation. */
export function createUiUrl(path = "index.html"): string {
  const normalized = path.replace(/^\/+/, "");
  return `${UI_SCHEME}://${UI_HOST}/${normalized}`;
}

/** Navigation is allowed only within the current renderer origin. */
export function isAllowedUiUrl(url: string, devOrigin?: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${UI_SCHEME}:`) return parsed.hostname === UI_HOST;
    return Boolean(devOrigin && parsed.origin === devOrigin);
  } catch {
    return false;
  }
}

export function requestRelativePath(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== `${UI_SCHEME}:` || url.hostname !== UI_HOST) return null;
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    return pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  } catch {
    return null;
  }
}
