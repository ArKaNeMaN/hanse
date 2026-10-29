import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHandoff, getHandoff } from "../src/coordinator/handoff.js";
import { setHandoffPolicy } from "../src/coordinator/policy.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
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
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
  workspace: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-projects-spa-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const human = createPrincipal(db, { kind: "human", name: "alice" });
  const deps: HttpDeps = {
    db,
    workspaceRoot: workspace,
    git: new GitService({ workspaceRoot: workspace }),
    getProjects: () => {
      const rows = db
        .prepare("SELECT id, name, root_path AS rootPath, deleting FROM projects ORDER BY name")
        .all() as Array<{ id: string; name: string; rootPath: string; deleting: number }>;
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        rootPath: row.rootPath,
        workspaceRoot: workspace,
        deleting: row.deleting === 1,
        service: new CoordinatorService(db, row.id),
      }));
    },
  };
  return { db, deps, token: human.token, workspace };
}

function seedProject(f: Fixture, id = "p", name = "Project P"): void {
  const now = new Date().toISOString();
  f.db
    .prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?, ?, 'main', ?, ?, ?)",
    )
    .run(id, name, `/workspace/${id}`, now, now);
  for (const key of ["a", "b"]) {
    f.db
      .prepare(
        "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES (?, ?, ?, ?, 'app', 'AGENTS.md', ?)",
      )
      .run(`${id}:${key}`, id, key, `apps/${key}`, now);
  }
}

async function start(f: Fixture): Promise<number> {
  const server = createHttpServer(f.deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  return address.port;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  port: number,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function cookie(token: string): Record<string, string> {
  return { cookie: `hanse_token=${encodeURIComponent(token)}` };
}

function spaHeaders(
  token: string | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-hanse-client": "spa",
    ...(token === undefined ? {} : cookie(token)),
    ...extra,
  };
}

function createProjectRequest(
  port: number,
  name: string,
  headers: Record<string, string>,
  body = form({ name }),
): Promise<RawResponse> {
  return send(port, "/api/projects", { method: "POST", headers, body });
}

interface ProjectResponse {
  ok: boolean;
  project: { id: string; name: string; rootPath: string; directory: string };
}

interface AddAppResponse {
  ok: boolean;
  app: { id: string; projectId: string; appKey: string; path: string; rootPath: string };
}

async function createDemoProject(port: number, token: string): Promise<string> {
  const response = await createProjectRequest(port, "Demo Project", spaHeaders(token));
  const payload = JSON.parse(response.body) as ProjectResponse;
  return payload.project.id;
}

describe("POST /api/projects/:id/apps SPA mutation", () => {
  it("adds an application and returns it as JSON", async () => {
    const f = fixture();
    const port = await start(f);
    const projectId = await createDemoProject(port, f.token);

    const response = await send(port, `/api/projects/${projectId}/apps`, {
      method: "POST",
      headers: spaHeaders(f.token),
      body: form({ name: "api", path: "apps/api", return_to: `/projects/${projectId}` }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    const payload = JSON.parse(response.body) as AddAppResponse;
    expect(payload.ok).toBe(true);
    expect(payload.app).toMatchObject({
      projectId,
      appKey: "api",
      path: "apps/api",
    });
    const row = f.db
      .prepare("SELECT app_key FROM apps WHERE project_id = ? AND app_key = 'api'")
      .get(projectId) as { app_key: string } | undefined;
    expect(row?.app_key).toBe("api");

    const sameOrigin = await send(port, `/api/projects/${projectId}/apps`, {
      method: "POST",
      headers: spaHeaders(f.token, { origin: `http://127.0.0.1:${port}` }),
      body: form({ name: "api2", path: "apps/api2" }),
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("rejects a JSON body, a cross-site origin, and missing auth", async () => {
    const f = fixture();
    const port = await start(f);
    const projectId = await createDemoProject(port, f.token);
    const pathname = `/api/projects/${projectId}/apps`;

    const asJson = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "json" }),
    });
    expect(asJson.status).toBe(415);
    expect(JSON.parse(asJson.body)).toEqual({
      error: "unsupported content type",
      code: "content_type",
    });

    const crossSite = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token, { origin: "http://evil.example" }),
      body: form({ name: "cross-site" }),
    });
    expect(crossSite.status).toBe(403);
    expect(JSON.parse(crossSite.body)).toEqual({
      error: "cross-site request rejected",
      code: "origin",
    });

    const anonymous = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(undefined),
      body: form({ name: "anonymous" }),
    });
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body)).toEqual({ error: "sign in required" });

    const rows = f.db
      .prepare("SELECT app_key FROM apps WHERE project_id = ?")
      .all(projectId) as Array<{ app_key: string }>;
    expect(rows.map((row) => row.app_key)).not.toContain("json");
    expect(rows.map((row) => row.app_key)).not.toContain("cross-site");
    expect(rows.map((row) => row.app_key)).not.toContain("anonymous");
  });

  it("maps a validation error and keeps the legacy 303 path", async () => {
    const f = fixture();
    const port = await start(f);
    const projectId = await createDemoProject(port, f.token);
    const pathname = `/api/projects/${projectId}/apps`;

    const empty = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token),
      body: form({ name: "   " }),
    });
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.body)).toEqual({ error: "Application name is required." });

    const escaping = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token),
      body: form({ name: "evil", path: "../../evil" }),
    });
    expect(escaping.status).toBe(400);
    expect(JSON.parse(escaping.body)).toMatchObject({ code: "INVALID_APP_PATH" });

    const browser = await send(port, pathname, {
      method: "POST",
      headers: { ...cookie(f.token), accept: "text/html" },
      body: form({ name: "legacy", path: "apps/legacy", return_to: `/projects/${projectId}` }),
    });
    expect(browser.status).toBe(303);
    expect(browser.headers.location).toContain(`/projects/${projectId}`);
    expect(browser.headers.location).toContain("notice=Application+added.");

    const api = await send(port, pathname, {
      method: "POST",
      headers: { ...cookie(f.token), accept: "application/json" },
      body: form({ name: "api-legacy", path: "apps/api-legacy" }),
    });
    expect(api.status).toBe(303);
    expect(api.headers.location).toBe("/");
  });
});

describe("POST /api/projects SPA mutation", () => {
  it("creates a project from a form body and returns the project without a Location", async () => {
    const f = fixture();
    const port = await start(f);
    const response = await createProjectRequest(port, "New Project", spaHeaders(f.token));

    expect(response.status).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    const payload = JSON.parse(response.body) as ProjectResponse;
    expect(payload.ok).toBe(true);
    expect(payload.project).toMatchObject({
      name: "New Project",
      directory: "new-project",
    });
    expect(payload.project.id.length).toBeGreaterThan(0);

    const row = f.db.prepare("SELECT name FROM projects WHERE id = ?").get(payload.project.id) as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("New Project");

    const list = await send(port, "/api/ui/projects", { headers: cookie(f.token) });
    expect(list.status).toBe(200);
    const props = JSON.parse(list.body) as { rows: Array<{ id: string; name: string }> };
    expect(props.rows.map((row) => row.id)).toContain(payload.project.id);
    expect(props.rows.find((row) => row.id === payload.project.id)?.name).toBe("New Project");
  });

  it("accepts a Content-Type with parameters and rejects every other media type", async () => {
    const f = fixture();
    const port = await start(f);
    const withCharset = await createProjectRequest(
      port,
      "Charset Project",
      spaHeaders(f.token, { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }),
    );
    expect(withCharset.status).toBe(200);

    const asJson = await createProjectRequest(
      port,
      "JSON Project",
      spaHeaders(f.token, { "content-type": "application/json" }),
      JSON.stringify({ name: "JSON Project" }),
    );
    expect(asJson.status).toBe(415);
    expect(JSON.parse(asJson.body)).toEqual({
      error: "unsupported content type",
      code: "content_type",
    });
    expect(asJson.headers.location).toBeUndefined();
  });

  it("allows an absent or same-origin Origin and rejects cross-site or malformed origins", async () => {
    const f = fixture();
    const port = await start(f);
    const sameOrigin = `http://127.0.0.1:${port}`;

    const absent = await createProjectRequest(port, "Absent Origin", spaHeaders(f.token));
    expect(absent.status).toBe(200);

    const matching = await createProjectRequest(
      port,
      "Matching Origin",
      spaHeaders(f.token, { origin: sameOrigin }),
    );
    expect(matching.status).toBe(200);

    for (const origin of ["http://evil.example", "null", "not a url"]) {
      const rejected = await createProjectRequest(
        port,
        "Rejected Origin",
        spaHeaders(f.token, { origin }),
      );
      expect(rejected.status, origin).toBe(403);
      expect(JSON.parse(rejected.body), origin).toEqual({
        error: "cross-site request rejected",
        code: "origin",
      });
    }

    const rows = f.db
      .prepare("SELECT name FROM projects WHERE name = 'Rejected Origin'")
      .all() as Array<{ name: string }>;
    expect(rows).toHaveLength(0);
  });

  it("returns a JSON 401 without credentials and accepts a human bearer token", async () => {
    const f = fixture();
    const port = await start(f);

    const anonymous = await createProjectRequest(port, "Anonymous", spaHeaders(undefined));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.location).toBeUndefined();
    expect(JSON.parse(anonymous.body)).toEqual({ error: "sign in required" });

    const bearer = await createProjectRequest(
      port,
      "Bearer Project",
      spaHeaders(undefined, { authorization: `Bearer ${f.token}` }),
    );
    expect(bearer.status).toBe(200);
  });

  it("rejects an empty name and a duplicate project with the JSON error envelope", async () => {
    const f = fixture();
    const port = await start(f);

    const empty = await createProjectRequest(port, "   ", spaHeaders(f.token));
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.body)).toEqual({ error: "Project name is required." });

    const created = await createProjectRequest(port, "Duplicate", spaHeaders(f.token));
    expect(created.status).toBe(200);

    const duplicate = await createProjectRequest(port, "Duplicate", spaHeaders(f.token));
    expect(duplicate.status).toBe(409);
    expect(JSON.parse(duplicate.body)).toEqual({
      error: "Project already exists.",
      code: "project_exists",
    });
  });

  it("keeps the legacy browser 303 and the legacy non-HTML redirect without the header", async () => {
    const f = fixture();
    const port = await start(f);

    const browser = await createProjectRequest(port, "Browser Project", {
      ...cookie(f.token),
      accept: "text/html",
    });
    expect(browser.status).toBe(303);
    expect(browser.headers.location).toMatch(/^\/projects\/[^?]+\?notice=Project\+created\./);

    const api = await createProjectRequest(port, "API Project", {
      ...cookie(f.token),
      accept: "application/json",
    });
    expect(api.status).toBe(303);
    expect(api.headers.location).toBe("/");

    const browserError = await createProjectRequest(port, "   ", {
      ...cookie(f.token),
      accept: "text/html",
    });
    expect(browserError.status).toBe(303);
    expect(browserError.headers.location).toContain("notice=Project+name+is+required.");
  });
});

interface HandoffCreateResponse {
  ok: boolean;
  handoffId: string;
  status: string;
  state: string;
  handoff?: { id: string; summary: string; state: string };
}

function handoffForm(overrides: Record<string, string> = {}): string {
  return form({
    project: "p",
    from: "a",
    to: "b",
    summary: "Need the change",
    spec: "Do the change.",
    ...overrides,
  });
}

describe("POST /api/handoffs SPA mutation", () => {
  it("returns queued 201 and awaiting_approval 202 with the handoff row", async () => {
    const f = fixture();
    seedProject(f);
    const port = await start(f);

    const queued = await send(port, "/api/handoffs", {
      method: "POST",
      headers: spaHeaders(f.token),
      body: handoffForm(),
    });
    expect(queued.status).toBe(201);
    expect(queued.headers["cache-control"]).toBe("no-store");
    const queuedPayload = JSON.parse(queued.body) as HandoffCreateResponse;
    expect(queuedPayload).toMatchObject({
      ok: true,
      status: "queued",
      state: "queued",
    });
    expect(queuedPayload.handoff).toMatchObject({
      id: queuedPayload.handoffId,
      summary: "Need the change",
      state: "queued",
    });

    const awaiting = await send(port, "/api/handoffs", {
      method: "POST",
      headers: spaHeaders(f.token, { origin: `http://127.0.0.1:${port}` }),
      body: handoffForm({ requires_approval: "1", summary: "Needs approval" }),
    });
    expect(awaiting.status).toBe(202);
    const awaitingPayload = JSON.parse(awaiting.body) as HandoffCreateResponse;
    expect(awaitingPayload).toMatchObject({
      ok: true,
      status: "awaiting_approval",
      state: "awaiting_approval",
    });
    expect(awaitingPayload.handoff?.id).toBe(awaitingPayload.handoffId);
  });

  it("rejects an empty summary with summary_required", async () => {
    const f = fixture();
    seedProject(f);
    const port = await start(f);
    const response = await send(port, "/api/handoffs", {
      method: "POST",
      headers: spaHeaders(f.token),
      body: handoffForm({ summary: "   " }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "Summary is required.",
      code: "summary_required",
    });
  });

  it("maps a policy denial to handoff_denied 403", async () => {
    const f = fixture();
    seedProject(f);
    setHandoffPolicy(f.db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "deny",
      replyMode: "auto",
    });
    const port = await start(f);
    const response = await send(port, "/api/handoffs", {
      method: "POST",
      headers: spaHeaders(f.token),
      body: handoffForm(),
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: "Handoff denied by project policy.",
      code: "handoff_denied",
      status: "denied",
    });
  });

  it("maps an existing handoff to handoff_exists 409", async () => {
    const f = fixture();
    seedProject(f);
    createHandoff(f.db, {
      id: "h-existing",
      projectId: "p",
      fromAppId: "p:a",
      toAppId: "p:b",
      summary: "Already here",
      spec: "",
      idempotencyKey: "k-existing",
    });
    const service = new CoordinatorService(f.db, "p");
    service.requestSiblingChange = () => ({
      handoffId: "h-existing",
      status: "existing",
      state: "queued",
    });
    f.deps.getProjects = () => [
      {
        id: "p",
        name: "Project P",
        rootPath: "/workspace/p",
        workspaceRoot: f.workspace,
        service,
      },
    ];
    const port = await start(f);
    const response = await send(port, "/api/handoffs", {
      method: "POST",
      headers: spaHeaders(f.token),
      body: handoffForm(),
    });
    expect(response.status).toBe(409);
    const payload = JSON.parse(response.body) as HandoffCreateResponse;
    expect(payload).toMatchObject({
      ok: false,
      error: "Handoff already exists.",
      code: "handoff_exists",
      handoffId: "h-existing",
      status: "existing",
      state: "queued",
    });
    expect(payload.handoff).toMatchObject({ id: "h-existing" });
  });

  it("rejects JSON, cross-site origins, and missing auth", async () => {
    const f = fixture();
    seedProject(f);
    const port = await start(f);

    const asJson = await send(port, "/api/handoffs", {
      method: "POST",
      headers: spaHeaders(f.token, { "content-type": "application/json" }),
      body: JSON.stringify({ summary: "json" }),
    });
    expect(asJson.status).toBe(415);

    const crossSite = await send(port, "/api/handoffs", {
      method: "POST",
      headers: spaHeaders(f.token, { origin: "http://evil.example" }),
      body: handoffForm(),
    });
    expect(crossSite.status).toBe(403);

    const anonymous = await send(port, "/api/handoffs", {
      method: "POST",
      headers: spaHeaders(undefined),
      body: handoffForm(),
    });
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body)).toEqual({ error: "sign in required" });
  });

  it("keeps the legacy browser and non-HTML redirects", async () => {
    const f = fixture();
    seedProject(f);
    const port = await start(f);

    const browser = await send(port, "/api/handoffs", {
      method: "POST",
      headers: { ...cookie(f.token), accept: "text/html" },
      body: handoffForm({ return_to: "/projects/p" }),
    });
    expect(browser.status).toBe(303);
    expect(browser.headers.location).toContain("/projects/p");
    expect(browser.headers.location).toContain("notice=Handoff+created.");

    const api = await send(port, "/api/handoffs", {
      method: "POST",
      headers: { ...cookie(f.token), accept: "application/json" },
      body: handoffForm(),
    });
    expect(api.status).toBe(303);
    expect(api.headers.location).toBe("/");
  });
});

function pendingHandoff(f: Fixture, summary: string): string {
  return new CoordinatorService(f.db, "p").requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary,
    spec: "spec",
    requiresApproval: true,
  }).handoffId;
}

describe("POST /api/handoffs/:id/decision SPA mutation", () => {
  it("approves and rejects with 200 JSON while preserving approval semantics", async () => {
    const f = fixture();
    seedProject(f);
    const port = await start(f);
    const approveId = pendingHandoff(f, "Approve me");
    const rejectId = pendingHandoff(f, "Reject me");

    const approved = await send(port, `/api/handoffs/${approveId}/decision`, {
      method: "POST",
      headers: spaHeaders(f.token),
      body: form({
        decision: "approved",
        approval_kind: "dispatch",
        reason: "looks good",
      }),
    });
    expect(approved.status).toBe(200);
    expect(approved.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(approved.body)).toEqual({ ok: true, decision: "approved" });
    expect(getHandoff(f.db, approveId)?.state).toBe("dispatching");
    const approval = f.db
      .prepare("SELECT reason FROM approvals WHERE handoff_id = ?")
      .get(approveId) as { reason: string };
    expect(approval.reason).toBe("looks good");

    const rejected = await send(port, `/api/handoffs/${rejectId}/decision`, {
      method: "POST",
      headers: spaHeaders(f.token, { origin: `http://127.0.0.1:${port}` }),
      body: form({ decision: "rejected", approval_kind: "dispatch" }),
    });
    expect(rejected.status).toBe(200);
    expect(JSON.parse(rejected.body)).toEqual({ ok: true, decision: "rejected" });
    expect(getHandoff(f.db, rejectId)?.state).toBe("rejected");
  });

  it("maps a missing decision, no pending approval, JSON, cross-site, and auth errors", async () => {
    const f = fixture();
    seedProject(f);
    const port = await start(f);
    const handoffId = pendingHandoff(f, "Decide me");
    const pathname = `/api/handoffs/${handoffId}/decision`;

    const missing = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token),
      body: form({ approval_kind: "dispatch" }),
    });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({
      error: "Decision must be approved or rejected.",
    });

    const asJson = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token, { "content-type": "application/json" }),
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(asJson.status).toBe(415);

    const crossSite = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token, { origin: "http://evil.example" }),
      body: form({ decision: "approved", approval_kind: "dispatch" }),
    });
    expect(crossSite.status).toBe(403);

    const anonymous = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(undefined),
      body: form({ decision: "approved", approval_kind: "dispatch" }),
    });
    expect(anonymous.status).toBe(401);

    const first = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token),
      body: form({ decision: "approved", approval_kind: "dispatch" }),
    });
    expect(first.status).toBe(200);
    const second = await send(port, pathname, {
      method: "POST",
      headers: spaHeaders(f.token),
      body: form({ decision: "approved", approval_kind: "dispatch" }),
    });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toEqual({
      error: "No pending approval for this handoff.",
    });
  });

  it("keeps the legacy browser redirect", async () => {
    const f = fixture();
    seedProject(f);
    const port = await start(f);
    const handoffId = pendingHandoff(f, "Legacy decision");
    const response = await send(port, `/api/handoffs/${handoffId}/decision`, {
      method: "POST",
      headers: { ...cookie(f.token), accept: "text/html" },
      body: form({
        decision: "approved",
        approval_kind: "dispatch",
        return_to: "/handoffs?filter=waiting",
      }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toContain("/handoffs?filter=waiting");
    expect(response.headers.location).toContain("tone=success");
    expect(getHandoff(f.db, handoffId)?.state).toBe("dispatching");
  });
});
