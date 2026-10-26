import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeploymentInProgressError } from "../src/coordinator/deployment-lock.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { handlePrompts, streamAppEvents } from "../src/http/prompts.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { DefaultImageUnavailableError, ImageNotReadyError } from "../src/images/service.js";
import {
  AgentTokenReconcileError,
  DeletionPendingError,
  type InstanceManager,
} from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { imageStateView } from "./fixtures/image-state.js";

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
  agentToken: string;
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

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-prompts-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  addProject(db, "p1", "Alpha", [
    { key: "storefront", path: "apps/storefront" },
    { key: "api", path: "apps/api" },
  ]);
  addProject(db, "p2", "Beta", [{ key: "storefront", path: "apps/storefront" }]);
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "bot" }).token;
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
        workspaceRoot: "/tmp",
        service: new CoordinatorService(db, row.id),
      })),
  };
  return { db, deps, token, agentToken };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/api/apps/storefront/prompts",
    headers: {},
    query: {},
    ...overrides,
  };
}

function post(token: string, pathname: string, body: unknown): HttpRequest {
  return request({
    method: "POST",
    path: pathname,
    query: { project: "p1" },
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface UpstreamCall {
  method: string;
  url: string;
  pathname: string;
  body: string;
}

interface FakeUpstream {
  endpoint: string;
  calls: UpstreamCall[];
  reply(method: string, pathname: string, body: unknown, status?: number): void;
}

async function fakeOpencode(): Promise<FakeUpstream> {
  const calls: UpstreamCall[] = [];
  const routes = new Map<string, { body: unknown; status: number }>();
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const call: UpstreamCall = {
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        pathname: url.pathname,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      calls.push(call);
      const route = routes.get(`${call.method} ${call.pathname}`);
      outgoing.writeHead(route?.status ?? 404, { "content-type": "application/json" });
      outgoing.end(
        route === undefined ? JSON.stringify({ error: "not found" }) : JSON.stringify(route.body),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    calls,
    reply(method, pathname, body, status = 200) {
      routes.set(`${method} ${pathname}`, { body, status });
    },
  };
}

function useUpstream(deps: HttpDeps, endpoint: string, warnings: string[] = []): void {
  deps.manager = {
    ensure: async () => endpoint,
    policyWarnings: () => [...warnings],
  } as unknown as InstanceManager;
}

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "q1",
    sessionID: "ses_1",
    questions: [
      {
        header: "Pick",
        question: "Which?",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        multiple: false,
        custom: true,
      },
    ],
    ...overrides,
  };
}

function permission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["ls*"],
    always: ["ls*"],
    ...overrides,
  };
}

function v2Permission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p2",
    sessionID: "ses_2",
    action: "bash",
    resources: ["ls*"],
    save: ["ls*"],
    ...overrides,
  };
}

function callsTo(upstream: FakeUpstream, method: string, pathname: string): UpstreamCall[] {
  return upstream.calls.filter((call) => call.method === method && call.pathname === pathname);
}

describe("prompts HTTP", () => {
  it("requires a principal, then a human, before any app or runtime lookup", async () => {
    const f = fixture();
    let ensured = 0;
    f.deps.manager = {
      ensure: async () => {
        ensured += 1;
        return "http://127.0.0.1:1";
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const missing = await handlePrompts(
      f.deps,
      request({ path: "/api/apps/unknown/prompts", query: { project: "missing" } }),
    );
    expect(missing.status).toBe(401);

    const agent = await handlePrompts(
      f.deps,
      request({
        path: "/api/apps/unknown/prompts",
        query: { project: "missing" },
        headers: auth(f.agentToken),
      }),
    );
    expect(agent.status).toBe(403);
    expect(ensured).toBe(0);
  });

  it("returns 503 when no runtime is configured and 404 for an unknown app", async () => {
    const f = fixture();
    const noRuntime = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );
    expect(noRuntime.status).toBe(503);

    const upstream = await fakeOpencode();
    useUpstream(f.deps, upstream.endpoint);
    const unknown = await handlePrompts(
      f.deps,
      request({ path: "/api/apps/nope/prompts", headers: auth(f.token) }),
    );
    expect(unknown.status).toBe(404);
  });

  it("merges v1 and v2 lists and includes policy warnings", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [question()]);
    upstream.reply("GET", "/permission", [permission()]);
    upstream.reply("GET", "/api/question/request", {
      data: [question({ id: "q2", sessionID: "ses_2" })],
    });
    upstream.reply("GET", "/api/permission/request", { data: [v2Permission()] });
    useUpstream(f.deps, upstream.endpoint, ["project config allows external access"]);

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      questions: Array<{ key: string; source: string }>;
      permissions: Array<{ key: string; source: string }>;
      truncated: boolean;
      warnings: string[];
    };
    expect(body.questions.map((item) => item.key)).toEqual(["v1:q1", "v2:q2"]);
    expect(body.questions.map((item) => item.source)).toEqual(["v1", "v2"]);
    expect(body.permissions.map((item) => item.key)).toEqual(["v1:p1", "v2:p2"]);
    expect(body.truncated).toBe(false);
    expect(body.warnings).toEqual(["project config allows external access"]);

    const v2Questions = callsTo(upstream, "GET", "/api/question/request");
    expect(v2Questions).toHaveLength(1);
    expect(decodeURIComponent(v2Questions[0]?.url ?? "")).toContain(
      "location[directory]=/tmp/p1/apps/storefront",
    );
  });

  it("filters policy verification diagnostics but keeps real policy findings", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [question()]);
    upstream.reply("GET", "/permission", [permission()]);
    upstream.reply("GET", "/api/question/request", { error: "boom" }, 500);
    upstream.reply("GET", "/api/permission/request", { data: [v2Permission()] });
    const realFinding = 'agent "custom-auditor": external_directory does not deny /etc/hostname';
    useUpstream(f.deps, upstream.endpoint, [
      "policy_unverified: agent policy verification failed",
      "  policy_unverified: agent policy verification timed out",
      realFinding,
    ]);

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { warnings: string[] };
    expect(body.warnings).toEqual(["v2 questions are unavailable", realFinding]);
  });

  it("keeps available sources and warns about failed ones", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [question()]);
    upstream.reply("GET", "/permission", []);
    upstream.reply("GET", "/api/permission/request", { data: [] });
    upstream.reply("GET", "/api/question/request", { error: "boom" }, 500);
    useUpstream(f.deps, upstream.endpoint);

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { warnings: string[]; questions: unknown[] };
    expect(body.questions).toHaveLength(1);
    expect(body.warnings).toEqual(["v2 questions are unavailable"]);
  });

  it("returns prompts_unavailable when all four sources fail", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    useUpstream(f.deps, upstream.endpoint);

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: "prompt sources are unavailable",
      code: "prompts_unavailable",
    });
  });

  it("replies to a v1 question and forwards the trimmed, deduped answers", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [question()]);
    upstream.reply("POST", "/question/q1/reply", true);
    useUpstream(f.deps, upstream.endpoint);

    const response = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [[" A ", "A"]],
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    const reply = callsTo(upstream, "POST", "/question/q1/reply");
    expect(reply).toHaveLength(1);
    expect(JSON.parse(reply[0]?.body ?? "")).toEqual({ answers: [["A"]] });
  });

  it("replies to a v2 question through the session-scoped path", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/api/question/request", {
      data: [question({ id: "q2", sessionID: "ses_2" })],
    });
    upstream.reply("POST", "/api/session/ses_2/question/q2/reply", true);
    useUpstream(f.deps, upstream.endpoint);

    const response = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q2/reply", {
        source: "v2",
        answers: [["B"]],
      }),
    );

    expect(response.status).toBe(200);
    const reply = callsTo(upstream, "POST", "/api/session/ses_2/question/q2/reply");
    expect(reply).toHaveLength(1);
    expect(JSON.parse(reply[0]?.body ?? "")).toEqual({ answers: [["B"]] });
  });

  it("accepts empty answers", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [question()]);
    upstream.reply("POST", "/question/q1/reply", true);
    useUpstream(f.deps, upstream.endpoint);

    const response = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [[]],
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(callsTo(upstream, "POST", "/question/q1/reply")[0]?.body ?? "")).toEqual({
      answers: [[]],
    });
  });

  it("rejects v1 and v2 questions", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [question()]);
    upstream.reply("POST", "/question/q1/reject", true);
    upstream.reply("GET", "/api/question/request", {
      data: [question({ id: "q2", sessionID: "ses_2" })],
    });
    upstream.reply("POST", "/api/session/ses_2/question/q2/reject", true);
    useUpstream(f.deps, upstream.endpoint);

    const v1 = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reject", { source: "v1" }),
    );
    expect(v1.status).toBe(200);
    expect(callsTo(upstream, "POST", "/question/q1/reject")).toHaveLength(1);

    const v2 = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q2/reject", { source: "v2" }),
    );
    expect(v2.status).toBe(200);
    expect(callsTo(upstream, "POST", "/api/session/ses_2/question/q2/reject")).toHaveLength(1);
  });

  it("validates answer counts, rules, and label shapes", async () => {
    const cases: Array<{ question: Record<string, unknown>; answers: unknown }> = [
      {
        question: {
          header: "H",
          question: "Q",
          options: [{ label: "A", description: "" }],
          multiple: false,
          custom: true,
        },
        answers: [],
      },
      {
        question: {
          header: "H",
          question: "Q",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
          multiple: false,
          custom: true,
        },
        answers: [["A", "B"]],
      },
      {
        question: {
          header: "H",
          question: "Q",
          options: [{ label: "A", description: "" }],
          multiple: false,
          custom: false,
        },
        answers: [["custom"]],
      },
      {
        question: {
          header: "H",
          question: "Q",
          options: [{ label: "A", description: "" }],
          multiple: true,
          custom: false,
        },
        answers: [["custom"]],
      },
      {
        question: {
          header: "H",
          question: "Q",
          options: [{ label: "A", description: "" }],
          multiple: true,
          custom: true,
        },
        answers: [["   "]],
      },
    ];

    for (const item of cases) {
      const f = fixture();
      const upstream = await fakeOpencode();
      upstream.reply("GET", "/question", [question({ questions: [item.question] })]);
      upstream.reply("POST", "/question/q1/reply", true);
      useUpstream(f.deps, upstream.endpoint);
      const response = await handlePrompts(
        f.deps,
        post(f.token, "/api/apps/storefront/questions/q1/reply", {
          source: "v1",
          answers: item.answers,
        }),
      );
      expect(response.status, JSON.stringify(item)).toBe(400);
      expect(JSON.parse(response.body).code).toBe("invalid_answers");
      expect(callsTo(upstream, "POST", "/question/q1/reply")).toHaveLength(0);
    }
  });

  it("accepts multiple option answers and a single custom answer where allowed", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [
      question({
        questions: [
          {
            header: "H",
            question: "Q",
            options: [
              { label: "A", description: "" },
              { label: "B", description: "" },
            ],
            multiple: true,
            custom: true,
          },
        ],
      }),
    ]);
    upstream.reply("POST", "/question/q1/reply", true);
    useUpstream(f.deps, upstream.endpoint);

    const multiple = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [["A", "B"]],
      }),
    );
    expect(multiple.status).toBe(200);

    const custom = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [["something else"]],
      }),
    );
    expect(custom.status).toBe(200);
  });

  it("rejects labels over 2,000 characters and payloads over 32 KB", async () => {
    const longLabel = "x".repeat(2_001);
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [
      question({
        questions: [
          {
            header: "H",
            question: "Q",
            options: [],
            multiple: true,
            custom: true,
          },
        ],
      }),
    ]);
    useUpstream(f.deps, upstream.endpoint);

    const tooLong = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [[longLabel]],
      }),
    );
    expect(tooLong.status).toBe(400);
    expect(JSON.parse(tooLong.body).code).toBe("invalid_answers");

    const manyLabels = Array.from({ length: 100 }, () => "y".repeat(400));
    const tooBig = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [manyLabels],
      }),
    );
    expect(tooBig.status).toBe(400);
    expect(JSON.parse(tooBig.body).code).toBe("invalid_answers");
  });

  it("marks a tooLarge request as non-answerable", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    const questions = Array.from({ length: 101 }, () => ({
      header: "H",
      question: "Q",
      options: [],
      multiple: false,
      custom: true,
    }));
    upstream.reply("GET", "/question", [question({ questions })]);
    useUpstream(f.deps, upstream.endpoint);

    const response = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: questions.map(() => []),
      }),
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).code).toBe("invalid_answers");
    expect(callsTo(upstream, "POST", "/question/q1/reply")).toHaveLength(0);
  });

  it("rejects an invalid or mismatched source", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [question()]);
    upstream.reply("GET", "/api/question/request", { data: [] });
    useUpstream(f.deps, upstream.endpoint);

    const invalid = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v3",
        answers: [[]],
      }),
    );
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body).code).toBe("invalid_source");

    const mismatched = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v2",
        answers: [[]],
      }),
    );
    expect(mismatched.status).toBe(400);
    expect(JSON.parse(mismatched.body).code).toBe("invalid_source");
  });

  it("maps missing prompts and upstream failures", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", []);
    upstream.reply("GET", "/api/question/request", { data: [] });
    useUpstream(f.deps, upstream.endpoint);

    const missing = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [[]],
      }),
    );
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe("prompt_expired");

    upstream.reply("GET", "/question", [question()]);
    upstream.reply("POST", "/question/q1/reply", { error: "gone" }, 404);
    const expired = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [[]],
      }),
    );
    expect(expired.status).toBe(404);
    expect(JSON.parse(expired.body).code).toBe("prompt_expired");

    upstream.reply("POST", "/question/q1/reply", { error: "boom" }, 500);
    const failed = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/questions/q1/reply", {
        source: "v1",
        answers: [[]],
      }),
    );
    expect(failed.status).toBe(502);
  });

  it("requires a JSON content type and valid JSON for POST routes", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    useUpstream(f.deps, upstream.endpoint);

    const noType = await handlePrompts(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/questions/q1/reply",
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ source: "v1", answers: [[]] }),
      }),
    );
    expect(noType.status).toBe(415);

    const badJson = await handlePrompts(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/questions/q1/reply",
        query: { project: "p1" },
        headers: { ...auth(f.token), "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(badJson.status).toBe(400);
  });

  it("replies to v1 and v2 permissions and validates the message", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/permission", [permission()]);
    upstream.reply("POST", "/permission/p1/reply", true);
    upstream.reply("GET", "/api/permission/request", { data: [v2Permission()] });
    upstream.reply("POST", "/api/session/ses_2/permission/p2/reply", true);
    useUpstream(f.deps, upstream.endpoint);

    const v1 = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/permissions/p1/reply", {
        source: "v1",
        reply: "once",
      }),
    );
    expect(v1.status).toBe(200);
    expect(JSON.parse(callsTo(upstream, "POST", "/permission/p1/reply")[0]?.body ?? "")).toEqual({
      reply: "once",
    });

    const v2 = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/permissions/p2/reply", {
        source: "v2",
        reply: "always",
      }),
    );
    expect(v2.status).toBe(200);
    expect(
      JSON.parse(
        callsTo(upstream, "POST", "/api/session/ses_2/permission/p2/reply")[0]?.body ?? "",
      ),
    ).toEqual({ reply: "always" });

    const rejected = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/permissions/p1/reply", {
        source: "v1",
        reply: "reject",
        message: "not now",
      }),
    );
    expect(rejected.status).toBe(200);
    expect(JSON.parse(callsTo(upstream, "POST", "/permission/p1/reply")[1]?.body ?? "")).toEqual({
      reply: "reject",
      message: "not now",
    });

    const messageWithOnce = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/permissions/p1/reply", {
        source: "v1",
        reply: "once",
        message: "hello",
      }),
    );
    expect(messageWithOnce.status).toBe(400);
    expect(JSON.parse(messageWithOnce.body).code).toBe("invalid_permission_reply");

    const longMessage = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/permissions/p1/reply", {
        source: "v1",
        reply: "reject",
        message: "x".repeat(4_001),
      }),
    );
    expect(longMessage.status).toBe(400);
    expect(JSON.parse(longMessage.body).code).toBe("invalid_permission_reply");

    const invalidReply = await handlePrompts(
      f.deps,
      post(f.token, "/api/apps/storefront/permissions/p1/reply", {
        source: "v1",
        reply: "maybe",
      }),
    );
    expect(invalidReply.status).toBe(400);
    expect(JSON.parse(invalidReply.body).code).toBe("invalid_permission_reply");
  });

  it("lists and revokes saved permissions", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/api/permission/saved", {
      data: [{ id: "saved_1", projectID: "p1", action: "bash", resource: "ls*" }],
    });
    upstream.reply("DELETE", "/api/permission/saved/saved_1", true);
    useUpstream(f.deps, upstream.endpoint);

    const list = await handlePrompts(
      f.deps,
      request({
        path: "/api/apps/storefront/permissions/saved",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual({
      permissions: [{ id: "saved_1", projectID: "p1", action: "bash", resource: "ls*" }],
    });

    const revoke = await handlePrompts(
      f.deps,
      request({
        method: "DELETE",
        path: "/api/apps/storefront/permissions/saved/saved_1",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(revoke.status).toBe(200);
    expect(JSON.parse(revoke.body)).toEqual({ ok: true });
    expect(callsTo(upstream, "DELETE", "/api/permission/saved/saved_1")).toHaveLength(1);
  });

  it("normalizes todos and maps a missing session to session_not_found", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/session/ses_1/todo", [
      { content: "step", status: "blocked", priority: "urgent" },
    ]);
    useUpstream(f.deps, upstream.endpoint);

    const response = await handlePrompts(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/todo",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      todos: [{ content: "step", status: "unknown", priority: "unknown" }],
      truncated: false,
    });

    const missing = await handlePrompts(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_missing/todo",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({
      error: "session not found",
      code: "session_not_found",
    });
  });

  it("maps a runtime start failure to 502", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new Error("port in use");
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body).error).toContain("port in use");
  });

  it("maps a pending deletion to 409 without changing start failures", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DeletionPendingError("p1:storefront");
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "application p1:storefront is pending deletion",
      code: "deletion_pending",
    });
  });

  it("maps a deployment lock to the shared 409 body", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DeploymentInProgressError("ensure", { phase: "switching" });
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );
    expect(response.status).toBe(409);
    expect(response.headers?.["retry-after"]).toBe("30");
    expect(JSON.parse(response.body)).toEqual({
      error: "deployment_in_progress",
      message: "deployment in progress: switching",
      retryAfter: 30,
    });
  });

  it("maps an agent-token reconciliation failure to the shared 500 body", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new AgentTokenReconcileError("p1:storefront");
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "agent_token_reconcile_failed" });
  });

  it("maps a pending deletion on the app event stream to 409", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DeletionPendingError("p1:storefront");
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;
    const written: { status?: number; body?: string } = {};
    const response = {
      writeHead(status: number) {
        written.status = status;
        return response;
      },
      end(body?: string) {
        written.body = body;
      },
      destroyed: false,
      writableEnded: false,
    } as unknown as Parameters<typeof streamAppEvents>[2];

    await streamAppEvents(
      f.deps,
      request({
        path: "/api/apps/storefront/events",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
      response,
    );

    expect(written.status).toBe(409);
    expect(JSON.parse(written.body ?? "")).toEqual({
      error: "application p1:storefront is pending deletion",
      code: "deletion_pending",
    });
  });

  it("is dispatched before the chat catch-all on the real server", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    upstream.reply("GET", "/question", [question()]);
    upstream.reply("GET", "/permission", []);
    upstream.reply("GET", "/api/question/request", { data: [] });
    upstream.reply("GET", "/api/permission/request", { data: [] });
    useUpstream(f.deps, upstream.endpoint);
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/apps/storefront/prompts?project=p1`,
      { headers: auth(f.token) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { questions: Array<{ key: string }> };
    expect(body.questions.map((item) => item.key)).toEqual(["v1:q1"]);
  });
});

describe("prompts typed image failures", () => {
  it("maps image_not_ready to 409 instead of a raw 502", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new ImageNotReadyError(
          imageStateView({ appId: "p1:storefront", state: "not_ready" }),
        );
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "image_not_ready",
      code: "image_not_ready",
      message: "application image is not ready (not_ready)",
      appId: "p1:storefront",
      state: "not_ready",
      imageStatus: "missing",
      buildConfigured: true,
    });
  });

  it("maps default_image_unavailable to 503 instead of a raw 502", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DefaultImageUnavailableError(
          imageStateView({ appId: "p1:storefront", buildConfigured: false, state: "unknown" }),
        );
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const response = await handlePrompts(
      f.deps,
      request({ query: { project: "p1" }, headers: auth(f.token) }),
    );

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "default_image_unavailable",
      code: "default_image_unavailable",
      message: "the default agent image is unavailable",
      appId: "p1:storefront",
      state: "unknown",
    });
  });

  it("maps a typed image failure on the app event stream to a bounded JSON body", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new ImageNotReadyError(
          imageStateView({ appId: "p1:storefront", state: "not_ready" }),
        );
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;
    const written: { status?: number; body?: string } = {};
    const response = {
      writeHead(status: number) {
        written.status = status;
        return response;
      },
      end(body?: string) {
        written.body = body;
      },
      destroyed: false,
      writableEnded: false,
    } as unknown as Parameters<typeof streamAppEvents>[2];

    await streamAppEvents(
      f.deps,
      request({
        path: "/api/apps/storefront/events",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
      response,
    );

    expect(written.status).toBe(409);
    expect(JSON.parse(written.body ?? "")).toMatchObject({
      error: "image_not_ready",
      code: "image_not_ready",
      appId: "p1:storefront",
      state: "not_ready",
    });
  });
});
