import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentMediaAdmission } from "../src/agent-media/active.js";
import {
  agentMediaFinalPath,
  agentMediaTempPath,
  ensureAgentMediaRoot,
} from "../src/agent-media/paths.js";
import { reconcileAgentMedia } from "../src/agent-media/reconcile.js";
import { AgentMediaService } from "../src/agent-media/service.js";
import { insertStagedAgentMedia, readAgentMedia } from "../src/agent-media/store.js";
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

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(600, 2),
  ]);
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-agent-media-cleanup-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  const appRoot = appStateRoot(path.join(dir, "agents"), "p", "a");
  mkdirSync(appRoot, { recursive: true });
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','app','AGENTS.md',?)",
  ).run(now);
  return { db, appRoot, agentsHome: path.join(dir, "agents") };
}

describe("agent media reconcile", () => {
  it("keeps a valid staged file, removes temp-only reservations, and marks missing attachments", async () => {
    const { db, appRoot, agentsHome } = fixture();
    const appDir = path.join(agentsHome, "..", "workspace");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "ui.png"), png());
    const service = new AgentMediaService(db, {
      appId: "p:a",
      projectId: "p",
      appKey: "a",
      appDir,
      appRoot,
      workspaceRoot: appDir,
      pathMode: "supervisor",
    });
    const staged = await service.showImage({ path: "ui.png" });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    ensureAgentMediaRoot(appRoot);
    const tempId = "amed_temp_123456";
    insertStagedAgentMedia(db, {
      id: tempId,
      appId: "p:a",
      originalName: "temp.png",
      storedName: `${tempId}-temp.png`,
      relPath: `agent-media/${tempId}-temp.png`,
      mime: "image/png",
      size: 3,
      caption: null,
      now: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    writeFileSync(agentMediaTempPath(appRoot, tempId), png());

    const attached = await service.showImage({ path: "ui.png" });
    if (!attached.ok) return;
    service.attach("p:a", attached.id, "ses_1", "msg_1", "prt_1");
    const attachedRow = readAgentMedia(db, "p:a", attached.id);
    if (attachedRow !== null) {
      rmSync(agentMediaFinalPath(appRoot, attachedRow.storedName), { force: true });
    }

    const result = reconcileAgentMedia({ db, agentsHome, startup: false, now: Date.now() });
    expect(readAgentMedia(db, "p:a", staged.id)?.state).toBe("staged");
    expect(readAgentMedia(db, "p:a", tempId)).toBeUndefined();
    expect(readAgentMedia(db, "p:a", attached.id)?.state).toBe("missing");
    expect(result.repaired).toBe(1);
    expect(result.missing).toBe(1);
  });

  it("removes old orphan files", () => {
    const { db, appRoot, agentsHome } = fixture();
    ensureAgentMediaRoot(appRoot);
    const orphan = path.join(appRoot, "agent-media", "orphan.png");
    writeFileSync(orphan, png());
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(orphan, old, old);
    const result = reconcileAgentMedia({ db, agentsHome, startup: false, now: Date.now() });
    expect(result.orphans).toBe(1);
    expect(() => readAgentMedia(db, "p:a", "orphan")).not.toThrow();
  });
});
