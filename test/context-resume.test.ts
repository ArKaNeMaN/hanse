import { describe, expect, it } from "vitest";
import {
  listResumableApps,
  MAX_RESUMABLE_CONTEXT_APPS,
  type ResumableApp,
  resumeContextMonitors,
} from "../src/cli/commands.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

function database(): SqliteDatabase {
  const db = openDatabase(":memory:");
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at,deleting) VALUES ('p','P','main','/tmp',?,?,0)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at,deleting) VALUES ('gone','Gone','main','/tmp',?,?,1)",
  ).run(now, now);
  return db;
}

function insertApp(
  db: SqliteDatabase,
  id: string,
  projectId: string,
  appKey: string,
  deleting: number,
): void {
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at,deleting) VALUES (?,?,?,?,?,?,?)",
  ).run(id, projectId, appKey, `apps/${appKey}`, "AGENTS.md", new Date().toISOString(), deleting);
}

describe("resumeContextMonitors", () => {
  it("calls the manager once and resolves when it succeeds", async () => {
    const calls: ResumableApp[][] = [];
    const apps = [{ id: "p:web", projectId: "p", appKey: "web" }];

    await expect(
      resumeContextMonitors(
        {
          resumeRunning: async (list) => {
            calls.push(list);
          },
        },
        apps,
      ),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([apps]);
  });

  it("swallows a manager failure without leaking the error", async () => {
    await expect(
      resumeContextMonitors(
        {
          resumeRunning: async () => {
            throw new Error("SECRET_PROVIDER_BODY");
          },
        },
        [],
      ),
    ).resolves.toBeUndefined();
  });
});

describe("listResumableApps", () => {
  it("excludes deleting apps and projects", () => {
    const db = database();
    try {
      insertApp(db, "p:web", "p", "web", 0);
      insertApp(db, "p:gone", "p", "gone", 1);
      insertApp(db, "gone:web", "gone", "web", 0);

      expect(listResumableApps(db)).toEqual([{ id: "p:web", projectId: "p", appKey: "web" }]);
    } finally {
      db.close();
    }
  });

  it("caps the list at 200 apps", () => {
    const db = database();
    try {
      const insert = db.prepare(
        "INSERT INTO apps (id,project_id,app_key,path,contract,created_at,deleting) VALUES (?,?,?,?,?,?,0)",
      );
      const now = new Date().toISOString();
      db.transaction(() => {
        for (let index = 0; index < MAX_RESUMABLE_CONTEXT_APPS + 5; index += 1) {
          insert.run(`p:app-${index}`, "p", `app-${index}`, "apps/x", "AGENTS.md", now);
        }
      })();

      const apps = listResumableApps(db);
      expect(apps).toHaveLength(MAX_RESUMABLE_CONTEXT_APPS);
      expect(new Set(apps.map((app) => app.id)).size).toBe(MAX_RESUMABLE_CONTEXT_APPS);
    } finally {
      db.close();
    }
  });
});
