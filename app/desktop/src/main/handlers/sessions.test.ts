import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, openDb, upsertSession } from "@dnd/core";
import {
  copyInputFile,
  createSessionHandlers,
  resolvePipelineSessionRoot,
  runSessionIntake,
  saveSessionMappings,
} from "./sessions.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".p4-05-sessions-"));
  roots.push(root);
  return root;
}

async function writeCampaign(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "campaign.json"), JSON.stringify({ name: "Synthetic campaign" }));
  await writeFile(
    join(root, "players.json"),
    JSON.stringify({
      players: [
        {
          id: "pl_ash",
          display_name: "Ash",
          discord: { username: "ashcodes", craig_track_hints: [] },
          roll20: { player_ids: [] },
          characters: [],
        },
      ],
    }),
  );
  await writeFile(join(root, "npcs.json"), JSON.stringify({ npcs: [] }));
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("session desktop handlers", () => {
  it("streams copy progress and discovers folders created outside the app", async () => {
    const root = await tempRoot();
    const source = join(root, "recording.wav");
    const sessionRoot = join(root, "sessions", "2026-01-01-external");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      join(sessionRoot, "session.json"),
      JSON.stringify({
        id: "2026-01-01-external",
        title: "External folder",
        number: null,
        date: "2026-01-01",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    await writeFile(source, Buffer.alloc(512 * 1024, 7));
    const progress: number[] = [];
    const copied = await copyInputFile({
      sessionRoot,
      kind: "craig",
      sourcePath: source,
      onProgress: (update) => progress.push(update.fraction),
    });
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toBe(1);
    expect((await readFile(copied.destinationPath)).byteLength).toBe(512 * 1024);

    const db = openDb(join(root, "notes.db"));
    try {
      const handlers = createSessionHandlers({ sessionsRoot: join(root, "sessions"), db });
      await expect(handlers.sessionsList({ limit: 10 })).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionId: "2026-01-01-external" })],
      });
      handlers.dispose();
    } finally {
      closeDb(db);
    }
  });

  it("creates the scaffold and writes only explicit registry decisions", async () => {
    const root = await tempRoot();
    const campaign = join(root, "campaign");
    await writeCampaign(campaign);
    const db = openDb(join(root, "notes.db"));
    try {
      const handlers = createSessionHandlers({
        sessionsRoot: join(root, "sessions"),
        campaignRoot: campaign,
        db,
      });
      const created = await handlers.sessionsCreate({
        sessionId: "2026-01-02-new-session",
        title: "New session",
        number: 2,
        date: "2026-01-02",
      });
      expect(created.paths).toBeDefined();
      expect(existsSync(created.paths?.craig ?? "")).toBe(true);
      expect(existsSync(created.paths?.roll20 ?? "")).toBe(true);
      handlers.dispose();
    } finally {
      closeDb(db);
    }

    await saveSessionMappings(campaign, [
      { observed: "ash-track", kind: "discord", playerId: "pl_ash" },
    ]);
    const players = JSON.parse(await readFile(join(campaign, "players.json"), "utf8")) as {
      players: Array<{ discord: { craig_track_hints: string[] } }>;
    };
    expect(players.players[0]?.discord.craig_track_hints).toEqual(["ash-track"]);
  });

  it("reports missing inputs through QA instead of exposing a stack", async () => {
    const root = await tempRoot();
    const campaign = join(root, "campaign");
    await writeCampaign(campaign);
    const sessionsRoot = join(root, "sessions");
    const sessionRoot = join(sessionsRoot, "2026-01-03-missing");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      join(sessionRoot, "session.json"),
      JSON.stringify({
        id: "2026-01-03-missing",
        title: "Missing input",
        number: null,
        date: "2026-01-03",
        created_at: "2026-01-03T00:00:00.000Z",
      }),
    );
    const result = await runSessionIntake({ sessionRoot, campaignRoot: campaign, force: true });
    expect(result.value?.qa.map((entry) => entry.code)).toContain("ROLL20_NO_CAPTURE");
  });

  it("rejects stale database roots outside the sessions folder", async () => {
    const root = await tempRoot();
    const sessionsRoot = join(root, "sessions");
    const outsideRoot = join(root, "outside", "not-a-session");
    const source = join(root, "recording.wav");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(
      join(outsideRoot, "session.json"),
      JSON.stringify({
        id: "stale-outside",
        title: "Outside",
        number: null,
        date: "2026-01-04",
        created_at: "2026-01-04T00:00:00.000Z",
      }),
    );
    await writeFile(source, Buffer.from("source"));
    const db = openDb(join(root, "notes.db"));
    try {
      upsertSession(db, {
        session_id: "stale-outside",
        title: "Outside",
        number: null,
        date: "2026-01-04",
        root_path: outsideRoot,
      });
      const handlers = createSessionHandlers({ sessionsRoot, db });
      await expect(handlers.sessionsList({ limit: 10 })).resolves.toEqual({ sessions: [] });
      await expect(handlers.sessionsGet({ sessionId: "stale-outside" })).resolves.toEqual({
        session: null,
      });
      await expect(
        handlers.sessionsCopy({
          sessionId: "stale-outside",
          kind: "craig",
          sourcePath: source,
        }),
      ).rejects.toThrow("session was not found");
      await expect(
        handlers.sessionsReveal({ sessionId: "stale-outside", kind: "craig" }),
      ).rejects.toThrow("session was not found");
      await expect(handlers.sessionsQa({ sessionId: "stale-outside" })).rejects.toThrow(
        "session was not found",
      );
      await expect(
        handlers.sessionsMapping({ sessionId: "stale-outside", decisions: [] }),
      ).rejects.toThrow("session was not found");
      handlers.dispose();
    } finally {
      closeDb(db);
    }
  });

  it("rejects an in-root junction whose target escapes the sessions folder", async () => {
    const root = await tempRoot();
    const sessionsRoot = join(root, "sessions");
    const outsideRoot = join(root, "outside", "linked-session");
    const linkedRoot = join(sessionsRoot, "linked-session");
    const source = join(root, "recording.wav");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await symlink(outsideRoot, linkedRoot, "junction");
    await writeFile(
      join(outsideRoot, "session.json"),
      JSON.stringify({
        id: "linked-outside",
        title: "Linked outside",
        number: null,
        date: "2026-01-04",
        created_at: "2026-01-04T00:00:00.000Z",
      }),
    );
    await writeFile(source, Buffer.from("source"));
    const db = openDb(join(root, "notes.db"));
    try {
      upsertSession(db, {
        session_id: "linked-outside",
        title: "Linked outside",
        number: null,
        date: "2026-01-04",
        root_path: linkedRoot,
      });
      const handlers = createSessionHandlers({ sessionsRoot, db });
      await expect(handlers.sessionsList({ limit: 10 })).resolves.toEqual({ sessions: [] });
      await expect(handlers.sessionsGet({ sessionId: "linked-outside" })).resolves.toEqual({
        session: null,
      });
      await expect(
        handlers.sessionsCopy({
          sessionId: "linked-outside",
          kind: "craig",
          sourcePath: source,
        }),
      ).rejects.toThrow("session was not found");
      await expect(
        handlers.sessionsReveal({ sessionId: "linked-outside", kind: "craig" }),
      ).rejects.toThrow("session was not found");
      await expect(handlers.sessionsQa({ sessionId: "linked-outside" })).rejects.toThrow(
        "session was not found",
      );
      await expect(
        handlers.sessionsMapping({ sessionId: "linked-outside", decisions: [] }),
      ).rejects.toThrow("session was not found");
      await expect(resolvePipelineSessionRoot(sessionsRoot, "linked-session")).rejects.toThrow(
        "session was not found",
      );
      handlers.dispose();
    } finally {
      closeDb(db);
    }
  });

  it("rejects escaping input, work, and campaign descendants", async () => {
    const root = await tempRoot();
    const sessionsRoot = join(root, "sessions");
    const sessionRoot = join(sessionsRoot, "2026-01-05-descendant-links");
    const outsideRoot = join(root, "outside");
    const outsideCraig = join(outsideRoot, "craig");
    const outsideRoll20 = join(outsideRoot, "roll20");
    const outsideCampaign = join(outsideRoot, "campaign");
    const source = join(root, "recording.wav");
    await mkdir(join(sessionRoot, "input"), { recursive: true });
    await mkdir(outsideCraig, { recursive: true });
    await mkdir(outsideRoll20, { recursive: true });
    await mkdir(outsideCampaign, { recursive: true });
    await writeFile(
      join(sessionRoot, "session.json"),
      JSON.stringify({
        id: "2026-01-05-descendant-links",
        title: "Descendant links",
        number: null,
        date: "2026-01-05",
        created_at: "2026-01-05T00:00:00.000Z",
      }),
    );
    await symlink(outsideCraig, join(sessionRoot, "input", "craig"), "junction");
    await symlink(outsideRoll20, join(sessionRoot, "input", "roll20"), "junction");
    await symlink(outsideCampaign, join(sessionRoot, "campaign"), "junction");
    await writeFile(source, Buffer.from("source"));
    const db = openDb(join(root, "notes.db"));
    try {
      const handlers = createSessionHandlers({
        sessionsRoot,
        db,
        revealPath: async () => true,
      });
      await expect(
        handlers.sessionsCopy({
          sessionId: "2026-01-05-descendant-links",
          kind: "craig",
          sourcePath: source,
        }),
      ).rejects.toThrow("unsafe session path: input/craig");
      await expect(
        handlers.sessionsCopy({
          sessionId: "2026-01-05-descendant-links",
          kind: "roll20",
          sourcePath: source,
        }),
      ).rejects.toThrow("unsafe session path: input/roll20");
      await expect(
        handlers.sessionsReveal({
          sessionId: "2026-01-05-descendant-links",
          kind: "craig",
        }),
      ).rejects.toThrow("unsafe session path: input/craig");
      await expect(
        handlers.sessionsReveal({
          sessionId: "2026-01-05-descendant-links",
          kind: "roll20",
        }),
      ).rejects.toThrow("unsafe session path: input/roll20");
      await expect(
        handlers.sessionsQa({ sessionId: "2026-01-05-descendant-links" }),
      ).rejects.toThrow("unsafe session path: campaign");
      await expect(
        handlers.sessionsMapping({
          sessionId: "2026-01-05-descendant-links",
          decisions: [],
        }),
      ).rejects.toThrow("unsafe session path: campaign");
      handlers.dispose();
    } finally {
      closeDb(db);
    }
  });

  it("rejects nested stage links before list, get, or intake writes", async () => {
    const root = await tempRoot();
    const sessionsRoot = join(root, "sessions");
    const sessionRoot = join(sessionsRoot, "2026-01-06-nested-stage-link");
    const outsideStage = join(root, "outside", "intake");
    await mkdir(join(sessionRoot, "work"), { recursive: true });
    await mkdir(outsideStage, { recursive: true });
    await writeFile(
      join(sessionRoot, "session.json"),
      JSON.stringify({
        id: "2026-01-06-nested-stage-link",
        title: "Nested stage link",
        number: null,
        date: "2026-01-06",
        created_at: "2026-01-06T00:00:00.000Z",
      }),
    );
    await symlink(outsideStage, join(sessionRoot, "work", "01-intake"), "junction");
    const db = openDb(join(root, "notes.db"));
    try {
      const handlers = createSessionHandlers({ sessionsRoot, db });
      await expect(handlers.sessionsList({ limit: 10 })).rejects.toThrow("unsafe session path");
      await expect(
        handlers.sessionsGet({ sessionId: "2026-01-06-nested-stage-link" }),
      ).rejects.toThrow("unsafe session path");
      await expect(
        runSessionIntake({ sessionRoot, campaignRoot: join(root, "campaign"), force: true }),
      ).rejects.toThrow("unsafe session path");
      handlers.dispose();
    } finally {
      closeDb(db);
    }
  });

  it("saves local campaign mappings that a forced rerun consumes", async () => {
    const root = await tempRoot();
    const campaign = join(root, "campaign");
    const sessionsRoot = join(root, "sessions");
    await writeCampaign(campaign);
    const db = openDb(join(root, "notes.db"));
    try {
      const handlers = createSessionHandlers({ sessionsRoot, campaignRoot: campaign, db });
      await handlers.sessionsCreate({
        sessionId: "2026-01-05-local-campaign",
        title: "Local campaign",
        number: 5,
        date: "2026-01-05",
      });
      const sessionRoot = join(sessionsRoot, "2026-01-05-local-campaign");
      const localCampaign = join(sessionRoot, "campaign");
      await writeCampaign(localCampaign);
      await writeFile(
        join(sessionRoot, "input", "roll20", "roll20-capture.json"),
        JSON.stringify({
          messages: [
            {
              id: "roll-1",
              seq: 1,
              who: "Ash",
              kind: "rollresult",
              text: "Attack",
              roll: {
                formula: "1d20",
                dice: [{ sides: 20, value: 12 }],
                total: 12,
                kind: "attack",
              },
            },
          ],
        }),
      );

      const firstRun = await runSessionIntake({
        sessionRoot,
        campaignRoot: campaign,
        force: true,
      });
      expect(firstRun.value?.qa.map((entry) => entry.code)).toContain("ROLL20_ACCOUNT_UNMAPPED");

      await expect(
        handlers.sessionsMapping({
          sessionId: "2026-01-05-local-campaign",
          decisions: [{ observed: "Ash", kind: "roll20", playerId: "pl_ash" }],
        }),
      ).resolves.toEqual({ saved: true });
      const localPlayers = JSON.parse(
        await readFile(join(localCampaign, "players.json"), "utf8"),
      ) as {
        players: Array<{ roll20: { account_name?: string } }>;
      };
      expect(localPlayers.players[0]?.roll20.account_name).toBe("Ash");

      const rerun = await runSessionIntake({
        sessionRoot,
        campaignRoot: campaign,
        force: true,
      });
      expect(rerun.value?.qa.map((entry) => entry.code)).not.toContain("ROLL20_ACCOUNT_UNMAPPED");
      handlers.dispose();
    } finally {
      closeDb(db);
    }
  });
});
