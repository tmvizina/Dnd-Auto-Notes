import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { getPackagedResourcePath } from "./paths.js";
import { requestRelativePath, UI_SCHEME } from "./uiSecurity.js";

export { createUiUrl, isAllowedUiUrl } from "./uiSecurity.js";
export { UI_HOST, UI_SCHEME } from "./uiSecurity.js";

export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

let schemeRegistered = false;
let handlerRegistered = false;

/** Must run before app.ready. */
export function registerUiScheme(): void {
  if (schemeRegistered) return;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: UI_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
  schemeRegistered = true;
}

/** Serve packaged renderer output under a secure, standard local origin. */
export function registerUiProtocol(uiRoot: string): void {
  if (handlerRegistered) return;
  handlerRegistered = true;
  protocol.handle(UI_SCHEME, async (request) => {
    const relativePath = requestRelativePath(request.url);
    const filePath = relativePath ? getPackagedResourcePath(uiRoot, relativePath) : null;

    let validFile = false;
    if (filePath && existsSync(filePath)) {
      try {
        validFile = statSync(filePath).isFile();
      } catch {
        validFile = false;
      }
    }
    if (!validFile || !filePath) {
      return new Response("Not found", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }

    try {
      const upstream = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(upstream.headers);
      headers.set("x-content-type-options", "nosniff");
      if (filePath.toLowerCase().endsWith(".html")) headers.set("content-security-policy", UI_CSP);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      console.error("[desktop] failed to serve UI resource", filePath, error);
      return new Response("Unable to load UI resource", {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
  });
}
