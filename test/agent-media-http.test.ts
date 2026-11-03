import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMediaService } from "../src/agent-media/service.js";
import { readAgentMedia } from "../src/agent-media/store.js";
import { appStateRoot } from "../src/attachments/paths.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
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
    Buffer.alloc(600, 9),
  ]);
}

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-agent-media-http-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  const workspaceRoot = path.join(dir, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  const appDir = path.join(projectRoot, "app");
  mkdirSync(appDir, { recursive: true });
  const agentsHome = path.join(dir, "agents");
  const appRoot = appStateRoot(agentsHome, "p", "a");
  mkdirSync(path.join(appRoot, "tmp"), { recursive: true });
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','app','AGENTS.md',?)",
  ).run(now);
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const deps: HttpDeps = {
    db,
    workspaceRoot,
    git: new GitService({ workspaceRoot }),
    agentsHome,
    getProjects: () => [
      {
        id: "p",
        name: "P",
        rootPath: projectRoot,
        workspaceRoot,
        deleting: false,
        service: new CoordinatorService(db, "p"),
      },
    ],
    manager: { attachmentsPathMode: () => "container" } as unknown as InstanceManager,
  };
  const service = new AgentMediaService(db, {
    appId: "p:a",
    projectId: "p",
    appKey: "a",
    appDir,
    appRoot,
    workspaceRoot,
    pathMode: "supervisor",
  });
  writeFileSync(path.join(appDir, "ui.png"), png());
  const result = await service.showImage({ path: "ui.png" });
  if (!result.ok) throw new Error("fixture image failed");
  service.attach("p:a", result.id, "ses_1", "msg_1", "prt_1");
  return { db, deps, token, id: result.id, appRoot };
}

async function listen(deps: HttpDeps) {
  const server = createHttpServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("agent media download route", () => {
  it("serves an attached image to a human bearer", async () => {
    const { deps, token, id } = await fixture();
    const base = await listen(deps);
    const response = await fetch(
      `${base}/api/apps/a/agent-media/${encodeURIComponent(id)}?project=p`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png());
  });

  it("rejects an unauthenticated request and an unknown image", async () => {
    const { deps, token, id } = await fixture();
    const base = await listen(deps);
    const unauth = await fetch(`${base}/api/apps/a/agent-media/${id}?project=p`);
    expect(unauth.status).toBe(401);
    const missing = await fetch(`${base}/api/apps/a/agent-media/amed_missing?project=p`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });

  it("marks a missing file and returns 404", async () => {
    const { db, deps, token, id, appRoot } = await fixture();
    const row = readAgentMedia(db, "p:a", id);
    expect(row).not.toBeNull();
    if (row === null) return;
    rmSync(path.join(appRoot, "agent-media", row.storedName), { force: true });
    const base = await listen(deps);
    const response = await fetch(`${base}/api/apps/a/agent-media/${id}?project=p`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    expect(readAgentMedia(db, "p:a", id)?.state).toBe("missing");
  });
});
