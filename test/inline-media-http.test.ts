import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyReadBudget } from "../src/attachments/budget.js";
import { INLINE_MAX_BYTES } from "../src/attachments/inline.js";
import { INLINE_READ_BUDGET_WAIT_MS } from "../src/attachments/inline-media.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { handleInlineMediaDownload } from "../src/http/inline-media.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { MESSAGES_HISTORY_MAX_BYTES, type OpencodeMessage } from "../src/opencode/client.js";
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

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(592, 9),
]);

function png(size: number): Buffer {
  return Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(Math.max(0, size - 8), 9)]);
}

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function filePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "prt_1",
    type: "file",
    mime: "image/png",
    filename: "shot.png",
    url: dataUrl("image/png", PNG),
    sessionID: "ses_1",
    messageID: "msg_1",
    ...overrides,
  };
}

function message(parts: Array<Record<string, unknown>>): OpencodeMessage {
  return { info: { id: "msg_1", role: "user" }, parts: parts as OpencodeMessage["parts"] };
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function upstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ endpoint: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url ?? "");
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}`, calls };
}

interface Setup {
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
  base: string;
  project: { deleting?: boolean };
  ensureCalls: () => number;
  upstreamCalls: () => string[];
}

async function setup(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  options: { stopped?: boolean } = {},
): Promise<Setup> {
  const upstreamServer = await upstream(handler);
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-inline-media-http-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  const workspaceRoot = path.join(dir, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','app','AGENTS.md',?)",
  ).run(now);
  let ensureCalls = 0;
  const manager = {
    endpointFor: options.stopped === true ? () => undefined : () => upstreamServer.endpoint,
    ensure: async () => {
      ensureCalls += 1;
      return upstreamServer.endpoint;
    },
  } as unknown as InstanceManager;
  const project = {
    id: "p",
    name: "P",
    rootPath: projectRoot,
    workspaceRoot,
    service: new CoordinatorService(db, "p"),
  };
  const deps: HttpDeps = {
    db,
    workspaceRoot,
    git: new GitService({ workspaceRoot }),
    getProjects: () => [project],
    manager,
  };
  const server = createHttpServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    db,
    deps,
    token: createPrincipal(db, { kind: "human", name: "operator" }).token,
    base: `http://127.0.0.1:${address.port}`,
    project,
    ensureCalls: () => ensureCalls,
    upstreamCalls: () => upstreamServer.calls,
  };
}

interface RouteOptions {
  app?: string;
  session?: string;
  message?: string;
  part?: string;
  project?: string | null;
}

function route(base: string, options: RouteOptions = {}): string {
  const app = options.app ?? "a";
  const session = options.session ?? "ses_1";
  const messageId = options.message ?? "msg_1";
  const part = options.part ?? "prt_1";
  const project = options.project === undefined ? "p" : options.project;
  const query = project === null ? "" : `?project=${encodeURIComponent(project)}`;
  return `${base}/api/apps/${encodeURIComponent(app)}/sessions/${encodeURIComponent(
    session,
  )}/messages/${encodeURIComponent(messageId)}/parts/${encodeURIComponent(part)}/inline${query}`;
}

function auth(setupResult: Setup): Record<string, string> {
  return { authorization: `Bearer ${setupResult.token}` };
}

async function errorBody(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

describe("inline media download route", () => {
  it("serves the exact image bytes with inline-safe headers", async () => {
    const img = png(600);
    const f = await setup((_request, response) =>
      json(
        response,
        message([filePart({ filename: "../../evil name.png", url: dataUrl("image/png", img) })]),
      ),
    );
    const response = await fetch(route(f.base), { headers: auth(f) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("content-length")).toBe(String(img.length));
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("inline;");
    expect(disposition).toContain('filename="evil name.png"');
    expect(disposition).toContain("filename*=UTF-8''evil%20name.png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(img)).toBe(true);
    expect(bytes.toString("latin1")).not.toContain("data:");
    expect(f.ensureCalls()).toBe(0);
  });

  it("serves HEAD with the full content-length and no body", async () => {
    const img = png(600);
    const f = await setup((_request, response) =>
      json(response, message([filePart({ url: dataUrl("image/png", img) })])),
    );
    const response = await fetch(route(f.base), { method: "HEAD", headers: auth(f) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(img.length));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("content-disposition")).toContain("inline;");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects a missing project and an unauthenticated or agent request", async () => {
    const f = await setup((_request, response) => json(response, message([filePart()])));
    const missingProject = await fetch(route(f.base, { project: null }), { headers: auth(f) });
    expect(missingProject.status).toBe(400);
    expect(await errorBody(missingProject)).toMatchObject({ code: "project_required" });

    const anonymous = await fetch(route(f.base));
    expect(anonymous.status).toBe(401);
    expect(await errorBody(anonymous)).toMatchObject({ code: "sign_in_required" });

    const agentToken = createPrincipal(f.db, { kind: "agent", name: "bot" }).token;
    const agent = await fetch(route(f.base), {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(agent.status).toBe(403);
    expect(await errorBody(agent)).toMatchObject({ code: "human_only" });
  });

  it("returns 404 for an unknown app, session, message, and part", async () => {
    const f = await setup((_request, response) => json(response, message([filePart()])));
    const cases = [
      route(f.base, { app: "missing" }),
      route(f.base, { session: "ses_9" }),
      route(f.base, { message: "msg_9" }),
      route(f.base, { part: "prt_404" }),
    ];
    for (const url of cases) {
      const response = await fetch(url, { headers: auth(f) });
      expect(response.status).toBe(404);
      expect(await errorBody(response)).toMatchObject({ code: "inline_media_not_found" });
    }
  });

  it("refuses a delivery-owned part without reading the message", async () => {
    const f = await setup((_request, response) => json(response, message([filePart()])));
    const now = new Date().toISOString();
    f.db
      .prepare(
        `INSERT INTO app_attachments
           (id, app_id, session_id, original_name, mode, state, created_at, updated_at)
         VALUES ('att_1', 'p:a', 'ses_1', 'shot.png', 'auto', 'available', ?, ?)`,
      )
      .run(now, now);
    f.db
      .prepare(
        `INSERT INTO attachment_deliveries
           (id, attachment_id, app_id, session_id, part_id, message_id, state, created_at, updated_at)
         VALUES ('del_1', 'att_1', 'p:a', 'ses_1', 'prt_owned', 'msg_1', 'sent', ?, ?)`,
      )
      .run(now, now);
    const response = await fetch(route(f.base, { part: "prt_owned" }), { headers: auth(f) });
    expect(response.status).toBe(404);
    expect(await errorBody(response)).toMatchObject({ code: "inline_media_not_found" });
    expect(f.upstreamCalls()).toHaveLength(0);
  });

  it("returns 404 for a non-file part, malformed data URL, empty payload, and id mismatch", async () => {
    const cases: Array<Record<string, unknown>> = [
      { id: "prt_1", type: "text", text: "hello" },
      filePart({ url: "data:image/png;base64,@@@@@@@@" }),
      filePart({ url: "data:image/png;base64," }),
      filePart({ sessionID: "ses_other" }),
      filePart({ messageID: "msg_other" }),
    ];
    for (const part of cases) {
      const f = await setup((_request, response) => json(response, message([part])));
      const response = await fetch(route(f.base), { headers: auth(f) });
      expect(response.status).toBe(404);
      expect(await errorBody(response)).toMatchObject({ code: "inline_media_not_found" });
    }
  });

  it("returns 409 deletion_pending for a deleting app or project", async () => {
    const appDeleting = await setup((_request, response) => json(response, message([filePart()])));
    appDeleting.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p:a'").run();
    const appResponse = await fetch(route(appDeleting.base), { headers: auth(appDeleting) });
    expect(appResponse.status).toBe(409);
    expect(await errorBody(appResponse)).toMatchObject({ code: "deletion_pending" });

    const projectDeleting = await setup((_request, response) =>
      json(response, message([filePart()])),
    );
    projectDeleting.project.deleting = true;
    const projectResponse = await fetch(route(projectDeleting.base), {
      headers: auth(projectDeleting),
    });
    expect(projectResponse.status).toBe(409);
    expect(await errorBody(projectResponse)).toMatchObject({ code: "deletion_pending" });
  });

  it("returns 413 when the part exceeds the 20 MiB decoded cap", async () => {
    const oversized = Buffer.alloc(INLINE_MAX_BYTES + 1, 9);
    const f = await setup((_request, response) =>
      json(response, message([filePart({ url: dataUrl("image/png", oversized) })])),
    );
    const response = await fetch(route(f.base), { headers: auth(f) });
    expect(response.status).toBe(413);
    expect(await errorBody(response)).toMatchObject({ code: "inline_media_too_large" });
  }, 20_000);

  it("returns 413 when the message read overflows the 48 MiB cap", async () => {
    const f = await setup((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 0x78);
      for (let index = 0; index < 49; index += 1) response.write(chunk);
      response.end();
    });
    const response = await fetch(route(f.base), { headers: auth(f) });
    expect(response.status).toBe(413);
    expect(await errorBody(response)).toMatchObject({ code: "inline_media_too_large" });
  }, 20_000);

  it("returns 415 when the declared image bytes are not an image", async () => {
    const html = Buffer.from("<html><body>not an image</body></html>");
    const f = await setup((_request, response) =>
      json(
        response,
        message([
          filePart({ mime: "image/png", filename: "evil.png", url: dataUrl("image/png", html) }),
        ]),
      ),
    );
    const response = await fetch(route(f.base), { headers: auth(f) });
    expect(response.status).toBe(415);
    expect(await errorBody(response)).toMatchObject({ code: "inline_media_unsupported" });
  });

  it("maps an upstream 500 and a transport failure to 502 without echoing the body", async () => {
    const failing = await setup((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("upstream data:image/png;base64,secret");
    });
    const failed = await fetch(route(failing.base), { headers: auth(failing) });
    expect(failed.status).toBe(502);
    expect(await errorBody(failed)).toMatchObject({ code: "agent_unavailable" });

    const dropped = await setup((request) => request.socket.destroy());
    const droppedResponse = await fetch(route(dropped.base), { headers: auth(dropped) });
    expect(droppedResponse.status).toBe(502);
    const droppedBody = await droppedResponse.text();
    expect(JSON.parse(droppedBody)).toMatchObject({ code: "agent_unavailable" });
    expect(droppedBody).not.toContain("data:");
  });

  it("returns 503 agent_stopped without starting the app", async () => {
    const f = await setup((_request, response) => json(response, message([filePart()])), {
      stopped: true,
    });
    const response = await fetch(route(f.base), { headers: auth(f) });
    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({ code: "agent_stopped" });
    expect(f.ensureCalls()).toBe(0);
  });

  it("returns 405 for a non-GET/HEAD method on the inline path", async () => {
    const f = await setup((_request, response) => json(response, message([filePart()])));
    const response = await fetch(route(f.base), { method: "POST", headers: auth(f) });
    expect(response.status).toBe(405);
  });

  it("returns 503 inline_busy with Retry-After when the history budget is exhausted", async () => {
    const f = await setup((_request, response) => json(response, message([filePart()])));
    const held = await historyReadBudget.acquire(MESSAGES_HISTORY_MAX_BYTES * 4);
    expect(held).toBeDefined();
    vi.useFakeTimers();
    let status = 0;
    let headers: Record<string, string> = {};
    let body = "";
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead(value: number, valueHeaders: Record<string, string>) {
        status = value;
        headers = valueHeaders;
      },
      end(value?: unknown) {
        body = typeof value === "string" ? value : "";
      },
    } as unknown as ServerResponse;
    try {
      const pending = handleInlineMediaDownload(
        f.deps,
        {
          method: "GET",
          headers: { authorization: `Bearer ${f.token}` },
        } as unknown as IncomingMessage,
        response,
        new URL(route(f.base)),
      );
      await vi.advanceTimersByTimeAsync(INLINE_READ_BUDGET_WAIT_MS);
      await pending;
      expect(status).toBe(503);
      expect(headers["retry-after"]).toBe("1");
      expect(JSON.parse(body)).toMatchObject({ code: "inline_busy" });
    } finally {
      held?.();
      vi.useRealTimers();
    }
  });
});
