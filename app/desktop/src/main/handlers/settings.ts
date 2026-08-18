import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import {
  ContractValidationError,
  ERROR_CODES,
  SETTING_KEYS,
  type SettingKey,
  type SettingsGetResponse,
  type SettingsRevealRequest,
  type SettingsRevealResponse,
  type SettingsSetRequest,
  type SettingsSetResponse,
  type SettingsTestConnectionRequest,
  type SettingsTestConnectionResponse,
} from "../../shared/contracts.js";
import type { IpcHandlerMap } from "../ipc.js";

/** Settings that point at a path and can therefore be revealed in the shell. */
export const PATH_SETTING_KEYS = ["sessionsRoot", "campaignRoot", "sidecarPath"] as const;

export type PathSettingKey = (typeof PATH_SETTING_KEYS)[number];

function isPathSettingKey(value: string): value is PathSettingKey {
  return (PATH_SETTING_KEYS as readonly string[]).includes(value);
}

export type SettingsMap = Partial<Record<SettingKey, string>>;

export type LlmProvider = "cli-claude" | "cli-codex" | "http-local" | "none";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface PersonaThresholds {
  readonly lo: number;
  readonly hi: number;
  readonly matchMinMargin: number;
}

export interface SettingsValidationFailure {
  readonly code: "invalid_setting_value" | "credential_not_allowed";
  readonly key: string;
  readonly message: string;
}

/** A typed validation error is safe to turn into an IPC structured error. */
export class SettingsValidationError extends Error {
  readonly code: SettingsValidationFailure["code"];
  readonly key: string;

  constructor(failure: SettingsValidationFailure) {
    super(failure.message);
    this.name = "SettingsValidationError";
    this.code = failure.code;
    this.key = failure.key;
  }
}

export interface ConnectionTestRequest {
  readonly baseUrl: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly models: readonly string[];
  readonly message: string;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init: Readonly<{
    readonly method: "GET";
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly redirect?: "error";
  }>,
) => Promise<FetchResponseLike>;

export type LookupLike = (
  hostname: string,
  options: Readonly<{ readonly all: true }>,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

export interface PinnedRequest {
  readonly protocol: "http:" | "https:";
  readonly address: string;
  readonly family: number;
  readonly port: number;
  readonly path: string;
  readonly hostname: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type PinnedTransport = (request: PinnedRequest) => Promise<FetchResponseLike>;

export interface SettingsHandlersOptions {
  readonly settingsPath: string;
  readonly revealPath?: (path: string) => Promise<boolean>;
  readonly onChange?: (change: {
    readonly key: SettingKey;
    readonly value: string;
    readonly settings: SettingsMap;
  }) => void | Promise<void>;
  readonly fetch?: FetchLike;
  readonly lookup?: LookupLike;
  readonly transport?: PinnedTransport;
}

export interface SettingsHandlers {
  readonly settingsGet: () => Promise<SettingsGetResponse>;
  readonly settingsSet: (request: SettingsSetRequest) => Promise<SettingsSetResponse>;
  readonly reveal: (key: PathSettingKey) => Promise<boolean>;
  readonly testConnection: (request: ConnectionTestRequest) => Promise<ConnectionTestResult>;
}

const PROVIDERS: ReadonlySet<string> = new Set<LlmProvider>([
  "cli-claude",
  "cli-codex",
  "http-local",
  "none",
]);

const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

const ASR_BACKENDS: ReadonlySet<string> = new Set([
  "auto",
  "mlx-whisper",
  "faster-whisper",
  "whisper.cpp",
  "fake",
]);

const MAX_SETTING_LENGTH = 16_384;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

function failure(
  code: SettingsValidationFailure["code"],
  key: string,
  message: string,
): SettingsValidationError {
  return new SettingsValidationError({ code, key, message });
}

function requiredText(key: string, raw: string, max = MAX_SETTING_LENGTH): string {
  const value = raw.trim();
  if (value === "") throw failure("invalid_setting_value", key, `${key} must not be empty`);
  if (value.length > max)
    throw failure("invalid_setting_value", key, `${key} is longer than ${String(max)} characters`);
  if (value.includes("\0"))
    throw failure("invalid_setting_value", key, `${key} contains an invalid NUL character`);
  return value;
}

function rejectCredentialLiteral(key: string, value: string): void {
  if (
    /^(?:sk|rk)-[A-Za-z0-9_-]{12,}$/u.test(value) ||
    /(?:api[_-]?key|token|secret|password|bearer)\s*[:=]/iu.test(value)
  )
    throw failure(
      "credential_not_allowed",
      key,
      `${key} must contain a model or path, not a credential; use an environment or keychain reference`,
    );
}

function validatePath(key: string, raw: string): string {
  const value = requiredText(key, raw, 4_096);
  // A relative path is allowed for portability, but the value is checked for
  // NULs and bounded here before the composition root ever uses it.
  return value;
}

async function validateSidecarDirectory(raw: string): Promise<string> {
  const value = validatePath("sidecarPath", raw);
  const candidate = resolve(value);
  let candidateStat;
  try {
    candidateStat = await stat(candidate);
  } catch {
    throw failure(
      "invalid_setting_value",
      "sidecarPath",
      "sidecarPath must name an existing directory",
    );
  }
  if (!candidateStat.isDirectory())
    throw failure(
      "invalid_setting_value",
      "sidecarPath",
      "sidecarPath must name a directory, not an executable or file",
    );
  if (basename(candidate).toLowerCase() === "sidecar") return candidate;
  try {
    const nestedStat = await stat(join(candidate, "sidecar"));
    if (nestedStat.isDirectory()) return candidate;
  } catch {
    // The shape check below produces the stable validation error.
  }
  throw failure(
    "invalid_setting_value",
    "sidecarPath",
    "sidecarPath must be the sidecar directory or a repository containing sidecar",
  );
}

function parseEndpoint(key: string, raw: string): URL {
  const value = requiredText(key, raw, 2_048);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw failure("invalid_setting_value", key, `${key} must be an http(s) URL`);
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    throw failure("invalid_setting_value", key, `${key} must use http:// or https://`);
  if (endpoint.username !== "" || endpoint.password !== "")
    throw failure(
      "credential_not_allowed",
      key,
      `${key} must not contain a username or password; use an environment or keychain reference`,
    );
  if (endpoint.search !== "" || endpoint.hash !== "")
    throw failure(
      "credential_not_allowed",
      key,
      `${key} must not contain query or fragment credentials; use an environment or keychain reference`,
    );
  return endpoint;
}

function numberInUnitInterval(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw failure("invalid_setting_value", key, `${key} values must be numbers from 0 to 1`);
  return value;
}

/** Parse the stable JSON representation used for persona decision bands. */
export function parsePersonaThresholds(raw: string): PersonaThresholds {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw failure(
      "invalid_setting_value",
      "personaThresholds",
      "personaThresholds must be JSON with lo, hi and matchMinMargin",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw failure(
      "invalid_setting_value",
      "personaThresholds",
      "personaThresholds must be an object with lo, hi and matchMinMargin",
    );
  const record = value as Record<string, unknown>;
  const lo = numberInUnitInterval(record["lo"], "personaThresholds.lo");
  const hi = numberInUnitInterval(record["hi"], "personaThresholds.hi");
  const marginRaw = record["matchMinMargin"] ?? record["match_min_margin"];
  const matchMinMargin = numberInUnitInterval(marginRaw, "personaThresholds.matchMinMargin");
  if (lo >= hi)
    throw failure(
      "invalid_setting_value",
      "personaThresholds",
      "personaThresholds.lo must be lower than personaThresholds.hi",
    );
  return { lo, hi, matchMinMargin };
}

function canonicalThresholds(raw: string): string {
  return JSON.stringify(parsePersonaThresholds(raw));
}

/** Validate and canonicalize one allow-listed setting before it is persisted. */
export function validateSettingValue(key: string, raw: string): { key: SettingKey; value: string } {
  if (!isSettingKey(key))
    throw failure("invalid_setting_value", key, `setting key "${key}" is not allowed`);
  if (typeof raw !== "string")
    throw failure("invalid_setting_value", key, `${key} must be a string`);

  switch (key) {
    case "sessionsRoot":
    case "campaignRoot":
    case "sidecarPath":
      return { key, value: validatePath(key, raw) };
    case "provider": {
      const value = requiredText(key, raw, 64);
      if (!PROVIDERS.has(value))
        throw failure(
          "invalid_setting_value",
          key,
          `${key} must be one of cli-claude, cli-codex, http-local or none`,
        );
      return { key, value };
    }
    case "providerModel": {
      const value = raw.trim();
      if (value.length > 512)
        throw failure("invalid_setting_value", key, `${key} is longer than 512 characters`);
      if (value.includes("\0"))
        throw failure("invalid_setting_value", key, `${key} contains an invalid NUL character`);
      if (value === "") return { key, value };
      rejectCredentialLiteral(key, value);
      return { key, value };
    }
    case "providerPermissionMode": {
      const value = requiredText(key, raw, 64);
      if (!PERMISSION_MODES.has(value))
        throw failure(
          "invalid_setting_value",
          key,
          `${key} is not a supported CLI permission mode`,
        );
      return { key, value };
    }
    case "localEndpoint": {
      const endpoint = parseEndpoint(key, raw);
      return { key, value: endpoint.toString().replace(/\/$/u, "") };
    }
    case "asrBackend": {
      const value = requiredText(key, raw, 64);
      if (!ASR_BACKENDS.has(value))
        throw failure("invalid_setting_value", key, `${key} is not a supported ASR backend`);
      return { key, value };
    }
    case "asrModel":
      return { key, value: requiredText(key, raw, 512) };
    case "asrLanguage": {
      const value = requiredText(key, raw, 32);
      if (value !== "auto" && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value))
        throw failure("invalid_setting_value", key, `${key} must be auto or a BCP-47 language tag`);
      return { key, value };
    }
    case "asrGlossaryEnabled": {
      const value = requiredText(key, raw, 5).toLowerCase();
      if (value !== "true" && value !== "false")
        throw failure("invalid_setting_value", key, `${key} must be true or false`);
      return { key, value };
    }
    case "personaThresholds":
      return { key, value: canonicalThresholds(raw) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSettings(settings: SettingsMap): SettingsMap {
  return Object.fromEntries(
    Object.entries(settings).sort(([left], [right]) => left.localeCompare(right)),
  ) as SettingsMap;
}

async function readSettings(settingsPath: string): Promise<SettingsMap> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("settings file is not valid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("settings file must contain an object");

  // Accept the wrapper used by early development builds, but always emit the
  // flat form below. Neither form may contain an unknown or secret key.
  const wrapped = isRecord(parsed["settings"]);
  if (wrapped) {
    for (const key of Object.keys(parsed)) {
      if (key !== "settings" && key !== "version")
        throw failure(
          "credential_not_allowed",
          key,
          `settings file contains an unknown key "${key}"`,
        );
    }
  }
  const candidate = wrapped ? parsed["settings"] : parsed;
  if (!isRecord(candidate)) throw new Error("settings file must contain an object");
  const values: SettingsMap = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!isSettingKey(key))
      throw failure(
        "credential_not_allowed",
        key,
        `settings file contains an unknown key "${key}"`,
      );
    if (typeof value !== "string")
      throw failure("invalid_setting_value", key, `${key} in settings file must be a string`);
    const valid =
      key === "sidecarPath"
        ? { key: "sidecarPath" as const, value: await validateSidecarDirectory(value) }
        : validateSettingValue(key, value);
    values[valid.key] = valid.value;
  }
  return cloneSettings(values);
}

async function writeSettings(settingsPath: string, settings: SettingsMap): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.${randomUUID()}.partial`;
  const content = `${JSON.stringify(cloneSettings(settings), null, 2)}\n`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // chmod is best effort on Windows, while ensuring a restrictive mode on
    // Unix when the user has a permissive umask.
    try {
      await chmod(temporaryPath, 0o600);
    } catch {
      // The atomic replacement below is still safe when chmod is unavailable.
    }
    await rename(temporaryPath, settingsPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function modelsEndpoint(baseUrl: string): string {
  const endpoint = parseEndpoint("baseUrl", baseUrl);
  const path = endpoint.pathname.replace(/\/+$/u, "");
  endpoint.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
  return endpoint.toString();
}

function ipv4Allowed(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return false;
  if (first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31)) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

function endpointAddressAllowed(address: string): boolean {
  const normalized = address.split("%", 1)[0]?.toLowerCase();
  if (normalized === undefined) return false;
  const family = isIP(normalized);
  if (family === 4) return ipv4Allowed(normalized);
  if (family !== 6) return false;
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return ipv4Allowed(normalized.slice("::ffff:".length));
  return normalized.startsWith("fc") || normalized.startsWith("fd");
}

async function validateConnectionEndpoint(
  endpoint: URL,
  lookupImpl: LookupLike,
): Promise<{ readonly address: string; readonly family: number } | { readonly error: string }> {
  const hostname = endpoint.hostname.replace(/^\[|\]$/gu, "");
  const literalHost = hostname.split("%", 1)[0] ?? hostname;
  const literalFamily = isIP(literalHost);
  let addresses: readonly { readonly address: string; readonly family: number }[];
  try {
    addresses =
      literalFamily !== 0
        ? [{ address: literalHost, family: literalFamily }]
        : await lookupImpl(hostname, { all: true });
  } catch {
    return { error: `Refusing provider endpoint: hostname "${hostname}" could not be resolved.` };
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !endpointAddressAllowed(address)))
    return {
      error: `Refusing provider endpoint: "${hostname}" is not loopback, private, or LAN-reachable.`,
    };
  const selected = addresses[0];
  return selected === undefined
    ? { error: `Refusing provider endpoint: hostname "${hostname}" could not be resolved.` }
    : selected;
}

const MAX_CONNECTION_RESPONSE_BYTES = 1_048_576;

/** Make the request to the already-validated address; the hostname is never resolved again. */
export const pinnedHttpTransport: PinnedTransport = (request) =>
  new Promise<FetchResponseLike>((resolveResponse, reject) => {
    const requestFn = request.protocol === "https:" ? httpsRequest : httpRequest;
    const clientRequest = requestFn(
      {
        protocol: request.protocol,
        hostname: request.address,
        port: request.port,
        path: request.path,
        method: "GET",
        headers: request.headers,
        servername: request.protocol === "https:" ? request.hostname : undefined,
        lookup: (_hostname, _options, callback) => callback(null, request.address, request.family),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size <= MAX_CONNECTION_RESPONSE_BYTES) chunks.push(bytes);
          else clientRequest.destroy(new Error("provider response exceeded 1 MiB"));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolveResponse({
            ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 500,
            json: async () => JSON.parse(body) as unknown,
          });
        });
        response.on("error", reject);
      },
    );
    request.signal.addEventListener("abort", () => clientRequest.destroy(new Error("aborted")), {
      once: true,
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });

function modelIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["data"])) return [];
  return value["data"]
    .filter(isRecord)
    .map((item) => item["id"])
    .filter((id): id is string => typeof id === "string" && id.trim() !== "")
    .map((id) => id.trim())
    .sort((left, right) => left.localeCompare(right));
}

/** Probe an OpenAI-compatible `/v1/models` endpoint without sending secrets. */
export async function testOpenAiCompatibleConnection(
  request: ConnectionTestRequest,
  fetchImpl: FetchLike | undefined = undefined,
  lookupImpl: LookupLike = (hostname, options) => dnsLookup(hostname, options),
  transport: PinnedTransport = pinnedHttpTransport,
): Promise<ConnectionTestResult> {
  let url: string;
  let endpoint: URL;
  let resolution: { readonly address: string; readonly family: number };
  try {
    endpoint = parseEndpoint("baseUrl", request.baseUrl);
    const checked = await validateConnectionEndpoint(endpoint, lookupImpl);
    if ("error" in checked)
      return { ok: false, latencyMs: null, models: [], message: checked.error };
    resolution = checked;
    url = modelsEndpoint(endpoint.toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : "the endpoint is invalid";
    return { ok: false, latencyMs: null, models: [], message };
  }
  const timeoutMs =
    request.timeoutMs === undefined
      ? DEFAULT_CONNECTION_TIMEOUT_MS
      : Math.max(250, Math.min(30_000, Math.floor(request.timeoutMs)));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response =
      fetchImpl === undefined
        ? await transport({
            protocol: endpoint.protocol as "http:" | "https:",
            address: resolution.address,
            family: resolution.family,
            port: Number(endpoint.port) || (endpoint.protocol === "https:" ? 443 : 80),
            path: `${endpoint.pathname}${endpoint.search}`.replace(/\/$/u, "/models"),
            hostname: endpoint.hostname,
            headers: { Accept: "application/json", Host: endpoint.host },
            signal: controller.signal,
          })
        : await fetchImpl(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
            redirect: "error",
          });
    const latencyMs = Math.max(0, Date.now() - started);
    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        models: [],
        message: `Server responded with HTTP ${String(response.status)} while listing models.`,
      };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, latencyMs, models: [], message: "Server returned invalid JSON." };
    }
    const models = modelIds(payload);
    const selected = request.model?.trim();
    return {
      ok: true,
      latencyMs,
      models,
      message:
        models.length === 0
          ? `Connected in ${String(latencyMs)} ms; the server returned no models.`
          : selected !== undefined && selected !== "" && !models.includes(selected)
            ? `Connected in ${String(latencyMs)} ms; the configured model was not in the model list.`
            : `Connected in ${String(latencyMs)} ms; ${String(models.length)} model${models.length === 1 ? "" : "s"} available.`,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `The connection timed out after ${String(timeoutMs)} ms.`
        : `Could not reach the local provider: ${error instanceof Error ? error.message : "unknown network error"}`;
    return { ok: false, latencyMs: null, models: [], message };
  } finally {
    clearTimeout(timeout);
  }
}

export async function revealConfiguredPath(
  settings: SettingsMap,
  key: PathSettingKey,
  revealPath: ((path: string) => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (revealPath === undefined) return false;
  const raw = settings[key];
  if (raw === undefined || raw.trim() === "") return false;
  return revealPath(resolve(raw));
}

/** Create the settings persistence and local-provider operations. */
export function createSettingsHandlers(options: SettingsHandlersOptions): SettingsHandlers {
  const settingsPath = resolve(options.settingsPath);
  let loaded: SettingsMap | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  const load = async (): Promise<SettingsMap> => {
    if (loaded === null) loaded = await readSettings(settingsPath);
    return loaded;
  };

  const settingsGet = async (): Promise<SettingsGetResponse> => ({
    settings: cloneSettings(await load()),
  });

  const settingsSet = async (request: SettingsSetRequest): Promise<SettingsSetResponse> => {
    const valid =
      request.key === "sidecarPath"
        ? { key: "sidecarPath" as const, value: await validateSidecarDirectory(request.value) }
        : validateSettingValue(request.key, request.value);
    const operation = writeChain.then(async () => {
      const current = await load();
      const next: SettingsMap = { ...current, [valid.key]: valid.value };
      await writeSettings(settingsPath, next);
      loaded = cloneSettings(next);
      await options.onChange?.({
        key: valid.key,
        value: valid.value,
        settings: cloneSettings(next),
      });
      return { key: valid.key, value: valid.value };
    });
    writeChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const reveal = async (key: PathSettingKey): Promise<boolean> =>
    revealConfiguredPath(await load(), key, options.revealPath);

  const testConnection = (request: ConnectionTestRequest): Promise<ConnectionTestResult> =>
    testOpenAiCompatibleConnection(request, options.fetch, options.lookup, options.transport);

  return { settingsGet, settingsSet, reveal, testConnection };
}

/** Compose only the two contract handlers; reveal and test stay explicit APIs. */
export function asIpcSettingsHandlers(
  handlers: Pick<SettingsHandlers, "settingsGet" | "settingsSet" | "reveal" | "testConnection">,
): Pick<
  IpcHandlerMap,
  "settingsGet" | "settingsSet" | "settingsReveal" | "settingsTestConnection"
> {
  const mapValidationError = (error: unknown): never => {
    if (error instanceof SettingsValidationError)
      throw new ContractValidationError(ERROR_CODES.invalidValue, error.message, {
        field: error.key,
      });
    throw error;
  };
  return {
    settingsGet: async () => {
      try {
        return await handlers.settingsGet();
      } catch (error) {
        return mapValidationError(error);
      }
    },
    settingsSet: async (request: SettingsSetRequest) => {
      try {
        return await handlers.settingsSet(request);
      } catch (error) {
        return mapValidationError(error);
      }
    },
    settingsReveal: async (request: SettingsRevealRequest): Promise<SettingsRevealResponse> => {
      if (!isPathSettingKey(request.key))
        throw new ContractValidationError(
          ERROR_CODES.settingsKeyNotAllowed,
          "setting key cannot be revealed",
          { field: "key" },
        );
      try {
        return { key: request.key, revealed: await handlers.reveal(request.key) };
      } catch (error) {
        return mapValidationError(error);
      }
    },
    settingsTestConnection: (
      request: SettingsTestConnectionRequest,
    ): Promise<SettingsTestConnectionResponse> => handlers.testConnection(request),
  };
}
