import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleChat } from "../src/http/chat.js";
import { handleDeletion } from "../src/http/deletion.js";
import {
  type HttpDeps,
  type HttpRequest,
  handleRequest,
  type ProjectContext,
} from "../src/http/handler.js";
import { handleInternalMcp } from "../src/http/internal-mcp.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { ensureMasterAgent } from "../src/master/bootstrap.js";
import { MASTER_APP_ID, MASTER_APP_KEY, MASTER_PROJECT_ID } from "../src/master/constants.js";
import { mintAgentToken } from "../src/mcp/agent-tokens.js";
import { SkillService } from "../src/skills/index.js";
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
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  deps: HttpDeps;
  token: string;
  workspace: string;
}

function fixture(options: { withOperator: boolean }): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-master-http-"));
  dirs.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  if (options.withOperator) {
    const projectRoot = path.join(workspace, "atlas");
    mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, ".hanse", "project.yaml"),
      "id: p\nname: Atlas\nbase_branch: main\napps: []\n",
    );
    db.prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Atlas','main',?,?,?)",
    ).run(projectRoot, now, now);
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
    ).run(now);
  }
  ensureMasterAgent(db, workspace);
  const getProjects = (): ProjectContext[] => {
    const rows = db.prepare("SELECT id, name, root_path, deleting FROM projects").all() as Array<{
      id: string;
      name: string;
      root_path: string;
      deleting: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      workspaceRoot: workspace,
      deleting: row.deleting === 1,
      service: new CoordinatorService(db, row.id),
    }));
  };
  const token = createPrincipal(db, { kind: "human", name: "alice" }).token;
  return {
    token,
    workspace,
    deps: {
      db,
      workspaceRoot: workspace,
      getProjects,
      git: new GitService({ workspaceRoot: workspace }),
      skills: new SkillService({ db }),
    },
  };
}

function request(
  method: string,
  pathValue: string,
  token: string,
  query: Record<string, string> = {},
): HttpRequest {
  return {
    method,
    path: pathValue,
    query,
    headers: { authorization: `Bearer ${token}`, accept: "text/html" },
  };
}

describe("master HTTP surface", () => {
  it("hides the master from operator lists while keeping the navigation entry", () => {
    const value = fixture({ withOperator: true });
    const overview = handleRequest(value.deps, request("GET", "/", value.token));
    expect(overview.status).toBe(200);
    expect(overview.body).toContain("Atlas");
    expect(overview.body).not.toContain("Hanse master");
    expect(overview.body).toContain("/chat?app=master&amp;project=hanse-master");

    const projects = handleRequest(value.deps, request("GET", "/projects", value.token));
    expect(projects.status).toBe(200);
    expect(projects.body).not.toContain(`/projects/${MASTER_PROJECT_ID}`);

    const api = handleRequest(value.deps, request("GET", "/api/projects", value.token));
    expect(api.status).toBe(200);
    const body = JSON.parse(api.body) as { projects: Array<{ id: string }> };
    expect(body.projects.map((project) => project.id)).toEqual(["p"]);
  });

  it("prefers an operator application for /chat and falls back to the master", async () => {
    const withOperator = fixture({ withOperator: true });
    const preferred = await handleChat(
      withOperator.deps,
      request("GET", "/chat", withOperator.token),
    );
    expect(preferred.status).toBe(303);
    expect(preferred.headers?.location).toContain("app=a");
    expect(preferred.headers?.location).not.toContain("master");

    const masterOnly = fixture({ withOperator: false });
    const fallback = await handleChat(masterOnly.deps, request("GET", "/chat", masterOnly.token));
    expect(fallback.status).toBe(303);
    expect(fallback.headers?.location).toContain(`app=${MASTER_APP_KEY}`);
    expect(fallback.headers?.location).toContain(`project=${MASTER_PROJECT_ID}`);
  });

  it("renders direct master pages without destructive or git controls", async () => {
    const value = fixture({ withOperator: true });
    const project = handleRequest(
      value.deps,
      request("GET", `/projects/${MASTER_PROJECT_ID}`, value.token),
    );
    expect(project.status).toBe(200);
    expect(project.body).toContain("Built-in assistant");
    expect(project.body).not.toContain("Delete project");
    expect(project.body).not.toContain("New handoff");
    expect(project.body).not.toContain("Add app");

    const app = handleRequest(
      value.deps,
      request("GET", `/projects/${MASTER_PROJECT_ID}/apps/${MASTER_APP_KEY}`, value.token),
    );
    expect(app.status).toBe(200);
    expect(app.body).toContain("Master workspace");
    expect(app.body).not.toContain("Delete application");
    expect(app.body).not.toContain("/assets/git.js");

    const chat = await handleChat(
      value.deps,
      request("GET", "/chat", value.token, {
        app: MASTER_APP_KEY,
        project: MASTER_PROJECT_ID,
      }),
    );
    expect(chat.status).toBe(200);
    expect(chat.body).toContain(MASTER_APP_KEY);
  });

  it("refuses deletion even without a configured deletion service", async () => {
    const value = fixture({ withOperator: true });
    const projectDelete = await handleDeletion(value.deps, {
      ...request("POST", `/api/projects/${MASTER_PROJECT_ID}/delete`, value.token),
      headers: { authorization: `Bearer ${value.token}`, accept: "application/json" },
    });
    expect(projectDelete?.status).toBe(409);
    expect(JSON.parse(projectDelete?.body ?? "{}")).toMatchObject({ code: "master_protected" });

    const appDelete = await handleDeletion(value.deps, {
      ...request(
        "DELETE",
        `/api/projects/${MASTER_PROJECT_ID}/apps/${MASTER_APP_KEY}`,
        value.token,
      ),
      headers: { authorization: `Bearer ${value.token}`, accept: "application/json" },
    });
    expect(appDelete?.status).toBe(409);
    expect(JSON.parse(appDelete?.body ?? "{}")).toMatchObject({ code: "master_protected" });
  });

  it("dispatches master tools only for the master token", async () => {
    const value = fixture({ withOperator: true });
    const masterToken = mintAgentToken(value.deps.db, MASTER_APP_ID);
    const master = await handleInternalMcp(value.deps, {
      method: "POST",
      path: "/internal/mcp",
      headers: { authorization: `Bearer ${masterToken}`, accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(master.status).toBe(200);
    const masterTools = (JSON.parse(master.body) as { result: { tools: Array<{ name: string }> } })
      .result.tools;
    expect(masterTools.map((tool) => tool.name)).toContain("write_file");
    expect(masterTools.map((tool) => tool.name)).toContain("create_skill");
    expect(masterTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_skills",
        "get_skill",
        "update_skill",
        "set_skill_enabled",
        "override_skill",
      ]),
    );
    expect(masterTools.map((tool) => tool.name)).not.toContain("ssh_exec");

    const appToken = mintAgentToken(value.deps.db, "p:a");
    const app = await handleInternalMcp(value.deps, {
      method: "POST",
      path: "/internal/mcp",
      headers: { authorization: `Bearer ${appToken}`, accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "write_file", arguments: { path: "x", content: "y" } },
      }),
    });
    expect(app.status).toBe(200);
    expect(JSON.parse(app.body)).toMatchObject({
      error: { message: expect.stringContaining("Unknown tool") },
    });
  });

  it("accepts a maximum valid skill bundle and rejects an oversized body", async () => {
    const value = fixture({ withOperator: true });
    const masterToken = mintAgentToken(value.deps.db, MASTER_APP_ID);
    const server = createHttpServer(value.deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const url = `http://127.0.0.1:${port}/internal/mcp`;
    const metadata: Record<string, string> = {};
    for (let index = 0; index < 15; index += 1) {
      metadata[`key-${index}`] = "€".repeat(1000);
    }
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_skill",
        arguments: {
          scope: "app",
          project_id: "p",
          app_key: "a",
          name: "max-skill",
          description: "€".repeat(1024),
          content: "\u0001".repeat(48000),
          metadata,
          references: Array.from({ length: 20 }, (_, index) => ({
            path: `references/r${index}.md`,
            content: "€".repeat(9600),
          })),
        },
      },
    };
    const body = JSON.stringify(payload);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(1024 * 1024);
    try {
      const accepted = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${masterToken}`,
          "content-type": "application/json",
        },
        body,
      });
      expect(accepted.status).toBe(200);
      const acceptedBody = (await accepted.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      expect(JSON.parse(acceptedBody.result?.content?.[0]?.text ?? "{}")).toMatchObject({
        ok: true,
        skill: { name: "max-skill", scope: "app" },
      });

      const oversized = JSON.stringify({ ...payload, padding: "x".repeat(1024 * 1024) });
      const rejected = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${masterToken}`,
          "content-type": "application/json",
        },
        body: oversized,
      });
      expect(rejected.status).toBe(413);
      expect(JSON.parse(await rejected.text())).toMatchObject({ code: "payload_too_large" });
      const count = value.deps.db.prepare("SELECT COUNT(*) AS count FROM skills").get() as {
        count: number;
      };
      expect(count.count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
