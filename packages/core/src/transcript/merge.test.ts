import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Manifest, Transcript } from "../contracts/index.js";
import { createSession, readArtifact, writeArtifact } from "../session/index.js";
import { runTranscriptStage } from "../stages/transcript.js";
import { mergeTranscripts } from "./merge.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cross-track transcript merge", () => {
  it("marks overlap and mic bleed, preserves both copies, and splits only at word gaps", () => {
    const result = mergeTranscripts([
      {
        track_id: "t1",
        player_id: "pl_ash",
        vad_segments: [{ start_s: 1, end_s: 8, mean_rms: 0.9 }],
        backend: "fake",
        model: "fixture",
        asr_segments: [
          {
            start_s: 1,
            end_s: 2.5,
            text: "the guard advances",
            words: [
              { t: "the", s: 1, e: 1.25 },
              { t: "guard", s: 1.3, e: 1.8 },
              { t: "advances", s: 1.9, e: 2.5 },
            ],
          },
          {
            start_s: 4,
            end_s: 7,
            text: "First sentence Second sentence",
            words: [
              { t: "First", s: 4, e: 4.4 },
              { t: "sentence", s: 4.5, e: 5 },
              { t: "Second", s: 6, e: 6.4 },
              { t: "sentence", s: 6.5, e: 7 },
            ],
          },
        ],
      },
      {
        track_id: "t2",
        player_id: "pl_bly",
        vad_segments: [{ start_s: 1.1, end_s: 3.4, mean_rms: 0.2 }],
        backend: "fake",
        model: "fixture",
        asr_segments: [
          {
            start_s: 1.1,
            end_s: 2.6,
            text: "the guard advances",
            words: [
              { t: "the", s: 1.1, e: 1.35 },
              { t: "guard", s: 1.4, e: 1.9 },
              { t: "advances", s: 2, e: 2.6 },
            ],
          },
          {
            start_s: 3,
            end_s: 3.4,
            text: "Yeah.",
            words: [{ t: "Yeah.", s: 3, e: 3.4 }],
          },
        ],
      },
    ]);

    expect(result.qa).toEqual([
      expect.objectContaining({
        code: "MIC_BLEED",
        subject: "t1,t2",
        message: expect.stringContaining("t1,t2"),
      }),
    ]);
    expect(result.transcript.utterances).toHaveLength(5);
    const [primary, duplicate, backchannel, firstSentence, secondSentence] =
      result.transcript.utterances;
    expect(primary?.id).toBe("u000001");
    expect(duplicate?.id).toBe("u000002");
    expect(primary?.overlap_ids).toEqual([duplicate?.id]);
    expect(duplicate?.overlap_ids).toEqual([primary?.id]);
    expect(primary?.bleed_of).toBeNull();
    expect(duplicate?.bleed_of).toBe(primary?.id);
    expect(backchannel?.is_backchannel).toBe(true);
    expect([firstSentence?.text, secondSentence?.text]).toEqual([
      "First sentence",
      "Second sentence",
    ]);
    expect(firstSentence?.words.map((word) => word.t)).toEqual(["First", "sentence"]);
    expect(secondSentence?.words.map((word) => word.t)).toEqual(["Second", "sentence"]);
    expect(result.transcript.counts?.speech_seconds_by_player).toEqual({
      pl_ash: 7,
      pl_bly: 2.3,
    });

    expect(
      mergeTranscripts([
        {
          track_id: "t2",
          player_id: "pl_bly",
          vad_segments: [{ start_s: 1.1, end_s: 3.4, mean_rms: 0.2 }],
          backend: "fake",
          model: "fixture",
          asr_segments: [
            { start_s: 1.1, end_s: 2.6, text: "the guard advances", words: duplicate?.words },
            { start_s: 3, end_s: 3.4, text: "Yeah.", words: backchannel?.words },
          ],
        },
        {
          track_id: "t1",
          player_id: "pl_ash",
          vad_segments: [{ start_s: 1, end_s: 8, mean_rms: 0.9 }],
          backend: "fake",
          model: "fixture",
          asr_segments: [
            { start_s: 1, end_s: 2.5, text: "the guard advances", words: primary?.words },
            {
              start_s: 4,
              end_s: 7,
              text: "First sentence Second sentence",
              words: [...(firstSentence?.words ?? []), ...(secondSentence?.words ?? [])],
            },
          ],
        },
      ]).transcript,
    ).toEqual(result.transcript);
  });

  it("runs VAD and ASR for every manifest track and skips a byte-stable rerun", async () => {
    const root = mkdtempSync(join(process.cwd(), ".p2-03-stage-"));
    temporaryRoots.push(root);
    const session = await createSession(root, { title: "Synthetic Merge", date: "2026-08-16" });
    const inputRoot = session.paths.input("craig");
    mkdirSync(inputRoot, { recursive: true });
    const tracks = [
      { track_id: "t1", path: "input/craig/1-ash.wav", player_id: "pl_ash", start_s: 1, end_s: 2 },
      {
        track_id: "t2",
        path: "input/craig/2-bly.wav",
        player_id: "pl_bly",
        start_s: 2.1,
        end_s: 3.2,
      },
    ] as const;
    for (const track of tracks) writeFileSync(join(session.paths.root, track.path), "synthetic");
    const manifest = {
      session_id: session.descriptor.id,
      recording: { started_at: null, duration_s: 4, source: "craig" as const, track_count: 2 },
      tracks: tracks.map((track) => ({
        track_id: track.track_id,
        path: track.path,
        player_id: track.player_id,
        match: "manual" as const,
        sha256: "0".repeat(64),
        duration_s: 4,
        sample_rate: 8000,
        channels: 1,
        speech_ratio: 0.5,
        aligned: true,
      })),
      rolls: [],
      roll20: null,
      qa: [],
    };
    expect(Manifest.safeParse(manifest).success).toBe(true);
    await writeArtifact(session, "manifest", manifest);

    const calls: string[] = [];
    const fakeSidecar = {
      async runJob<T>(kind: string, payload: unknown): Promise<T> {
        const body = payload as {
          track_path: string;
          segments?: readonly { start_s: number; end_s: number }[];
        };
        const trackName = basename(body.track_path);
        calls.push(`${kind}:${trackName}`);
        if (kind === "vad") {
          return {
            segments: trackName.startsWith("1-")
              ? [{ start_s: 1, end_s: 2, mean_rms: 0.8 }]
              : [{ start_s: 2.1, end_s: 3.2, mean_rms: 0.7 }],
          } as T;
        }
        return {
          backend: "fake",
          model: "fixture",
          segments: body.segments?.map((segment) => ({
            start_s: segment.start_s,
            end_s: segment.end_s,
            text: trackName.startsWith("1-") ? "first synthetic line" : "second synthetic line",
            words: [
              {
                t: trackName.startsWith("1-") ? "first" : "second",
                s: segment.start_s,
                e: segment.end_s,
              },
            ],
          })),
        } as T;
      },
    };

    const first = await runTranscriptStage({ session, sidecar: fakeSidecar, force: true });
    expect(first.skipped).toBe(false);
    const transcript = await readArtifact(session, "transcript");
    expect(Transcript.safeParse(transcript).success).toBe(true);
    expect(transcript.utterances.map((utterance) => utterance.text)).toEqual([
      "first synthetic line",
      "second synthetic line",
    ]);
    expect(calls).toEqual([
      "vad:1-ash.wav",
      "transcribe:1-ash.wav",
      "vad:2-bly.wav",
      "transcribe:2-bly.wav",
    ]);
    const before = readFileSync(session.paths.artifact("transcript"), "utf8");
    const second = await runTranscriptStage({ session, sidecar: fakeSidecar });
    expect(second.skipped).toBe(true);
    expect(readFileSync(session.paths.artifact("transcript"), "utf8")).toBe(before);
    expect(calls).toHaveLength(4);
  });
});
