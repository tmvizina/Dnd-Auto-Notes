import type { z } from "zod";
import type { LlmUsage } from "./normalize.js";

export interface LlmCompletionRequest<T> {
  readonly system: string;
  readonly prompt: string;
  readonly schema: z.ZodType<T>;
  readonly signal?: AbortSignal;
}

export interface LlmCompletion<T> {
  readonly value: T;
  readonly usage?: LlmUsage;
  readonly cached?: boolean;
}

export interface LlmProvider {
  complete<T>(request: LlmCompletionRequest<T>): Promise<LlmCompletion<T>>;
  capabilities(): Promise<{
    readonly available: boolean;
    readonly provider: string;
    readonly reason?: string;
  }>;
}

export class LlmUnavailableError extends Error {
  readonly code = "llm_unavailable" as const;
  constructor(
    readonly provider: string,
    message = `${provider} is unavailable`,
  ) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export class LlmResponseError extends Error {
  readonly code = "llm_invalid_response" as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmResponseError";
  }
}

export class NoneProvider implements LlmProvider {
  async complete<T>(request: LlmCompletionRequest<T>): Promise<LlmCompletion<T>> {
    void request;
    throw new LlmUnavailableError("none");
  }
  async capabilities(): Promise<{
    readonly available: boolean;
    readonly provider: string;
    readonly reason: string;
  }> {
    return { available: false, provider: "none", reason: "no language model provider configured" };
  }
}
