import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoordinatorService } from "../src/coordinator/service.js";
import type { AgentTokenIdentity } from "../src/mcp/agent-tokens.js";
import { handleRpcAsync, SHOW_IMAGE_TOOL } from "../src/mcp/ssh-protocol.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
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
    Buffer.alloc(600, 3),
  ]);
}

function fixture(): {
  db: SqliteDatabase;
  agentsHome: string;
  appDir: string;
  getProjects: () => unknown[];
  manager: InstanceManager;
  agent: AgentTokenIdentity;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-agent-media-mcp-"));
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
  mkdirSync(path.join(agentsHome, "p", "a", "tmp"), { recursive: true });
  const app = {
    id: "p:a",
    projectId: "p",
    appKey: "a",
    path: "app",
    kind: "app",
    contract: "AGENTS.md",
    deleting: false,
    imageStatus: "missing",
    imageRef: null,
    imageHash: null,
    imageBaseDigest: null,
    imageBuiltAt: null,
    imageError: null,
    imageBaseRef: null,
    imageBaseKind: null,
    imageHashVersion: 1,
    imageBuildId: null,
    imageBuildRef: null,
    imageBuildStartedAt: null,
    imageBuildRejectedRef: null,
    buildDockerfile: null,
    buildConfigured: false,
    buildArgs: {},
    buildSpecHash: null,
  };
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','app','AGENTS.md',?)",
  ).run(now);
  const project = {
    id: "p",
    name: "P",
    rootPath: projectRoot,
    workspaceRoot,
    service: { listApps: () => [app] },
  };
  return {
    db,
    agentsHome,
    appDir,
    getProjects: () => [project],
    manager: { attachmentsPathMode: () => "container" } as unknown as InstanceManager,
    agent: { appId: "p:a", projectId: "p", appKey: "a" },
  };
}

function call(
  options: Parameters<typeof handleRpcAsync>[4],
  name: string,
  args: Record<string, unknown> = {},
) {
  return handleRpcAsync(
    {} as CoordinatorService,
    undefined,
    options?.agent ?? ({ appId: "p:a", projectId: "p", appKey: "a" } as AgentTokenIdentity),
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    options,
  );
}

describe("show_image MCP tool", () => {
  it("is listed only when the media store and manager are configured", async () => {
    const { db, agentsHome, getProjects, manager } = fixture();
    const listed = await handleRpcAsync(
      {} as CoordinatorService,
      undefined,
      { appId: "p:a", projectId: "p", appKey: "a" },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { db, agentsHome, getProjects, manager },
    );
    expect(JSON.stringify(listed)).toContain(SHOW_IMAGE_TOOL.name);
    const omitted = await handleRpcAsync(
      {} as CoordinatorService,
      undefined,
      { appId: "p:a", projectId: "p", appKey: "a" },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { db },
    );
    expect(JSON.stringify(omitted)).not.toContain('"show_image"');
  });

  it("returns a stable failure without a configured store", async () => {
    const result = await call({}, "show_image", { path: "ui.png" });
    expect(JSON.stringify(result)).toContain("image_unavailable");
  });

  it("publishes an image through the MCP call", async () => {
    const { db, agentsHome, appDir, getProjects, manager, agent } = fixture();
    writeFileSync(path.join(appDir, "ui.png"), png());
    const result = await call({ db, agentsHome, getProjects, manager, agent }, "show_image", {
      path: "ui.png",
      caption: "Settings",
    });
    const payload = result?.result as { content: Array<{ text?: string }> } | undefined;
    const text = payload?.content[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ ok: true, name: "ui.png", mime: "image/png" });
  });
});
