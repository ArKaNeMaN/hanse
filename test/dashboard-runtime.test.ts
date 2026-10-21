import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { buildSite, type DashboardDeps, renderOverview } from "../src/http/dashboard.js";
import { type RuntimeState, runtimePill } from "../src/http/ui.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

const now = "2026-10-21T00:00:00.000Z";

function fixture(): DashboardDeps {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp/p',?,?)",
  ).run(now, now);
  const states: Array<[string, string]> = [
    ["starting", "starting"],
    ["running", "running"],
    ["stopped", "stopped"],
    ["error", "error"],
    ["legacy", "failed"],
    ["unknown", "bogus"],
  ];
  for (const [appKey, state] of states) {
    const id = `p:${appKey}`;
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
    ).run(id, appKey, `apps/${appKey}`, now);
    db.prepare(
      "INSERT INTO instances (id, app_id, state, runtime_state, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, id, state, state, now);
  }
  return {
    db,
    getProjects: () => [
      {
        id: "p",
        name: "P",
        rootPath: "/tmp/p",
        workspaceRoot: "/tmp",
        service: new CoordinatorService(db, "p"),
      },
    ],
  };
}

describe("runtime vocabulary and counts", () => {
  it("maps the four states, normalizes legacy failed, and counts each state", () => {
    const site = buildSite(fixture());

    expect(site.runtime.get("p:starting")).toBe("starting");
    expect(site.runtime.get("p:running")).toBe("running");
    expect(site.runtime.get("p:stopped")).toBe("stopped");
    expect(site.runtime.get("p:error")).toBe("error");
    expect(site.runtime.get("p:legacy")).toBe("error");
    expect(site.runtime.get("p:unknown")).toBe("stopped");

    expect(site.startingCount).toBe(1);
    expect(site.runningCount).toBe(1);
    expect(site.stoppedCount).toBe(2);
    expect(site.errorCount).toBe(2);
  });

  it("renders one runtime row per state", () => {
    const page = renderOverview(buildSite(fixture()), { operatorName: "op" });

    expect(page).toContain('<span class="status" data-state="dispatching">');
    expect(page).toContain("Starting</span>");
    expect(page).toContain('<span class="status" data-state="in_progress">');
    expect(page).toContain("Running</span>");
    expect(page).toContain('<span class="status" data-state="queued">');
    expect(page).toContain("Stopped</span>");
    expect(page).toContain('<span class="status" data-state="failed">');
    expect(page).toContain("Error</span>");
    expect(page).not.toContain("Failed</span>");
  });

  it("maps every runtime state to its label, pill state, and glyph", () => {
    const expected: Array<[RuntimeState, string, string]> = [
      ["starting", "dispatching", "Starting"],
      ["running", "in_progress", "Running"],
      ["stopped", "queued", "Stopped"],
      ["error", "failed", "Error"],
    ];
    for (const [state, pillState, label] of expected) {
      const pill = runtimePill(state);
      expect(pill).toContain(`data-state="${pillState}"`);
      expect(pill).toContain(`${label}</span>`);
    }
  });
});
