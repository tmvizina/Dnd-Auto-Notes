import { join } from "node:path";
import { loadRegistry, charactersActiveAt } from "../campaign/registry.js";
import { classifyLexical, findQuoteSpans, matchRollTotalEvidence } from "../persona/lexical.js";
import type {
  PersonaProfile,
  PersonaScorerConfig,
  PersonaScoringInput,
  PersonaScoreResult,
} from "../persona/scorer.js";
import { scorePersona } from "../persona/scorer.js";
import type { AttributionFile } from "../contracts/attribution.js";
import type { QaReport } from "../contracts/qa.js";
import type { Features } from "../contracts/features.js";
import type { Timeline } from "../contracts/timeline.js";
import type { Transcript } from "../contracts/utterances.js";
import { loadConfig } from "../persona/scorer.js";
import { mirrorQaFlags } from "../qa/mirror.js";
import { readArtifact, writeArtifact } from "../session/session.js";
import type { Session } from "../session/session.js";
import type { FileIo } from "../session/io.js";
import type { Db } from "../db/db.js";
import { runStage } from "../stage/runner.js";
import type { ProgressFn, StageResult } from "../stage/runner.js";

export const PERSONA_STAGE_VERSION = 1;

export interface PersonaStageOptions {
  readonly session: Session;
  readonly campaignRoot: string;
  readonly config?: PersonaScorerConfig;
  readonly profiles?: Readonly<Record<string, readonly PersonaProfile[]>>;
  readonly profilePaths?: readonly string[];
  readonly truth?: Readonly<Record<string, "in_character" | "out_of_character">>;
  readonly db?: Db;
  readonly force?: boolean;
  readonly onProgress?: ProgressFn;
  readonly io?: FileIo;
}

export type PersonaStageResult = StageResult<AttributionFile> & {
  readonly accuracy?: PersonaScoreResult["accuracy"];
};

function inputFor(
  utterance: Transcript["utterances"][number],
  features: Features,
  timeline: Timeline,
  registry: Awaited<ReturnType<typeof loadRegistry>>,
  sessionNumber: number | null,
  profiles: Readonly<Record<string, readonly PersonaProfile[]>>,
): PersonaScoringInput {
  const feature = features.rows.find((row) => row.utterance_id === utterance.id);
  const lexical = classifyLexical(
    utterance.text,
    {
      glossary: registry.glossary,
      players: registry.players,
      ...(utterance.player_id === null ? {} : { speakerPlayerId: utterance.player_id }),
      npcs: registry.npcs,
      ...(registry.lexicon === null ? {} : { lexicon: registry.lexicon.classes }),
    },
    utterance.words,
    matchRollTotalEvidence(
      utterance.text,
      utterance.start_s,
      utterance.end_s,
      timeline.anchors.map((anchor) => ({
        id: anchor.roll_id,
        total: timeline.rolls.find((roll) => roll.id === anchor.roll_id)?.total ?? 0,
        t_audio_s: anchor.t_audio_s,
        t_uncertainty_s: anchor.t_uncertainty_s,
      })),
    ),
  );
  const midpoint = (utterance.start_s + utterance.end_s) / 2;
  const rollProx = timeline.anchors.some(
    (anchor) => Math.abs(anchor.t_audio_s - midpoint) <= anchor.t_uncertainty_s + 2,
  );
  const active =
    sessionNumber === null
      ? registry.players.flatMap((player) => player.characters)
      : charactersActiveAt(registry, sessionNumber);
  const profileRows = utterance.player_id === null ? [] : (profiles[utterance.player_id] ?? []);
  const characterProfiles = profileRows.filter((profile) => profile.character_id !== null);
  const tableProfiles = profileRows.filter((profile) => profile.character_id === null);
  const bestCharacter = [...characterProfiles].sort(
    (left, right) => right.similarity - left.similarity,
  )[0]?.similarity;
  const bestTable = [...tableProfiles].sort((left, right) => right.similarity - left.similarity)[0]
    ?.similarity;
  return {
    utterance_id: utterance.id,
    player_id: utterance.player_id,
    start_s: utterance.start_s,
    end_s: utterance.end_s,
    text: utterance.text,
    ...(bestTable === undefined ? {} : { voice_sim_table: bestTable }),
    ...(bestCharacter === undefined ? {} : { voice_sim_character: bestCharacter }),
    ...(bestCharacter === undefined || bestTable === undefined
      ? {}
      : { voice_margin: bestCharacter - bestTable }),
    ...(feature?.prosody_z === null || feature?.prosody_z === undefined
      ? {}
      : { prosody_z: feature.prosody_z }),
    lex_ooc: lexical.lex_ooc,
    lex_ic: lexical.lex_ic,
    roll_prox: rollProx,
    chat_prox: false,
    addressee: "unknown",
    is_backchannel: utterance.is_backchannel,
    overlap: utterance.overlap_ids.length > 0,
    profiles: profileRows,
    active_character_ids: active.map((character) => character.id),
    quoteSpans: findQuoteSpans(utterance.words),
  };
}

function reportFor(file: AttributionFile): QaReport {
  return {
    stage: "persona",
    entries: file.attributions.flatMap((attribution) =>
      attribution.flags.map((flag) => ({
        code: flag.code,
        severity: flag.code === "no_profile_match" ? ("error" as const) : ("warning" as const),
        message: flag.reason,
        subject: attribution.utterance_id,
      })),
    ),
    metrics: { attributions: file.attributions.length, uncertain: file.summary.uncertain },
  };
}

export async function runPersonaStage(options: PersonaStageOptions): Promise<PersonaStageResult> {
  const config = options.config ?? loadConfig();
  const transcript = await readArtifact(options.session, "transcript");
  const features = await readArtifact(options.session, "features");
  const timeline = await readArtifact(options.session, "timeline");
  const registry = await loadRegistry(options.campaignRoot);
  const inputs = transcript.utterances.map((utterance) =>
    inputFor(
      utterance,
      features,
      timeline,
      registry,
      options.session.descriptor.number,
      options.profiles ?? {},
    ),
  );
  let accuracy: PersonaScoreResult["accuracy"];
  const result = await runStage<AttributionFile>(
    {
      session: options.session,
      stage: "persona",
      version: config.stage_version,
      output: "attribution",
      inputs: [
        options.session.paths.artifact("transcript"),
        options.session.paths.artifact("features"),
        options.session.paths.artifact("timeline"),
        join(options.campaignRoot, "campaign.json"),
        join(options.campaignRoot, "players.json"),
        join(options.campaignRoot, "npcs.json"),
        join(options.campaignRoot, "lexicon.ooc.json"),
        ...(options.profilePaths ?? []),
      ],
      params: { config, profiles: options.profiles ?? {} },
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.io === undefined ? {} : { io: options.io }),
    },
    async ({ progress }) => {
      progress(0.2, "scoring persona evidence");
      const scored = scorePersona(inputs, config, options.truth);
      accuracy = scored.accuracy;
      await writeArtifact(options.session, "attribution", scored.file, options.io);
      if (options.db !== undefined)
        mirrorQaFlags(options.db, options.session.descriptor.id, reportFor(scored.file), "persona");
      progress(1, "persona attribution complete");
      return scored.file;
    },
  );
  return accuracy === undefined ? result : { ...result, accuracy };
}

export const personaStage = runPersonaStage;
