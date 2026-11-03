import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentMediaAdmission } from "../src/agent-media/active.js";
import { agentMediaFinalPath } from "../src/agent-media/paths.js";
import { AgentMediaService } from "../src/agent-media/service.js";
import { deleteSessionAgentMedia, readAgentMedia } from "../src/agent-media/store.js";
import type { AgentMediaTarget } from "../src/agent-media/types.js";
import { appStateRoot } from "../src/attachments/paths.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  agentMediaAdmission.resetForTests();
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function png(extra = 600): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 7),
  ]);
}

interface Fixture {
  db: SqliteDatabase;
  target: AgentMediaTarget;
  appRoot: string;
  appDir: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-agent-media-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  const appDir = path.join(dir, "workspace", "app");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(path.join(appDir, "screenshots"), { recursive: true });
  const agentsHome = path.join(dir, "agents");
  const appRoot = appStateRoot(agentsHome, "p", "a");
  mkdirSync(path.join(appRoot, "tmp"), { recursive: true });
  mkdirSync(path.join(appRoot, "attachments"), { recursive: true });
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','workspace/app','AGENTS.md',?)",
  ).run(now);
  return {
    db,
    appRoot,
    appDir,
    target: {
      appId: "p:a",
      projectId: "p",
      appKey: "a",
      appDir,
      appRoot,
      workspaceRoot: path.join(dir, "workspace"),
      pathMode: "supervisor",
    },
  };
}

describe("agent media service", () => {
  it("stores an app image, attaches it, and serves a view", async () => {
    const { db, target, appDir, appRoot } = fixture();
    const source = path.join(appDir, "screenshots", "ui.png");
    writeFileSync(source, png());
    const service = new AgentMediaService(db, target);

    const result = await service.showImage({
      path: "screenshots/ui.png",
      caption: "Settings after the save",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = readAgentMedia(db, "p:a", result.id);
    expect(row?.state).toBe("staged");
    expect(readFileSync(agentMediaFinalPath(appRoot, row?.storedName ?? ""))).toEqual(png());

    const attached = service.attach("p:a", result.id, "ses_1", "msg_1", "prt_1");
    expect(attached.status).toBe("attached");
    if (attached.status !== "attached") return;
    expect(attached.view.downloadURL).toContain(`/agent-media/${result.id}`);
    expect(attached.view.origin).toBe("agent");
    expect(attached.view.caption).toBe("Settings after the save");
    expect(readAgentMedia(db, "p:a", result.id)?.state).toBe("attached");
  });

  it("expands $TMPDIR and resolves model-visible paths", async () => {
    const { db, target, appRoot } = fixture();
    writeFileSync(path.join(appRoot, "tmp", "shot.png"), png());
    const service = new AgentMediaService(db, target);
    const result = await service.showImage({ path: "$TMPDIR/shot.png" });
    expect(result.ok).toBe(true);
  });

  it("rejects paths outside the allowed roots and symlink escapes", async () => {
    const { db, target, appDir, appRoot } = fixture();
    mkdirSync(path.join(appRoot, "home"), { recursive: true });
    writeFileSync(path.join(appRoot, "home", "secret.png"), png());
    writeFileSync(path.join(appDir, "ok.png"), png());
    symlinkSync(path.join(appRoot, "home", "secret.png"), path.join(appDir, "link.png"));
    const service = new AgentMediaService(db, target);

    expect(
      await service.showImage({ path: path.join(appRoot, "home", "secret.png") }),
    ).toMatchObject({
      ok: false,
      code: "path_outside_app",
    });
    expect(await service.showImage({ path: "link.png" })).toMatchObject({
      ok: false,
      code: "path_outside_app",
    });
  });

  it("rejects empty, unsupported, and missing files", async () => {
    const { db, target, appDir } = fixture();
    writeFileSync(path.join(appDir, "empty.png"), Buffer.alloc(0));
    writeFileSync(path.join(appDir, "vector.svg"), "<svg></svg>");
    const service = new AgentMediaService(db, target);
    expect(await service.showImage({ path: "empty.png" })).toMatchObject({
      ok: false,
      code: "image_empty_file",
    });
    expect(await service.showImage({ path: "vector.svg" })).toMatchObject({
      ok: false,
      code: "image_unsupported",
    });
    expect(await service.showImage({ path: "missing.png" })).toMatchObject({
      ok: false,
      code: "image_unreadable",
    });
  });

  it("deletes session rows and files", async () => {
    const { db, target, appDir, appRoot } = fixture();
    writeFileSync(path.join(appDir, "ui.png"), png());
    const service = new AgentMediaService(db, target);
    const result = await service.showImage({ path: "ui.png" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    service.attach("p:a", result.id, "ses_1", "msg_1", "prt_1");
    const row = readAgentMedia(db, "p:a", result.id);
    expect(row).not.toBeNull();
    expect(deleteSessionAgentMedia(db, appRoot, "p:a", "ses_1")).toBe(1);
    expect(readAgentMedia(db, "p:a", result.id)).toBeUndefined();
    expect(() => readFileSync(agentMediaFinalPath(appRoot, row?.storedName ?? ""))).toThrow();
  });

  it("enforces the association CHECKs", () => {
    const { db } = fixture();
    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_media
             (id, app_id, session_id, message_id, part_id, original_name, stored_name, rel_path,
              mime, size, state, created_at, updated_at)
           VALUES ('amed_1','p:a','ses_1','msg_1','prt_1','a.png','a.png','agent-media/a.png',
              'image/png',1,'staged',?,?)`,
        )
        .run(now, now),
    ).toThrow();
  });
});
