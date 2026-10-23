import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transitionHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import { setHandoffPolicy } from "../src/coordinator/policy.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { buildSite, renderProject } from "../src/http/dashboard.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): { db: SqliteDatabase; dir: string; service: CoordinatorService } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-hu-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  for (const key of ["a", "b"]) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
    ).run(`p:${key}`, key, `apps/${key}`, now);
  }
  return { db, dir, service: new CoordinatorService(db, "p") };
}

describe("handoff UI", () => {
  it("renders the policy card and the parked-reply relaunch action", () => {
    const { db, dir, service } = fixture();
    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "approve",
      replyMode: "approve",
    });
    const { handoffId } = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "need X",
      spec: "do X",
    });
    transitionHandoff(db, handoffId, "dispatching");
    transitionHandoff(db, handoffId, "in_progress");
    transitionHandoff(db, handoffId, "delivered", { result: "done", outcome: "completed" });
    updateHandoff(db, handoffId, {
      sourceSessionId: "ses_source",
      sourceSessionTitle: "Source session",
      targetSessionId: "ses_target",
      targetSessionTitle: "Target session",
      sourceSessionDeletedAt: new Date().toISOString(),
      replyState: "waiting_operator",
      replyError: "source session no longer exists",
      replyDeliveredSessionId: null,
    });

    const site = buildSite({
      db,
      getProjects: () => [{ id: "p", name: "P", rootPath: dir, workspaceRoot: dir, service }],
    });
    const html = renderProject(site, "p", { operatorName: "operator" });

    expect(html).toContain("Handoff policy");
    expect(html).toContain("Save rule");
    expect(html).toContain("approve");
    expect(html).toContain("Reply waiting");
    expect(html).toContain("Start in a new session");
    expect(html).toContain("source session no longer exists");
    db.close();
  });
});
