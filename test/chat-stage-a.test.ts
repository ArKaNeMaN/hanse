import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PendingRecovery } from "../src/chat/pending.js";
import {
  insertEmptySessionState,
  insertPendingSend,
  readDraft,
  readPendingSend,
  readPendingSends,
  readSessionState,
} from "../src/chat/state.js";
import { ChatSweep } from "../src/chat/sweep.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleChat } from "../src/http/chat.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const recoveries: PendingRecovery[] = [];

afterEach(async () => {
  for (const recovery of recoveries.splice(0)) recovery.dispose();
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
  dir: string;
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
  agentsHome: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-stage-a-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Alpha','main',?,?,?)",
  ).run(path.join(dir, "project"), now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p1:storefront','p1','storefront','apps/storefront','AGENTS.md',?)",
  ).run(now);
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentsHome = path.join(dir, "agents");
  mkdirSync(agentsHome, { recursive: true });
  const deps: HttpDeps = {
    db,
    workspaceRoot: dir,
    git: new GitService({ workspaceRoot: dir }),
    agentsHome,
    getProjects: () => [
      {
        id: "p1",
        name: "Alpha",
        rootPath: path.join(dir, "project"),
        workspaceRoot: dir,
        deleting: false,
        service: new CoordinatorService(db, "p1"),
      },
    ],
  };
  return { dir, db, deps, token, agentsHome };
}

interface UpstreamCall {
  method: string;
  url: string;
  body: string;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/chat", headers: {}, query: {}, ...overrides };
}

async function fakeOpencode(
  handler: (incoming: IncomingMessage, outgoing: ServerResponse, body: string) => void,
): Promise<{ endpoint: string; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: incoming.method ?? "", url: incoming.url ?? "", body });
      handler(incoming, outgoing, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}`, calls };
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function emptyPage(response: ServerResponse): void {
  json(response, []);
}

function useManager(
  f: Fixture,
  endpoint: string | undefined,
  pendingRecovery?: PendingRecovery,
): { ensureCalls: number } {
  const state = { ensureCalls: 0 };
  f.deps.manager = {
    ensure: async () => {
      state.ensureCalls += 1;
      if (endpoint === undefined) throw new Error("agent is stopped");
      return endpoint;
    },
    endpointFor: () => endpoint,
    monitorState: () => "disabled",
    armPendingConfirmation: () => undefined,
    preparePendingConfirmation: async () => undefined,
    startChatMaintenance: () => undefined,
    ...(pendingRecovery === undefined ? {} : { pendingRecovery }),
  } as unknown as InstanceManager;
  return state;
}

function recoveryFor(
  f: Fixture,
  endpoint: () => string | undefined,
  backoff: readonly number[] = [0],
): PendingRecovery {
  const recovery = new PendingRecovery({
    db: f.db,
    endpointFor: () => endpoint(),
    backoffMs: backoff,
    routeDeadlineMs: 2_000,
  });
  recoveries.push(recovery);
  return recovery;
}

function draftRequest(f: Fixture, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return request({
    method: "GET",
    path: "/api/apps/storefront/sessions/ses_1/draft",
    query: { project: "p1" },
    headers: auth(f.token),
    ...overrides,
  });
}

function sendRequest(f: Fixture, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return request({
    method: "POST",
    path: "/api/apps/storefront/sessions/ses_1/messages",
    query: { project: "p1", async: "1" },
    headers: auth(f.token),
    body: JSON.stringify({ text: "hello" }),
    ...overrides,
  });
}

describe("stage A draft routes", () => {
  it("returns the empty draft contract without starting the app or creating state", async () => {
    const f = fixture();
    const manager = useManager(f, undefined);
    const response = await handleChat(f.deps, draftRequest(f));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      text: "",
      attachments: [],
      pendingSends: [],
      quota: { percent: 0 },
      updatedAt: null,
    });
    expect(manager.ensureCalls).toBe(0);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeUndefined();
    expect(readDraft(f.db, "p1:storefront", "ses_1")).toBeUndefined();
  });

  it("returns pending sends and bumps last activity only when a state row exists", async () => {
    const f = fixture();
    useManager(f, undefined);
    insertPendingSend(f.db, {
      id: "pend_1",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_1",
      text: "queued",
      now: "2026-10-01T00:00:00.000Z",
    });
    const first = await handleChat(f.deps, draftRequest(f));
    expect(JSON.parse(first.body).pendingSends).toEqual([
      {
        id: "pend_1",
        messageID: "msg_1",
        text: "queued",
        attachments: [],
        attachmentIDs: [],
        state: "sending",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeUndefined();

    insertEmptySessionState(f.db, "p1:storefront", "ses_1", "2026-10-01T00:00:00.000Z");
    await handleChat(f.deps, draftRequest(f));
    const state = readSessionState(f.db, "p1:storefront", "ses_1");
    expect(state?.lastActivityAt).not.toBe("2026-10-01T00:00:00.000Z");
  });

  it("rejects an unknown app with app_not_found and no ensure", async () => {
    const f = fixture();
    const manager = useManager(f, undefined);
    const response = await handleChat(
      f.deps,
      draftRequest(f, { path: "/api/apps/missing/sessions/ses_1/draft" }),
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).code).toBe("app_not_found");
    expect(manager.ensureCalls).toBe(0);
  });

  it("persists a draft on upstream 5xx and rejects only a definite 404", async () => {
    const f = fixture();
    let status = 500;
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        if (status === 200) {
          json(outgoing, { id: "ses_1" });
          return;
        }
        outgoing.writeHead(status);
        outgoing.end("boom");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);

    const persisted = await handleChat(
      f.deps,
      draftRequest(f, { method: "PUT", body: JSON.stringify({ text: "draft" }) }),
    );
    expect(persisted.status).toBe(200);
    expect(readDraft(f.db, "p1:storefront", "ses_1")?.text).toBe("draft");
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeUndefined();

    status = 404;
    const missing = await handleChat(
      f.deps,
      draftRequest(f, { method: "PUT", body: JSON.stringify({ text: "new" }) }),
    );
    expect(missing.status).toBe(404);
    expect(readDraft(f.db, "p1:storefront", "ses_1")?.text).toBe("draft");
  });

  it("upserts has_messages=1 for a reachable pre-existing session", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1" });
        return;
      }
      json(outgoing, { touched: true });
    });
    useManager(f, upstream.endpoint);
    const response = await handleChat(
      f.deps,
      draftRequest(f, { method: "PUT", body: JSON.stringify({ text: "hello" }) }),
    );
    expect(response.status).toBe(200);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")?.hasMessages).toBe(1);
  });

  it("keeps has_messages=0 for a Hanse-created empty session on PUT and touch", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1" });
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());

    const draft = await handleChat(
      f.deps,
      draftRequest(f, { method: "PUT", body: JSON.stringify({ text: "hello" }) }),
    );
    expect(draft.status).toBe(200);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")?.hasMessages).toBe(0);

    const touch = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/touch",
        query: { project: "p1" },
        headers: auth(f.token),
        body: "{}",
      }),
    );
    expect(touch.status).toBe(200);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")?.hasMessages).toBe(0);
  });

  it("upserts has_messages=1 on touch for a reachable pre-existing session", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1" });
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/touch",
        query: { project: "p1" },
        headers: auth(f.token),
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")?.hasMessages).toBe(1);
  });

  it("enforces the 32 KiB text cap and human-only access", async () => {
    const f = fixture();
    useManager(f, undefined);
    const tooLarge = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "PUT",
        body: JSON.stringify({ text: "x".repeat(32 * 1024 + 1) }),
      }),
    );
    expect(tooLarge.status).toBe(400);
    expect(JSON.parse(tooLarge.body).code).toBe("draft_too_large");

    const agent = createPrincipal(f.db, { kind: "agent", name: "bot" });
    const forbidden = await handleChat(f.deps, draftRequest(f, { headers: auth(agent.token) }));
    expect(forbidden.status).toBe(403);
  });

  it("does not create a row or start the app when touch cannot reach upstream", async () => {
    const f = fixture();
    const manager = useManager(f, undefined);
    const first = await handleChat(
      f.deps,
      draftRequest(f, { method: "POST", path: "/api/apps/storefront/sessions/ses_1/touch" }),
    );
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ touched: true });
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeUndefined();
    expect(manager.ensureCalls).toBe(0);
  });

  it("accepts a 256 KiB chat body and rejects one over the cap", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1" });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/apps/storefront/sessions/ses_1/draft?project=p1`;
    const headers = { authorization: `Bearer ${f.token}`, "content-type": "application/json" };

    const accepted = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ text: "x".repeat(32 * 1024) }),
    });
    expect(accepted.status).toBe(200);

    const rejected = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ text: "x".repeat(300 * 1024) }),
    });
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({
      error: "request body too large",
      code: "payload_too_large",
    });

    const aboveTextCap = await fetch(
      `http://127.0.0.1:${address.port}/api/apps/storefront/sessions/ses_1/messages?project=p1&async=1`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "x".repeat(70 * 1024) }),
      },
    );
    expect(aboveTextCap.status).toBe(400);
    expect(await aboveTextCap.json()).toEqual({
      error: "message too large",
      code: "message_too_large",
    });
  });
});

describe("stage A eager sessions and sessions listing", () => {
  it("passes a sanitized title and inserts an empty state row", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing, body) => {
      if (incoming.method === "POST" && incoming.url === "/session") {
        const title = (JSON.parse(body) as { title?: string }).title;
        json(outgoing, { id: "ses_new", title });
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions",
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ title: "  Hello\nworld\u0007  " }),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(upstream.calls[0]?.body ?? "")).toEqual({ title: "Hello world" });
    expect(readSessionState(f.db, "p1:storefront", "ses_new")?.hasMessages).toBe(0);
  });

  it("omits the title for a text-only create and rejects an over-long title", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing, body) => {
      if (incoming.method === "POST" && incoming.url === "/session") {
        expect(JSON.parse(body)).toEqual({});
        json(outgoing, { id: "ses_new" });
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions",
        query: { project: "p1" },
        headers: auth(f.token),
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    const invalid = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions",
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ title: "x".repeat(121) }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body).code).toBe("invalid_title");
  });

  it("adds a draft summary with emptyDraft for an empty session with a draft", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => {
      json(outgoing, [{ id: "ses_1", title: "One" }]);
    });
    useManager(f, upstream.endpoint);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    const response = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    const sessions = JSON.parse(response.body).sessions as Array<{
      draft: { hasText: boolean; attachmentCount: number; emptyDraft: boolean };
    }>;
    expect(sessions[0]?.draft).toEqual({
      hasText: false,
      attachmentCount: 0,
      emptyDraft: false,
      updatedAt: null,
    });

    f.db
      .prepare("INSERT INTO message_drafts (app_id, session_id, text, updated_at) VALUES (?,?,?,?)")
      .run("p1:storefront", "ses_1", "draft", new Date().toISOString());
    const withDraft = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    const updated = JSON.parse(withDraft.body).sessions as Array<{
      draft: { hasText: boolean; emptyDraft: boolean };
    }>;
    expect(updated[0]?.draft.hasText).toBe(true);
    expect(updated[0]?.draft.emptyDraft).toBe(true);
  });
});

describe("stage A delete-if-empty and manual delete", () => {
  it("blocks for has_messages, a draft, or a pending send without starting the app", async () => {
    const f = fixture();
    const manager = useManager(f, undefined);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    f.db
      .prepare("UPDATE session_state SET has_messages = 1 WHERE app_id = ? AND session_id = ?")
      .run("p1:storefront", "ses_1");
    const hasMessages = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
      }),
    );
    expect(JSON.parse(hasMessages.body)).toEqual({
      deleted: false,
      reason: "has_messages",
    });

    f.db
      .prepare("UPDATE session_state SET has_messages = 0 WHERE app_id = ? AND session_id = ?")
      .run("p1:storefront", "ses_1");
    f.db
      .prepare("INSERT INTO message_drafts (app_id, session_id, text, updated_at) VALUES (?,?,?,?)")
      .run("p1:storefront", "ses_1", "draft", new Date().toISOString());
    const hasDraft = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
      }),
    );
    expect(JSON.parse(hasDraft.body)).toEqual({ deleted: false, reason: "has_draft" });
    expect(manager.ensureCalls).toBe(0);
  });

  it("deletes an empty session with limit=1 and removes its folder", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message?limit=1") {
        emptyPage(outgoing);
        return;
      }
      if (incoming.method === "DELETE" && incoming.url === "/session/ses_1") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    const folder = path.join(f.agentsHome, "p1", "storefront", "attachments", "ses_1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "orphan.txt"), "x");

    const response = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ deleted: true, upstream: true });
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
  });

  it("fails closed when the upstream empty check returns 5xx", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message?limit=1") {
        outgoing.writeHead(500);
        outgoing.end("boom");
        return;
      }
      if (incoming.method === "DELETE") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    const response = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
      }),
    );
    expect(response.status).toBe(503);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeDefined();
    expect(upstream.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("treats messages_too_large as has_messages", async () => {
    const f = fixture();
    const huge = "x".repeat(9 * 1024 * 1024);
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message?limit=1") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(
          `[{"info":{"id":"msg_1","role":"user"},"parts":[{"type":"text","text":"${huge}"}]}]`,
        );
        return;
      }
      if (incoming.method === "DELETE") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    const response = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ deleted: false, reason: "has_messages" });
    expect(upstream.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("rejects a traversal session id before any upstream or local cleanup", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => {
      json(outgoing, []);
    });
    useManager(f, upstream.endpoint);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: `/api/apps/storefront/sessions/${encodeURIComponent("../ses_1")}/delete-if-empty`,
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).code).toBe("invalid_session");
    expect(upstream.calls).toEqual([]);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeDefined();
  });

  it("cleans local rows and tolerates an already-deleted upstream session", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "DELETE" && incoming.url === "/session/ses_1") {
        outgoing.writeHead(404);
        outgoing.end("gone");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    insertPendingSend(f.db, {
      id: "pend_1",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_1",
      text: "x",
      now: new Date().toISOString(),
    });
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
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeUndefined();
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")).toEqual([]);
  });
});

describe("stage A text-only pending sends", () => {
  it("creates the pending row and deletes the draft in one locked transaction", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    f.db
      .prepare("INSERT INTO message_drafts (app_id, session_id, text, updated_at) VALUES (?,?,?,?)")
      .run("p1:storefront", "ses_1", "hello", new Date().toISOString());

    const response = await handleChat(f.deps, sendRequest(f));
    expect(response.status).toBe(202);
    const payload = JSON.parse(response.body) as { messageID: string };
    expect(readDraft(f.db, "p1:storefront", "ses_1")).toBeUndefined();
    const pending = readPendingSends(f.db, "p1:storefront", "ses_1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("sending");
    expect(pending[0]?.messageID).toBe(payload.messageID);
    expect(JSON.parse(upstream.calls[0]?.body ?? "").messageID).toBe(payload.messageID);
  });

  it("confirms a 202 only when the user message event arrives", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());

    const response = await handleChat(f.deps, sendRequest(f));
    const messageID = (JSON.parse(response.body) as { messageID: string }).messageID;
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")).toHaveLength(1);

    recovery.observe("p1:storefront", {
      type: "message.updated",
      sessionID: "ses_1",
      messageID,
      role: "user",
    });
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")).toEqual([]);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")?.hasMessages).toBe(1);
  });

  it("marks every sending row in a session unknown on session.error but ignores abort", async () => {
    const f = fixture();
    const recovery = recoveryFor(f, () => undefined);
    insertPendingSend(f.db, {
      id: "pend_1",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_1",
      text: "one",
      now: new Date().toISOString(),
    });
    insertPendingSend(f.db, {
      id: "pend_2",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_2",
      text: "two",
      now: new Date().toISOString(),
    });
    recovery.observe("p1:storefront", {
      type: "session.error",
      sessionID: "ses_1",
      name: "MessageAbortedError",
      message: "aborted",
    });
    expect(
      readPendingSends(f.db, "p1:storefront", "ses_1").every((row) => row.state === "sending"),
    ).toBe(true);

    recovery.observe("p1:storefront", {
      type: "session.error",
      sessionID: "ses_1",
      message: "boom",
    });
    expect(
      readPendingSends(f.db, "p1:storefront", "ses_1").every((row) => row.state === "unknown"),
    ).toBe(true);
  });

  it("marks a definite 404 failed and a transport failure unknown", async () => {
    const f = fixture();
    let mode: "404" | "destroy" = "404";
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (mode === "destroy") {
        incoming.socket.destroy();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    const first = await handleChat(f.deps, sendRequest(f, { body: JSON.stringify({ text: "a" }) }));
    expect(first.status).toBe(404);
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")[0]?.state).toBe("failed");

    mode = "destroy";
    const second = await handleChat(
      f.deps,
      sendRequest(f, { body: JSON.stringify({ text: "b" }) }),
    );
    expect(second.status).toBe(502);
    const rows = readPendingSends(f.db, "p1:storefront", "ses_1");
    expect(rows[1]?.state).toBe("unknown");
  });

  it("keeps the blocking {message} shape and confirms on success", async () => {
    const f = fixture();
    const message = {
      info: { id: "msg_1", role: "assistant" },
      parts: [{ type: "text", text: "ok" }],
    };
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/message") {
        json(outgoing, message);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    const response = await handleChat(
      f.deps,
      sendRequest(f, { query: { project: "p1" }, body: JSON.stringify({ text: "hello" }) }),
    );
    expect(response.status).toBe(200);
    const blocking = JSON.parse(response.body) as {
      messageID: string;
      userMessageID: string;
      info: unknown;
      parts: unknown;
    };
    expect(blocking.messageID).toBe(message.info.id);
    expect(blocking.userMessageID).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(blocking.info).toEqual(message.info);
    expect(blocking.parts).toEqual(message.parts);
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")).toEqual([]);
    const state = readSessionState(f.db, "p1:storefront", "ses_1");
    expect(state?.hasMessages).toBe(1);
  });
});

describe("stage A pending retry and dismiss", () => {
  function pendingRow(f: Fixture, overrides: { state: "unknown" | "failed" | "sending" }): string {
    insertPendingSend(f.db, {
      id: "pend_1",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_old",
      text: "retry me",
      now: new Date().toISOString(),
    });
    f.db.prepare("UPDATE pending_sends SET state = ? WHERE id = 'pend_1'").run(overrides.state);
    return "pend_1";
  }

  it("rejects a sending row with 409 without any upstream call", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => {
      json(outgoing, {});
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    pendingRow(f, { state: "sending" });
    const response = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/pending/pend_1/retry",
        body: "{}",
      }),
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).code).toBe("pending_in_flight");
    expect(upstream.calls).toEqual([]);
  });

  it("confirms a retried unknown row when the old message now exists", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message/msg_old") {
        json(outgoing, { info: { id: "msg_old", role: "user" }, parts: [] });
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    pendingRow(f, { state: "unknown" });
    const response = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/pending/pend_1/retry",
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ retried: false, confirmed: true });
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")).toEqual([]);
  });

  it("retries a definite-404 row with a new message id", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message/msg_old") {
        outgoing.writeHead(404);
        outgoing.end("absent");
        return;
      }
      if (incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1" });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    pendingRow(f, { state: "failed" });
    const response = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/pending/pend_1/retry",
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { retried: boolean; messageID: string };
    expect(payload.retried).toBe(true);
    expect(payload.messageID).toMatch(/^msg_[0-9a-f]{32}$/);
    const rows = readPendingSends(f.db, "p1:storefront", "ses_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageID).toBe(payload.messageID);
    expect(rows[0]?.state).toBe("sending");
  });

  it("returns 409 still_unknown for persistent 5xx and dispatches only with force", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message/msg_old") {
        outgoing.writeHead(503);
        outgoing.end("busy");
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    pendingRow(f, { state: "unknown" });
    const path = "/api/apps/storefront/sessions/ses_1/pending/pend_1/retry";
    const blocked = await handleChat(f.deps, draftRequest(f, { method: "POST", path, body: "{}" }));
    expect(blocked.status).toBe(409);
    expect(JSON.parse(blocked.body).code).toBe("still_unknown");

    const forced = await handleChat(
      f.deps,
      draftRequest(f, { method: "POST", path, body: JSON.stringify({ force: true }) }),
    );
    expect(forced.status).toBe(200);
    expect(JSON.parse(forced.body).retried).toBe(true);
  });

  it("dismisses an unknown row only after a definite 404, never when found", async () => {
    const f = fixture();
    let mode: "found" | "missing" = "found";
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message/msg_old") {
        if (mode === "found") {
          json(outgoing, { info: { id: "msg_old", role: "user" }, parts: [] });
          return;
        }
        outgoing.writeHead(404);
        outgoing.end("absent");
        return;
      }
      if (incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1" });
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    pendingRow(f, { state: "unknown" });
    const path = "/api/apps/storefront/sessions/ses_1/pending/pend_1";
    const confirmed = await handleChat(f.deps, draftRequest(f, { method: "DELETE", path }));
    expect(JSON.parse(confirmed.body)).toEqual({ dismissed: false, confirmed: true });

    insertPendingSend(f.db, {
      id: "pend_2",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_old",
      text: "retry me",
      now: new Date().toISOString(),
    });
    f.db.prepare("UPDATE pending_sends SET state = 'unknown' WHERE id = 'pend_2'").run();
    mode = "missing";
    const dismissed = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "DELETE",
        path: "/api/apps/storefront/sessions/ses_1/pending/pend_2",
      }),
    );
    expect(JSON.parse(dismissed.body)).toEqual({ dismissed: true });
    expect(readPendingSend(f.db, "p1:storefront", "ses_1", "pend_2")).toBeUndefined();
  });

  it("returns 202 when the recheck schedule exceeds the request deadline", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message/msg_old") {
        outgoing.writeHead(503);
        outgoing.end("busy");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = new PendingRecovery({
      db: f.db,
      endpointFor: () => upstream.endpoint,
      backoffMs: [0, 500],
      routeDeadlineMs: 50,
    });
    recoveries.push(recovery);
    useManager(f, upstream.endpoint, recovery);
    pendingRow(f, { state: "unknown" });
    const response = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/pending/pend_1/retry",
        body: "{}",
      }),
    );
    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ rechecking: true });
  });

  it("opens one shared fallback subscription that resolves a pending row from the event", async () => {
    const f = fixture();
    let eventCalls = 0;
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/event") {
        eventCalls += 1;
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        outgoing.write(
          `data: ${JSON.stringify({
            id: "evt_1",
            type: "message.updated",
            properties: {
              sessionID: "ses_1",
              info: { id: "msg_1", role: "user", sessionID: "ses_1" },
            },
          })}\n\n`,
        );
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    insertPendingSend(f.db, {
      id: "pend_1",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_1",
      text: "queued",
      now: new Date().toISOString(),
    });
    await recovery.ensureFallback("p1:storefront");
    await recovery.ensureFallback("p1:storefront");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (readPendingSends(f.db, "p1:storefront", "ses_1").length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")).toEqual([]);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")?.hasMessages).toBe(1);
    expect(eventCalls).toBe(1);
  });

  it("returns 409 for a dismiss 5xx unless force is set", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message/msg_old") {
        outgoing.writeHead(503);
        outgoing.end("busy");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    pendingRow(f, { state: "unknown" });
    const path = "/api/apps/storefront/sessions/ses_1/pending/pend_1";
    const blocked = await handleChat(
      f.deps,
      draftRequest(f, { method: "DELETE", path, body: "{}" }),
    );
    expect(blocked.status).toBe(409);
    expect(JSON.parse(blocked.body).code).toBe("still_unknown");

    const forced = await handleChat(
      f.deps,
      draftRequest(f, { method: "DELETE", path, body: JSON.stringify({ force: true }) }),
    );
    expect(forced.status).toBe(200);
    expect(JSON.parse(forced.body)).toEqual({ dismissed: true });
  });
});

describe("stage A confirmation and sweep", () => {
  it("transitions only stale sending rows to unknown on startup", () => {
    const f = fixture();
    const recovery = recoveryFor(f, () => undefined);
    insertPendingSend(f.db, {
      id: "pend_old",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_old",
      text: "old",
      now: "2026-10-01T00:00:00.000Z",
    });
    insertPendingSend(f.db, {
      id: "pend_new",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_new",
      text: "new",
      now: new Date().toISOString(),
    });
    const changed = recovery.transitionStaleSending(15 * 60 * 1000);
    expect(changed).toBe(1);
    expect(readPendingSend(f.db, "p1:storefront", "ses_1", "pend_old")?.state).toBe("unknown");
    expect(readPendingSend(f.db, "p1:storefront", "ses_1", "pend_new")?.state).toBe("sending");
  });

  it("sweeps a 7-day empty session and skips recent, active, drafted, and pending sessions", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url?.endsWith("/message?limit=1")) {
        emptyPage(outgoing);
        return;
      }
      if (incoming.method === "DELETE") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const now = Date.parse("2026-10-24T00:00:00.000Z");
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 60 * 60 * 1000).toISOString();
    for (const [sessionId, lastActivity] of [
      ["ses_old", old],
      ["ses_recent", recent],
      ["ses_active", old],
      ["ses_draft", old],
      ["ses_pending", old],
    ]) {
      insertEmptySessionState(f.db, "p1:storefront", sessionId, lastActivity);
    }
    f.db.prepare("UPDATE session_state SET has_messages = 1 WHERE session_id = 'ses_active'").run();
    f.db
      .prepare("INSERT INTO message_drafts (app_id, session_id, text, updated_at) VALUES (?,?,?,?)")
      .run("p1:storefront", "ses_draft", "text", old);
    insertPendingSend(f.db, {
      id: "pend_1",
      appId: "p1:storefront",
      sessionId: "ses_pending",
      messageID: "msg_1",
      text: "x",
      now: old,
    });
    const sweep = new ChatSweep({
      db: f.db,
      agentsHome: f.agentsHome,
      endpointFor: () => upstream.endpoint,
      now: () => now,
    });
    await sweep.runOnce();
    expect(readSessionState(f.db, "p1:storefront", "ses_old")).toBeUndefined();
    expect(readSessionState(f.db, "p1:storefront", "ses_recent")).toBeDefined();
    expect(readSessionState(f.db, "p1:storefront", "ses_active")).toBeDefined();
    expect(readSessionState(f.db, "p1:storefront", "ses_draft")).toBeDefined();
    expect(readSessionState(f.db, "p1:storefront", "ses_pending")).toBeDefined();
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /session/ses_old/message?limit=1",
      "DELETE /session/ses_old",
    ]);
  });

  it("skips a stopped app and a deleting app, and fails closed on 5xx", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url?.endsWith("/message?limit=1")) {
        outgoing.writeHead(500);
        outgoing.end("boom");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const now = Date.parse("2026-10-24T00:00:00.000Z");
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", old);
    insertEmptySessionState(f.db, "p1:storefront", "ses_2", old);

    const stopped = new ChatSweep({
      db: f.db,
      agentsHome: f.agentsHome,
      endpointFor: () => undefined,
      now: () => now,
    });
    await stopped.runOnce();
    expect(upstream.calls).toEqual([]);
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeDefined();

    const failing = new ChatSweep({
      db: f.db,
      agentsHome: f.agentsHome,
      endpointFor: () => upstream.endpoint,
      now: () => now,
    });
    await failing.runOnce();
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeDefined();
    expect(readSessionState(f.db, "p1:storefront", "ses_2")).toBeDefined();

    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p1:storefront'").run();
    await failing.runOnce();
    expect(readSessionState(f.db, "p1:storefront", "ses_1")).toBeDefined();
  });

  it("unblocks delete-if-empty after a dismissed pending row", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message?limit=1") {
        emptyPage(outgoing);
        return;
      }
      if (incoming.method === "DELETE" && incoming.url === "/session/ses_1") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      if (incoming.url === "/session/ses_1/message/msg_old") {
        outgoing.writeHead(404);
        outgoing.end("absent");
        return;
      }
      if (incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1" });
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    insertPendingSend(f.db, {
      id: "pend_1",
      appId: "p1:storefront",
      sessionId: "ses_1",
      messageID: "msg_old",
      text: "x",
      now: new Date().toISOString(),
    });
    f.db.prepare("UPDATE pending_sends SET state = 'unknown' WHERE id = 'pend_1'").run();
    const before = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
      }),
    );
    expect(JSON.parse(before.body)).toEqual({ deleted: false, reason: "pending" });

    await handleChat(
      f.deps,
      draftRequest(f, {
        method: "DELETE",
        path: "/api/apps/storefront/sessions/ses_1/pending/pend_1",
      }),
    );
    const after = await handleChat(
      f.deps,
      draftRequest(f, {
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
      }),
    );
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body)).toEqual({ deleted: true, upstream: true });
  });
});
