import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleChat } from "../src/http/chat.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
}

function addProject(
  db: SqliteDatabase,
  id: string,
  name: string,
  apps: Array<{ key: string; path: string }>,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?,?,'main',?,?,?)",
  ).run(id, name, `/tmp/${id}`, now, now);
  for (const app of apps) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?,?,?,?, 'AGENTS.md', ?)",
    ).run(`${id}:${app.key}`, id, app.key, app.path, now);
  }
}

function fixture(projects = true): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-chat-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  if (projects) {
    addProject(db, "p1", "Alpha", [
      { key: "storefront", path: "apps/storefront" },
      { key: "api", path: "apps/api" },
    ]);
    addProject(db, "p2", "Beta", [{ key: "storefront", path: "apps/storefront" }]);
  }
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    getProjects: () =>
      (
        db.prepare("SELECT id, name, root_path FROM projects ORDER BY rowid").all() as Array<{
          id: string;
          name: string;
          root_path: string;
        }>
      ).map((row) => ({
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        service: new CoordinatorService(db, row.id),
      })),
  };
  return { db, deps, token };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/chat", headers: {}, query: {}, ...overrides };
}

interface UpstreamCall {
  method: string;
  url: string;
  body: string;
}

async function fakeOpencode(
  status = 200,
  responseBody = "true",
): Promise<{ endpoint: string; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      calls.push({
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(responseBody);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}`, calls };
}

function useUpstream(deps: HttpDeps, endpoint: string): void {
  deps.manager = {
    ensure: async () => endpoint,
  } as unknown as InstanceManager;
}

describe("chat page", () => {
  it("redirects unauthenticated browsers to login with next", async () => {
    const f = fixture();
    const response = await handleChat(
      f.deps,
      request({ query: { app: "storefront", project: "p1" } }),
    );
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe(
      "/login?next=%2Fchat%3Fapp%3Dstorefront%26project%3Dp1",
    );
  });

  it("redirects an agent principal to login", async () => {
    const f = fixture();
    const { token } = createPrincipal(f.db, { kind: "agent", name: "bot" });
    const response = await handleChat(
      f.deps,
      request({ query: { app: "storefront" }, headers: auth(token) }),
    );
    expect(response.status).toBe(303);
  });

  it("renders the chat workspace inside the shared shell", async () => {
    const f = fixture();
    const response = await handleChat(
      f.deps,
      request({
        query: { app: "storefront", project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain('class="page page--chat"');
    expect(response.body).toContain('class="page__body page__body--chat"');
    expect(response.body).toContain('class="chat-shell chat-shell--workspace"');
    expect(response.body).toContain('data-app-key="storefront"');
    expect(response.body).toContain('data-project-id="p1"');
    expect(response.body).toContain('id="chat-composer"');
    expect(response.body).toContain('id="chat-context"');
    expect(response.body).toContain("data-chat-context-toggle");
    expect(response.body).toContain("/assets/chat.js");
    expect(response.body).toContain('<optgroup label="Alpha">');
    expect(response.body).toContain("Message storefront agent");
    expect(response.body).toContain('href="/projects/p1/apps/storefront"');
    expect(response.body).toContain(">Application</a>");
    expect(response.body).toContain(
      'class="policy-warning" id="chat-policy-warning" role="status"',
    );
    expect(response.body).toContain('class="prompt-dock" id="chat-prompt-dock"');
    expect(response.body).toContain('id="chat-input-needed"');
    expect(response.body).toContain('id="chat-input-needed-count"');
    expect(response.body).toContain('id="chat-policy-chip"');
    expect(response.body).toContain('id="chat-waiting"');
    expect(response.body).toContain('id="chat-plan-chip"');
    expect(response.body).toContain('id="chat-plan-section"');
    expect(response.body).toContain('id="context-plan-title"');
    expect(response.body).toContain('id="chat-plan-list"');
    expect(response.body).toContain('id="chat-saved-section"');
    expect(response.body).toContain('id="chat-saved-list"');
    expect(response.body).toContain('id="chat-announcer"');
    expect(response.body).toContain('aria-live="polite"');
    expect(response.body).toContain('id="chat-queue"');
    expect(response.body).toContain('id="chat-composer-hint-text"');
    expect(response.body).not.toContain('class="page-header"');
    const application = response.body.indexOf('id="context-app-title"');
    const plan = response.body.indexOf('id="context-plan-title"');
    const saved = response.body.indexOf('id="context-saved-title"');
    const handoffs = response.body.indexOf('id="context-handoffs-title"');
    expect(application).toBeLessThan(plan);
    expect(plan).toBeLessThan(saved);
    expect(saved).toBeLessThan(handoffs);
  });

  it("redirects a missing app to the canonical chat URL", async () => {
    const f = fixture();
    const response = await handleChat(f.deps, request({ headers: auth(f.token) }));
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/chat?app=api&project=p1");
  });

  it("returns a styled 404 for an unknown app", async () => {
    const f = fixture();
    const response = await handleChat(
      f.deps,
      request({ query: { app: "nope" }, headers: auth(f.token) }),
    );
    expect(response.status).toBe(404);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("Page not found");
  });

  it("renders a shell empty state when no apps exist", async () => {
    const f = fixture(false);
    const response = await handleChat(f.deps, request({ headers: auth(f.token) }));
    expect(response.status).toBe(200);
    expect(response.body).toContain("No applications yet");
    expect(response.body).toContain('href="/projects"');
    expect(response.body).toContain('class="app-shell"');
  });

  it("disambiguates duplicate app keys with the project query", async () => {
    const f = fixture();
    const first = await handleChat(
      f.deps,
      request({ query: { app: "storefront" }, headers: auth(f.token) }),
    );
    expect(first.body).toContain('data-project-id="p1"');

    const second = await handleChat(
      f.deps,
      request({ query: { app: "storefront", project: "p2" }, headers: auth(f.token) }),
    );
    expect(second.status).toBe(200);
    expect(second.body).toContain('data-project-id="p2"');
    expect(second.body).toContain('data-app-key="storefront"');
  });

  it("adds the project id to dashboard chat links", () => {
    const f = fixture();
    const response = handleRequest(f.deps, {
      method: "GET",
      path: "/projects/p1",
      headers: auth(f.token),
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('href="/chat?app=storefront&amp;project=p1"');
  });

  it("serves chat.js from the asset allowlist", () => {
    const f = fixture();
    const response = handleRequest(f.deps, {
      method: "GET",
      path: "/assets/chat.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/javascript");
    expect(response.body).toContain('getElementById("chat-shell")');
    expect(response.body).toContain("new EventSource(eventsUrl())");
    expect(response.body).toContain("function hasActiveSend()");
    expect(response.body).toContain("chat-prompt-dock");
  });

  it("deletes a session through opencode for a human principal", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(
      f.deps,
      request({
        method: "DELETE",
        path: "/api/apps/storefront/sessions/ses_1",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ deleted: true });
    expect(upstream.calls).toEqual([{ method: "DELETE", url: "/session/ses_1", body: "" }]);
  });

  it("forbids an agent principal from deleting a session", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    let started = false;
    f.deps.manager = {
      ensure: async () => {
        started = true;
        return upstream.endpoint;
      },
    } as unknown as InstanceManager;
    const { token } = createPrincipal(f.db, { kind: "agent", name: "bot" });

    const response = await handleChat(
      f.deps,
      request({
        method: "DELETE",
        path: "/api/apps/storefront/sessions/ses_1",
        query: { project: "p1" },
        headers: auth(token),
      }),
    );

    expect(response.status).toBe(403);
    expect(started).toBe(false);
    expect(upstream.calls).toEqual([]);
  });

  it("reports an opencode deletion failure as 502", async () => {
    const f = fixture();
    const upstream = await fakeOpencode(500, '{"error":"boom"}');
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(
      f.deps,
      request({
        method: "DELETE",
        path: "/api/apps/storefront/sessions/ses_1",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body).error).toContain("opencode DELETE /session/ses_1");
  });
});
