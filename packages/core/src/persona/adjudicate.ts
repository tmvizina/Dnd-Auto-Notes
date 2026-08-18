import { createHash } from "node:crypto";
import { z } from "zod";
import type { Attribution } from "../contracts/attribution.js";
import type { LlmProvider } from "../llm/provider.js";

export const AdjudicationResponse = z.object({
  utterance_id: z.string().min(1),
  label: z.enum(["in_character", "out_of_character", "narration", "uncertain"]),
  character_id: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});
export type AdjudicationResponse = z.infer<typeof AdjudicationResponse>;

export interface FlaggedSpan {
  readonly attribution: Attribution;
  readonly transcript_window: string;
  readonly speaker: string;
  readonly candidates: readonly { readonly label: string; readonly character_id: string | null }[];
}

export interface AdjudicationOptions {
  readonly cache?: AdjudicationCache;
  readonly signal?: AbortSignal;
  readonly batchSize?: number;
  readonly system?: string;
}

export interface AdjudicationCache {
  get(key: string): Promise<AdjudicationResponse | null>;
  set(key: string, value: AdjudicationResponse): Promise<void>;
}

export class MemoryAdjudicationCache implements AdjudicationCache {
  private readonly values = new Map<string, AdjudicationResponse>();
  async get(key: string): Promise<AdjudicationResponse | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: AdjudicationResponse): Promise<void> {
    this.values.set(key, value);
  }
}

function keyFor(span: FlaggedSpan, system: string, provider: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        attribution: span.attribution,
        window: span.transcript_window,
        speaker: span.speaker,
        candidates: span.candidates,
        system,
        provider,
      }),
    )
    .digest("hex");
}

function promptFor(spans: readonly FlaggedSpan[]): string {
  return JSON.stringify({
    task: "adjudicate only the supplied uncertain spans; return one JSON object per span",
    spans: spans.map((span) => ({
      utterance_id: span.attribution.utterance_id,
      transcript_window: span.transcript_window,
      speaker: span.speaker,
      candidates: span.candidates,
      evidence: span.attribution.evidence,
    })),
  });
}

function allowed(response: AdjudicationResponse, span: FlaggedSpan): boolean {
  if (response.utterance_id !== span.attribution.utterance_id) return false;
  return span.candidates.some(
    (candidate) =>
      candidate.label === response.label && candidate.character_id === response.character_id,
  );
}

function apply(span: FlaggedSpan, response: AdjudicationResponse): Attribution {
  return {
    ...span.attribution,
    mode: response.label,
    character_id: response.character_id,
    confidence: response.confidence,
    source: "llm",
    flags: [...span.attribution.flags, { code: "llm_adjudicated", reason: response.reason }],
  };
}

export interface AdjudicationResult {
  readonly attributions: readonly Attribution[];
  readonly cacheHits: number;
  readonly rejected: readonly string[];
}

export async function adjudicateSpans(
  flagged: readonly FlaggedSpan[],
  provider: LlmProvider,
  options: AdjudicationOptions = {},
): Promise<AdjudicationResult> {
  const cache = options.cache ?? new MemoryAdjudicationCache();
  const output: Attribution[] = flagged.map((span) => span.attribution);
  const rejected: string[] = [];
  const system = options.system ?? "Return strict adjudication JSON. Never invent candidates.";
  const capabilities = await provider.capabilities();
  const providerDiscriminator = JSON.stringify(capabilities);
  let cacheHits = 0;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 8));
  for (let start = 0; start < flagged.length; start += batchSize) {
    if (options.signal?.aborted) throw new Error("adjudication cancelled");
    const batch = flagged.slice(start, start + batchSize);
    for (const span of batch) {
      if (span.attribution.mode !== "uncertain") continue;
      const key = keyFor(span, system, providerDiscriminator);
      let response = await cache.get(key);
      if (response !== null) cacheHits += 1;
      if (response === null) {
        const request = {
          system,
          prompt: promptFor([span]),
          schema: AdjudicationResponse,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        try {
          const parsed = AdjudicationResponse.safeParse((await provider.complete(request)).value);
          if (!parsed.success) throw new Error("adjudicator response failed schema");
          response = parsed.data;
        } catch {
          try {
            const parsed = AdjudicationResponse.safeParse((await provider.complete(request)).value);
            if (!parsed.success) throw new Error("adjudicator response failed schema");
            response = parsed.data;
          } catch {
            rejected.push(span.attribution.utterance_id);
            continue;
          }
        }
        await cache.set(key, response);
      }
      if (!allowed(response, span) || response.confidence > span.attribution.confidence) {
        rejected.push(span.attribution.utterance_id);
        continue;
      }
      const index = flagged.indexOf(span);
      if (index >= 0) output[index] = apply(span, response);
    }
  }
  return { attributions: output, cacheHits, rejected };
}

export function revertAdjudications(attributions: readonly Attribution[]): readonly Attribution[] {
  return attributions.map((attribution) =>
    attribution.source === "llm"
      ? {
          ...attribution,
          source: "deterministic",
          overridden_from: attribution.mode,
          flags: attribution.flags.filter((flag) => flag.code !== "llm_adjudicated"),
        }
      : attribution,
  );
}
