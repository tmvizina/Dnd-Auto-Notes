import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage, capabilityReason, parseThresholds } from "./Settings.js";

describe("settings page model", () => {
  it("explains missing and unavailable sidecar capabilities", () => {
    expect(capabilityReason(undefined, "backend", "faster-whisper")).toContain("capability report");
    expect(
      capabilityReason(
        { available: false, reason: "sidecar is stopped" },
        "backend",
        "faster-whisper",
      ),
    ).toBe("sidecar is stopped");
  });

  it("gates individual backends against the reported capability map", () => {
    const capabilities = {
      available: true,
      asrBackends: { auto: true, "faster-whisper": true, "mlx-whisper": false },
    } as const;
    expect(capabilityReason(capabilities, "backend", "faster-whisper")).toBeUndefined();
    expect(capabilityReason(capabilities, "backend", "mlx-whisper")).toContain("not reported");
  });

  it("keeps threshold parsing compatible with the persisted snake-case field", () => {
    expect(parseThresholds('{"lo":0.2,"hi":0.8,"match_min_margin":0.15}')).toEqual({
      lo: 0.2,
      hi: 0.8,
      matchMinMargin: 0.15,
    });
    expect(parseThresholds("not-json")).toEqual({ lo: 0.35, hi: 0.65, matchMinMargin: 0.1 });
  });

  it("renders the credential notice, connection action and capability explanation", () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        capabilities={{ available: false, reason: "sidecar is stopped" }}
        settings={{ provider: "http-local", localEndpoint: "http://127.0.0.1:1234/v1" }}
      />,
    );
    expect(markup).toContain("Test connection");
    expect(markup).toContain("Credentials are never stored");
    expect(markup).toContain("sidecar is stopped");
    expect(markup).toContain("Changes invalidate existing attributions");
  });
});
