import { describe, expect, it } from "vitest";
import {
  createUiUrl,
  isAllowedUiUrl,
  requestRelativePath,
  UI_HOST,
  UI_SCHEME,
} from "./uiSecurity.js";

describe("renderer URL security", () => {
  it("uses one privileged packaged origin", () => {
    expect(createUiUrl()).toBe(`${UI_SCHEME}://${UI_HOST}/index.html`);
    expect(createUiUrl("/assets/app.js")).toBe(`${UI_SCHEME}://${UI_HOST}/assets/app.js`);
    expect(isAllowedUiUrl(`${UI_SCHEME}://${UI_HOST}/index.html`)).toBe(true);
    expect(isAllowedUiUrl("https://example.com/escape")).toBe(false);
  });

  it("allows only the exact validated development origin", () => {
    expect(isAllowedUiUrl("http://localhost:5173/", "http://localhost:5173")).toBe(true);
    expect(isAllowedUiUrl("http://localhost:5174/", "http://localhost:5173")).toBe(false);
    expect(isAllowedUiUrl("https://localhost:5173/", "http://localhost:5173")).toBe(false);
  });

  it("normalizes only same-origin protocol paths", () => {
    expect(requestRelativePath(`${UI_SCHEME}://${UI_HOST}/`)).toBe("index.html");
    expect(requestRelativePath(`${UI_SCHEME}://${UI_HOST}/assets/app.js?cache=1`)).toBe(
      "assets/app.js",
    );
    expect(requestRelativePath("https://example.com/index.html")).toBeNull();
    expect(requestRelativePath(`${UI_SCHEME}://evil/index.html`)).toBeNull();
    expect(requestRelativePath(`${UI_SCHEME}://${UI_HOST}/%ZZ`)).toBeNull();
  });
});
