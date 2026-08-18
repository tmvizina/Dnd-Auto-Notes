import { describe, expect, it, vi } from "vitest";
import { Attribution } from "../contracts/attribution.js";
import { MemoryAdjudicationCache, adjudicateSpans, revertAdjudications } from "./adjudicate.js";
import type { LlmProvider } from "../llm/provider.js";

const attribution = Attribution.parse({
  utterance_id: "u1",
  mode: "uncertain",
  character_id: null,
  confidence: 0.4,
  evidence: { score_ic: 0.5 },
  flags: [{ code: "uncertain", reason: "ambiguous" }],
  children: [],
  source: "deterministic",
  overridden_from: null,
});
const span = {
  attribution,
  transcript_window: "the guard watches",
  speaker: "Alice",
  candidates: [
    { label: "in_character", character_id: "ch_guard" },
    { label: "out_of_character", character_id: null },
  ],
};

function fakeProvider(response: unknown): LlmProvider {
  return {
    capabilities: async () => ({ available: true, provider: "fake" }),
    complete: vi.fn(async () => ({ value: response })),
  } as unknown as LlmProvider;
}

describe("adjudication", () => {
  it("accepts only candidate labels, marks source, caches, and reverts", async () => {
    const provider = fakeProvider({
      utterance_id: "u1",
      label: "in_character",
      character_id: "ch_guard",
      confidence: 0.3,
      reason: "guard context",
    });
    const cache = new MemoryAdjudicationCache();
    const first = await adjudicateSpans([span], provider, { cache });
    expect(first.attributions[0]).toMatchObject({
      source: "llm",
      mode: "in_character",
      character_id: "ch_guard",
    });
    const second = await adjudicateSpans([span], provider, { cache });
    expect(second.cacheHits).toBe(1);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(revertAdjudications(first.attributions)[0]).toMatchObject({
      source: "deterministic",
      mode: "in_character",
    });
  });

  it("rejects out-of-set labels and retries malformed provider responses once", async () => {
    const provider = {
      capabilities: async () => ({ available: true, provider: "fake" }),
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error("schema"))
        .mockResolvedValueOnce({
          value: {
            utterance_id: "u1",
            label: "in_character",
            character_id: "ch_not_allowed",
            confidence: 0.9,
            reason: "bad",
          },
        }),
    } as unknown as LlmProvider;
    const result = await adjudicateSpans([span], provider);
    expect(result.rejected).toEqual(["u1"]);
    expect(result.attributions[0]?.source).toBe("deterministic");
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("keeps none-provider failures as intact deterministic flags", async () => {
    const provider = fakeProvider(undefined);
    const result = await adjudicateSpans([span], provider);
    expect(result.attributions[0]?.source).toBe("deterministic");
  });

  it("rejects confidence increases and separates cache entries by provider context", async () => {
    const cache = new MemoryAdjudicationCache();
    const high = fakeProvider({
      utterance_id: "u1",
      label: "in_character",
      character_id: "ch_guard",
      confidence: 0.9,
      reason: "too certain",
    });
    const rejected = await adjudicateSpans([span], high, { cache });
    expect(rejected.rejected).toEqual(["u1"]);
    const other = {
      capabilities: async () => ({ available: true, provider: "different-model" }),
      complete: vi.fn(async () => ({
        value: {
          utterance_id: "u1",
          label: "in_character",
          character_id: "ch_guard",
          confidence: 0.2,
          reason: "bounded",
        },
      })),
    } as unknown as LlmProvider;
    const accepted = await adjudicateSpans([span], other, { cache });
    expect(accepted.cacheHits).toBe(0);
    expect(accepted.attributions[0]?.source).toBe("llm");
    expect(other.complete).toHaveBeenCalledTimes(1);
  });
});
