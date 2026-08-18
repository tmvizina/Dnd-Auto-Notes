import {
  LlmResponseError,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProvider,
} from "./provider.js";

export interface HttpProviderOptions {
  readonly baseUrl: string;
  readonly model?: string;
  readonly fetch?: typeof fetch;
}

export class HttpLocalProvider implements LlmProvider {
  constructor(private readonly options: HttpProviderOptions) {}
  async capabilities(): Promise<{
    readonly available: boolean;
    readonly provider: string;
    readonly reason?: string;
  }> {
    return { available: true, provider: `http-local:${this.options.model ?? "local"}` };
  }
  async complete<T>(request: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
    const response = await (this.options.fetch ?? fetch)(
      new URL("/v1/chat/completions", this.options.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.options.model ?? "local",
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          response_format: { type: "json_object" },
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    if (!response.ok)
      throw new LlmResponseError(`local model returned HTTP ${String(response.status)}`);
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object")
      throw new LlmResponseError("local model response was not an object");
    const content = (body as Record<string, unknown>)["choices"];
    const text =
      Array.isArray(content) && content[0] !== null && typeof content[0] === "object"
        ? (
            (content[0] as Record<string, unknown>)["message"] as
              Record<string, unknown> | undefined
          )?.["content"]
        : undefined;
    if (typeof text !== "string")
      throw new LlmResponseError("local model response had no message content");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmResponseError("local model result was not JSON");
    }
    const checked = request.schema.safeParse(parsed);
    if (!checked.success)
      throw new LlmResponseError("local model result failed the requested schema");
    return { value: checked.data };
  }
}
