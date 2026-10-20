import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { mintAgentToken, revokeAgentToken } from "../src/mcp/agent-tokens.js";
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

function deps(f: Fixture): HttpDeps {
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

  it("runs a tool with a valid per-app token and scopes it to the token project", () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const response = handleRequest(
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

  it("binds request_sibling_change to the token app, ignoring a client-supplied from", () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const response = handleRequest(
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

  it("cannot act on another project through the token project's service", () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const response = handleRequest(
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

  it("rejects missing, invalid, and revoked tokens with 401", () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");
    const payload = { jsonrpc: "2.0", id: 4, method: "tools/list" };

    expect(handleRequest(deps(f), rpc(undefined, payload)).status).toBe(401);
    expect(handleRequest(deps(f), rpc("not-a-token", payload)).status).toBe(401);

    revokeAgentToken(f.db, "p:a");
    expect(handleRequest(deps(f), rpc(token, payload)).status).toBe(401);
  });

  it("returns 204 for notifications and 400 for a parse error", () => {
    const f = fixture();
    const token = mintAgentToken(f.db, "p:a");

    const notification = handleRequest(
      deps(f),
      rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notification.status).toBe(204);
    expect(notification.body).toBe("");

    const parseError = handleRequest(deps(f), rpc(token, "{not json"));
    expect(parseError.status).toBe(400);
    expect((JSON.parse(parseError.body) as { error?: { code?: number } }).error?.code).toBe(-32700);
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
