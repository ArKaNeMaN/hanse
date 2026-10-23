import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { handleInternalMcp } from "../src/http/internal-mcp.js";
import { createHttpServer } from "../src/http/server.js";
import { ensureMasterAgent } from "../src/master/bootstrap.js";
import { MASTER_APP_ID } from "../src/master/constants.js";
import { MASTER_TOOLS } from "../src/master/tools.js";
import { mintAgentToken, revokeAgentToken } from "../src/mcp/agent-tokens.js";
import { TOOLS } from "../src/mcp/protocol.js";
import { handleRpcAsync, SSH_TOOLS } from "../src/mcp/ssh-protocol.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { APP_SKILL_TOOLS } from "../src/skills/app-tools.js";
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
  db: SqliteDatabase;
  workspace: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-mcp-http-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(path.join(workspace, "p"), now, now);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('q','Q','main',?,?,?)",
  ).run(path.join(workspace, "q"), now, now);
  for (const [id, project, appKey] of [
    ["p:a", "p", "a"],
    ["p:b", "p", "b"],
    ["q:c", "q", "c"],
  ] as const) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, ?, ?, ?, 'AGENTS.md', ?)",
    ).run(id, project, appKey, `apps/${appKey}`, now);
  }
  return { db, workspace };
}

interface DependencyExtras {
  skills?: SkillService;
  manager?: InstanceManager;
}

function deps(f: Fixture, extras: DependencyExtras = {}): HttpDeps {
  return {
    db: f.db,
    workspaceRoot: f.workspace,
    git: new GitService({ workspaceRoot: f.workspace }),
    getProjects: () => [
      {
        id: "p",
        name: "P",
        rootPath: path.join(f.workspace, "p"),
        workspaceRoot: f.workspace,
        service: new CoordinatorService(f.db, "p"),
      },
    ],
    ...(extras.skills === undefined ? {} : { skills: extras.skills }),
    ...(extras.manager === undefined ? {} : { manager: extras.manager }),
  };
}

function rpc(token: string | undefined, payload: unknown): HttpRequest {
  return {
    method: "POST",
    path: "/internal/mcp",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

function toolResult(response: { body: string }): unknown {
  const rpcResponse = JSON.parse(response.body) as {
    result: { content: { text: string }[] };
  };
  return JSON.parse(rpcResponse.result.content[0]?.text ?? "{}");
}

function toolNames(response: { body: string }): string[] {
  const rpcResponse = JSON.parse(response.body) as {
    result: { tools: Array<{ name: string }> };
  };
  return rpcResponse.result.tools.map((tool) => tool.name);
}

function rpcToolNames(response: unknown): string[] {
  const result = (response as { result?: { tools?: Array<{ name: string }> } }).result;
  return (result?.tools ?? []).map((tool) => tool.name);
}

describe("internal MCP over HTTP", () => {
  it("serves the internal MCP route through the coordinator HTTP server", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");
    const server = createHttpServer(deps(f));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const url = `http://127.0.0.1:${port}/internal/mcp`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    try {
      const ok = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { result?: unknown }).result).toBeDefined();

      const unauthorized = await fetch(url, { method: "POST", body });
      expect(unauthorized.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("runs a tool with a valid per-app token and scopes it to the token project", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const response = await handleInternalMcp(
      deps(f),
      rpc(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_apps", arguments: {} },
      }),
    );

    expect(response.status).toBe(200);
    const apps = toolResult(response) as { apps: { appKey: string; projectId: string }[] };
    expect(apps.apps.map((app) => app.appKey)).toEqual(["a", "b"]);
    expect(apps.apps.every((app) => app.projectId === "p")).toBe(true);
  });

  it("binds request_sibling_change to the token app, ignoring a client-supplied from", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const response = await handleInternalMcp(
      deps(f),
      rpc(token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "request_sibling_change",
          arguments: { from: "b", to: "b", summary: "s", spec: "x" },
        },
      }),
    );

    expect(response.status).toBe(200);
    const row = f.db
      .prepare("SELECT from_app_id AS fromAppId FROM handoffs WHERE summary = 's'")
      .get() as { fromAppId: string } | undefined;
    expect(row?.fromAppId).toBe("p:a");
  });

  it("cannot act on another project through the token project's service", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const response = await handleInternalMcp(
      deps(f),
      rpc(token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "request_sibling_change",
          arguments: { from: "a", to: "c", summary: "s", spec: "x" },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as { error?: unknown }).error).toBeDefined();
    const count = f.db.prepare("SELECT count(*) AS n FROM handoffs").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects missing, invalid, and revoked tokens with 401", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");
    const payload = { jsonrpc: "2.0", id: 4, method: "tools/list" };

    expect((await handleInternalMcp(deps(f), rpc(undefined, payload))).status).toBe(401);
    expect((await handleInternalMcp(deps(f), rpc("not-a-token", payload))).status).toBe(401);

    revokeAgentToken(f.db, "p:a");
    expect((await handleInternalMcp(deps(f), rpc(token, payload))).status).toBe(401);
  });

  it("returns 204 for notifications and 400 for a parse error", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const notification = await handleInternalMcp(
      deps(f),
      rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notification.status).toBe(204);
    expect(notification.body).toBe("");

    const parseError = await handleInternalMcp(deps(f), rpc(token, "{not json"));
    expect(parseError.status).toBe(400);
    expect((JSON.parse(parseError.body) as { error?: { code?: number } }).error?.code).toBe(-32700);
  });

  it("publishes the six app skill schemas exactly as designed", () => {
    expect(APP_SKILL_TOOLS).toEqual([
      {
        name: "create_skill",
        description:
          "Create an enabled skill bundle at this application's own scope. The target is this application; no scope or target arguments are accepted. A same-name skill at this scope is rejected; a same-name skill at a wider scope is shadowed. Creating a skill never restarts the agent; the result reports pendingRestart.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            content: { type: "string" },
            license: { type: ["string", "null"] },
            compatibility: { type: ["string", "null"] },
            metadata: { type: "object", additionalProperties: { type: "string" } },
            references: {
              type: "array",
              items: {
                type: "object",
                properties: { path: { type: "string" }, content: { type: "string" } },
                required: ["path", "content"],
              },
            },
          },
          required: ["name", "description", "content"],
        },
      },
      {
        name: "list_skills",
        description:
          "List the effective skill set and the rows defined at this application's own scope. Returns no skill bodies or reference contents.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_skill",
        description:
          "Read one skill by id when it is effective for this application or belongs to this application's own scope. Disabled, invalid, or shadowed global/project rows are not readable. Returns the body, reference contents, metadata, raw invalid metadata, and stored issues.",
        inputSchema: {
          type: "object",
          properties: { skill_id: { type: "integer", minimum: 1 } },
          required: ["skill_id"],
        },
      },
      {
        name: "update_skill",
        description:
          "Update the description, body, license, compatibility, metadata, or references of a skill owned by this application. Name, scope, target, and enabled are immutable. Global, project, and sibling-application rows are not writable; override a wider source instead.",
        inputSchema: {
          type: "object",
          properties: {
            skill_id: { type: "integer", minimum: 1 },
            description: { type: "string" },
            content: { type: "string" },
            license: { type: ["string", "null"] },
            compatibility: { type: ["string", "null"] },
            metadata: { type: "object", additionalProperties: { type: "string" } },
            references: {
              type: "array",
              items: {
                type: "object",
                properties: { path: { type: "string" }, content: { type: "string" } },
                required: ["path", "content"],
              },
            },
          },
          required: ["skill_id"],
        },
      },
      {
        name: "set_skill_enabled",
        description:
          "Enable or disable one skill owned by this application. A disabled skill is a tombstone, not a deletion; it hides a wider same-name skill for this application.",
        inputSchema: {
          type: "object",
          properties: {
            skill_id: { type: "integer", minimum: 1 },
            enabled: { type: "boolean" },
          },
          required: ["skill_id", "enabled"],
        },
      },
      {
        name: "override_skill",
        description:
          "Copy an enabled skill that is visible in this application's chain (global or this application's project) into this application's own scope. The target is always this application; a source already at this target is rejected as a self-copy. Replacing an existing local row with the same name requires confirm_replace.",
        inputSchema: {
          type: "object",
          properties: {
            source_skill_id: { type: "integer", minimum: 1 },
            enabled: { type: "boolean" },
            confirm_replace: { type: "boolean" },
          },
          required: ["source_skill_id"],
        },
      },
    ]);
  });

  it("advertises app skill tools only with a fully wired skills context", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");
    const skills = new SkillService({ db: f.db });

    const wired = await handleInternalMcp(
      deps(f, { skills }),
      rpc(token, { jsonrpc: "2.0", id: 10, method: "tools/list" }),
    );
    expect(toolNames(wired)).toEqual(
      [...TOOLS, ...SSH_TOOLS, ...APP_SKILL_TOOLS].map((tool) => tool.name),
    );

    const plain = await handleInternalMcp(
      deps(f),
      rpc(token, { jsonrpc: "2.0", id: 11, method: "tools/list" }),
    );
    expect(toolNames(plain)).toEqual([...TOOLS, ...SSH_TOOLS].map((tool) => tool.name));
    expect(toolNames(plain)).not.toContain("create_skill");
  });

  it("omits app skill tools from a direct or manager-only dispatch context", async () => {
    const f = fixture();
    const agent = { appId: "p:a", projectId: "p", appKey: "a" };
    const request = { jsonrpc: "2.0" as const, id: 12, method: "tools/list" };

    const direct = await handleRpcAsync(
      new CoordinatorService(f.db, "p"),
      undefined,
      agent,
      request,
    );
    expect(rpcToolNames(direct)).toEqual([...TOOLS, ...SSH_TOOLS].map((tool) => tool.name));

    const manager = {} as InstanceManager;
    const managerOnly = await handleRpcAsync(
      new CoordinatorService(f.db, "p"),
      undefined,
      agent,
      request,
      { manager },
    );
    expect(rpcToolNames(managerOnly)).toEqual([...TOOLS, ...SSH_TOOLS].map((tool) => tool.name));
  });

  it("returns unavailable for an app skill call when skills are not configured", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const response = await handleInternalMcp(
      deps(f),
      rpc(token, {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "create_skill",
          arguments: { name: "review", description: "Review", content: "Body" },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(toolResult(response)).toEqual({
      ok: false,
      code: "unavailable",
      message: "skills are not configured",
    });
  });

  it("keeps handoff and SSH routing when app skills are wired", async () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");
    const wired = deps(f, { skills: new SkillService({ db: f.db }) });

    const handoff = await handleInternalMcp(
      wired,
      rpc(token, {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "list_apps", arguments: {} },
      }),
    );
    expect((toolResult(handoff) as { apps: unknown[] }).apps).toHaveLength(2);

    const ssh = await handleInternalMcp(
      wired,
      rpc(token, {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: { name: "ssh_exec", arguments: { host_id: "host", command: "true" } },
      }),
    );
    expect(toolResult(ssh)).toEqual({
      ok: false,
      code: "ssh_unavailable",
      message: "SSH is not configured",
    });
  });

  it("wires app skill tools end-to-end through the shared deps instances", async () => {
    const f = fixture();
    mkdirSync(f.workspace, { recursive: true });
    ensureMasterAgent(f.db, f.workspace);
    const skills = new SkillService({ db: f.db });
    const pendingRestarts: string[] = [];
    const manager = {
      pendingRestart: (appId: string) => {
        pendingRestarts.push(appId);
        return { pending: true, reasons: ["settings_changed"] };
      },
    } as unknown as InstanceManager;
    const createSpy = vi.spyOn(skills, "create");

    const appToken = mintAgentToken(f.db, "p:a");
    const response = await handleInternalMcp(
      deps(f, { skills, manager }),
      rpc(appToken, {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "create_skill",
          arguments: { name: "wired", description: "Wired", content: "Wired body" },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(toolResult(response)).toMatchObject({
      ok: true,
      skill: { name: "wired", scope: "app", projectId: "p", appKey: "a" },
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.instances[0]).toBe(skills);
    expect(pendingRestarts).toEqual(["p:a"]);

    const masterToken = mintAgentToken(f.db, MASTER_APP_ID);
    const masterList = await handleInternalMcp(
      deps(f, { skills, manager }),
      rpc(masterToken, { jsonrpc: "2.0", id: 21, method: "tools/list" }),
    );
    expect(masterList.status).toBe(200);
    expect((JSON.parse(masterList.body) as { result: { tools: unknown } }).result.tools).toEqual(
      MASTER_TOOLS,
    );
  });

  it("rejects a per-app token on human-only routes with 403", () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
      body: new URLSearchParams({ name: "escaped" }).toString(),
    });

    expect(response.status).toBe(403);
  });
});
