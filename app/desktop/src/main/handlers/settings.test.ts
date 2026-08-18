import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asIpcSettingsHandlers,
  createSettingsHandlers,
  testOpenAiCompatibleConnection,
  type FetchLike,
  type LookupLike,
  type PinnedTransport,
} from "./settings.js";
import { ContractValidationError } from "../../shared/contracts.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".p4-11-settings-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("settings handlers", () => {
  it("persists allow-listed values atomically without accepting credentials", async () => {
    const root = await tempRoot();
    const settings = createSettingsHandlers({ settingsPath: join(root, "data", "settings.json") });

    await expect(settings.settingsSet({ key: "provider", value: "http-local" })).resolves.toEqual({
      key: "provider",
      value: "http-local",
    });
    await expect(
      settings.settingsSet({ key: "localEndpoint", value: "http://127.0.0.1:1234/v1" }),
    ).resolves.toEqual({ key: "localEndpoint", value: "http://127.0.0.1:1234/v1" });
    await expect(
      settings.settingsSet({ key: "credentials.apiKey", value: "synthetic-secret" }),
    ).rejects.toMatchObject({ code: "invalid_setting_value" });
    await expect(
      settings.settingsSet({ key: "localEndpoint", value: "http://user:pass@127.0.0.1:1234/v1" }),
    ).rejects.toMatchObject({ code: "credential_not_allowed" });

    const written = await readFile(join(root, "data", "settings.json"), "utf8");
    expect(written).toContain("http-local");
    expect(written).not.toContain("synthetic-secret");
    expect(written).not.toContain("apiKey");
    await expect(settings.settingsGet()).resolves.toEqual({
      settings: {
        localEndpoint: "http://127.0.0.1:1234/v1",
        provider: "http-local",
      },
    });
  });

  it("reveals a configured path and composes only contract settings handlers", async () => {
    const root = await tempRoot();
    const reveal = vi.fn(async () => true);
    const settings = createSettingsHandlers({
      settingsPath: join(root, "settings.json"),
      revealPath: reveal,
    });
    await settings.settingsSet({ key: "sessionsRoot", value: join(root, "sessions") });

    await expect(settings.reveal("sessionsRoot")).resolves.toBe(true);
    expect(reveal).toHaveBeenCalledWith(join(root, "sessions"));
    expect(Object.keys(asIpcSettingsHandlers(settings)).sort()).toEqual([
      "settingsGet",
      "settingsReveal",
      "settingsSet",
      "settingsTestConnection",
    ]);
    await expect(
      asIpcSettingsHandlers(settings).settingsSet?.(
        { key: "localEndpoint", value: "http://user:pass@localhost/v1" },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ContractValidationError);
  });

  it("reports latency and sorted models for an OpenAI-compatible server", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "zeta" }, { id: "alpha" }] }),
      };
    };
    const result = await testOpenAiCompatibleConnection(
      { baseUrl: "http://127.0.0.1:1234/v1", model: "alpha" },
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: true, models: ["alpha", "zeta"] });
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(calls).toEqual(["GET http://127.0.0.1:1234/v1/models"]);
  });

  it("fails informatively when the provider cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;
    await expect(
      testOpenAiCompatibleConnection({ baseUrl: "http://127.0.0.1:1234/v1" }, fetchImpl),
    ).resolves.toMatchObject({ ok: false, latencyMs: null, models: [] });
    const result = await testOpenAiCompatibleConnection(
      { baseUrl: "http://127.0.0.1:1234/v1" },
      fetchImpl,
    );
    expect(result.message).toContain("Could not reach");
  });

  it("allows LAN endpoints but rejects public, metadata and DNS-rebinding answers", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    })) as unknown as FetchLike;
    const lanLookup: LookupLike = async () => [{ address: "192.168.1.42", family: 4 }];
    await expect(
      testOpenAiCompatibleConnection(
        { baseUrl: "http://macbook.local:1234/v1" },
        fetchImpl,
        lanLookup,
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      testOpenAiCompatibleConnection({ baseUrl: "http://169.254.169.254/latest" }, fetchImpl),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining("not loopback") });
    await expect(
      testOpenAiCompatibleConnection({ baseUrl: "http://93.184.216.34/v1" }, fetchImpl),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining("not loopback") });

    const rebindingLookup: LookupLike = async () => [
      { address: "192.168.1.42", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ];
    await expect(
      testOpenAiCompatibleConnection(
        { baseUrl: "http://macbook.local:1234/v1" },
        fetchImpl,
        rebindingLookup,
      ),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining("not loopback") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pins the resolved address and never connects to a rejected public address", async () => {
    let lookups = 0;
    const lookup: LookupLike = async () => {
      lookups += 1;
      return [{ address: "192.168.1.42", family: 4 }];
    };
    const requests: string[] = [];
    const transport: PinnedTransport = async (request) => {
      requests.push(`${request.address} Host=${request.headers["Host"] ?? ""}`);
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    await expect(
      testOpenAiCompatibleConnection(
        { baseUrl: "http://macbook.local:1234/v1" },
        undefined,
        lookup,
        transport,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(lookups).toBe(1);
    expect(requests).toEqual(["192.168.1.42 Host=macbook.local:1234"]);

    const rejectedTransport = vi.fn() as unknown as PinnedTransport;
    await expect(
      testOpenAiCompatibleConnection(
        { baseUrl: "http://93.184.216.34/v1" },
        undefined,
        undefined,
        rejectedTransport,
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(rejectedTransport).not.toHaveBeenCalled();
  });

  it("accepts only an existing sidecar directory or repository shape", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "repo", "sidecar"), { recursive: true });
    await mkdir(join(root, "standalone-sidecar"), { recursive: true });
    await writeFile(join(root, "python.exe"), "synthetic");
    const settings = createSettingsHandlers({ settingsPath: join(root, "settings.json") });

    await expect(
      settings.settingsSet({ key: "sidecarPath", value: join(root, "repo") }),
    ).resolves.toEqual({ key: "sidecarPath", value: join(root, "repo") });
    await expect(
      settings.settingsSet({ key: "sidecarPath", value: join(root, "standalone-sidecar") }),
    ).rejects.toMatchObject({ code: "invalid_setting_value" });
    await expect(
      settings.settingsSet({ key: "sidecarPath", value: join(root, "python.exe") }),
    ).rejects.toMatchObject({ code: "invalid_setting_value" });
  });

  it("fails closed when a configured hostname cannot be resolved", async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    const lookup: LookupLike = vi.fn(async () => {
      throw new Error("NXDOMAIN");
    });
    await expect(
      testOpenAiCompatibleConnection(
        { baseUrl: "http://macbook.local:1234/v1" },
        fetchImpl,
        lookup,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("could not be resolved"),
    });
  });
});
