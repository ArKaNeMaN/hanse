import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectedPage } from "../src/attachments/history.js";
import { defaultMessageProjector } from "../src/attachments/projection.js";
import { appStreams } from "../src/attachments/streams.js";
import { insertEmptySessionState } from "../src/chat/state.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleChat } from "../src/http/chat.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { streamAppEvents } from "../src/http/prompts.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  appStreams.resetForTests();
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

interface Fixture {
  dir: string;
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
  agentsHome: string;
  appRoot: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-stage-c-"));
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
  const appRoot = path.join(agentsHome, "p1", "storefront");
  mkdirSync(appRoot, { recursive: true });
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
  return { dir, db, deps, token, agentsHome, appRoot };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface UpstreamCall {
  method: string;
  url: string;
  body: string;
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

function useManager(f: Fixture, endpoint: string | undefined): void {
  f.deps.manager = {
    ensure: async () => {
      if (endpoint === undefined) throw new Error("agent is stopped");
      return endpoint;
    },
    endpointFor: () => endpoint,
    monitorState: () => "disabled",
    armPendingConfirmation: () => undefined,
    preparePendingConfirmation: async () => undefined,
    startChatMaintenance: () => undefined,
    attachmentsPathMode: () => "container",
    containerAgentsRoot: () => "/data/agents",
    attachmentVisibleRoot: () => path.join(f.agentsHome, "p1", "storefront", "attachments"),
  } as unknown as InstanceManager;
}

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/chat", headers: {}, query: {}, ...overrides };
}

function catalog(input: {
  image?: boolean;
  pdf?: boolean;
  attachment?: boolean;
  limit?: { context?: number; input?: number };
}): unknown {
  return {
    providers: [
      {
        id: "deepseek",
        models: {
          "deepseek-flash": {
            capabilities: {
              input: { image: input.image, pdf: input.pdf },
              attachment: input.attachment,
            },
            limit: input.limit,
          },
        },
      },
    ],
  };
}

function insertAttachment(
  f: Fixture,
  input: {
    id: string;
    kind: "image" | "pdf" | "file";
    mime: string;
    size: number;
    mode?: string;
  },
): void {
  const now = new Date().toISOString();
  const storedName = `${input.id}-file`;
  const relPath = `attachments/ses_1/${storedName}`;
  const file = path.join(f.appRoot, relPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(input.size, 1));
  f.db
    .prepare(
      `INSERT INTO app_attachments
         (id, app_id, session_id, original_name, stored_name, rel_path, temp_rel_path, mime, size,
          declared_size, kind, mode, state, created_at, updated_at)
       VALUES (?, 'p1:storefront', 'ses_1', ?, ?, ?, NULL, ?, ?, NULL, ?, ?, 'available', ?, ?)`,
    )
    .run(
      input.id,
      input.kind === "image" ? "photo.png" : "doc.pdf",
      storedName,
      relPath,
      input.mime,
      input.size,
      input.kind,
      input.mode ?? "auto",
      now,
      now,
    );
}

function insertDelivery(
  f: Fixture,
  input: {
    id: string;
    attachmentId: string;
    partId: string | null;
    messageId: string;
    state?: string;
  },
): void {
  const now = new Date().toISOString();
  f.db
    .prepare(
      `INSERT INTO attachment_deliveries
         (id, attachment_id, app_id, session_id, part_id, message_id, state, error_code,
          created_at, updated_at)
       VALUES (?, ?, 'p1:storefront', 'ses_1', ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.attachmentId,
      input.partId,
      input.messageId,
      input.state ?? "sent",
      now,
      now,
    );
}

function parseBody(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

function partsOf(body: string): Array<Record<string, unknown>> {
  const parsed = parseBody(body);
  return Array.isArray(parsed.parts) ? (parsed.parts as Array<Record<string, unknown>>) : [];
}

describe("capability-gated inline send", () => {
  it("sends an inline image as a file part with a unique id and a synthetic manifest", async () => {
    const f = fixture();
    insertAttachment(f, {
      id: "att_img",
      kind: "image",
      mime: "image/png",
      size: 100,
    });
    const upstream = await fakeOpencode((incoming, outgoing, body) => {
      if (incoming.method === "GET" && incoming.url === "/config/providers") {
        json(outgoing, catalog({ image: true, attachment: true }));
        return;
      }
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title: "Existing" });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        expect(body).not.toContain("data:");
        const parts = partsOf(body);
        expect(parts[0]).toEqual({ type: "text", text: "look" });
        expect(parts[1]).toMatchObject({
          type: "text",
          synthetic: true,
          metadata: { hanse: "attachment-manifest" },
        });
        expect(String(parts[1]?.text)).toContain("inline");
        const file = parts[2];
        expect(file).toMatchObject({ type: "file", mime: "image/png", filename: "photo.png" });
        expect(String(file?.id)).toMatch(/^prt_att_att_img_del_[0-9a-f]+$/);
        expect(String(file?.url)).toMatch(/^file:\/\//);
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
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ text: "look", attachments: [{ id: "att_img" }] }),
      }),
    );
    expect(response.status).toBe(202);
    const payload = JSON.parse(response.body) as { messageID: string; accepted: boolean };
    expect(payload.accepted).toBe(true);
    expect(payload.messageID).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(response.body).not.toContain("data:");
    const delivery = f.db
      .prepare(
        "SELECT part_id AS partId, state FROM attachment_deliveries WHERE attachment_id = 'att_img'",
      )
      .get() as { partId: string; state: string };
    expect(delivery.partId).toMatch(/^prt_att_att_img_del_/);
    expect(delivery.state).toBe("sending");
  });

  it("falls back to file with a warning for unsupported and unknown capabilities", async () => {
    for (const mode of ["unsupported", "unknown"] as const) {
      const f = fixture();
      insertAttachment(f, { id: "att_img", kind: "image", mime: "image/png", size: 100 });
      let catalogCalls = 0;
      const upstream = await fakeOpencode((incoming, outgoing) => {
        if (incoming.method === "GET" && incoming.url === "/config/providers") {
          catalogCalls += 1;
          if (mode === "unsupported") {
            json(outgoing, catalog({ image: false, attachment: true }));
          } else {
            outgoing.writeHead(500);
            outgoing.end("offline");
          }
          return;
        }
        if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
          json(outgoing, { id: "ses_1", title: "Existing" });
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
      const response = await handleChat(
        f.deps,
        request({
          method: "POST",
          path: "/api/apps/storefront/sessions/ses_1/messages",
          query: { project: "p1", async: "1" },
          headers: auth(f.token),
          body: JSON.stringify({ text: "", attachments: [{ id: "att_img" }] }),
        }),
      );
      expect(response.status).toBe(202);
      const payload = JSON.parse(response.body) as { warnings?: string[] };
      expect(payload.warnings).toContain(
        mode === "unsupported" ? "attachment_inline_unsupported" : "attachment_capability_unknown",
      );
      if (mode === "unknown") expect(catalogCalls).toBe(2);
      const sent = upstream.calls.find((call) => call.url === "/session/ses_1/prompt_async");
      const parts = partsOf(sent?.body ?? "{}");
      expect(parts.some((part) => part.type === "file")).toBe(false);
      const manifest = parts.find((part) => part.synthetic === true);
      expect(String(manifest?.text)).toContain("file");
      const delivery = f.db
        .prepare(
          "SELECT part_id AS partId FROM attachment_deliveries WHERE attachment_id = 'att_img'",
        )
        .get() as { partId: string | null };
      expect(delivery.partId).toBeNull();
    }
  });

  it("adds the context advisory without blocking the send", async () => {
    const f = fixture();
    insertAttachment(f, { id: "att_pdf", kind: "pdf", mime: "application/pdf", size: 1024 });
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/config/providers") {
        json(outgoing, catalog({ pdf: true, attachment: true, limit: { input: 10 } }));
        return;
      }
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title: "Existing" });
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
    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ text: "pdf", attachments: [{ id: "att_pdf" }] }),
      }),
    );
    expect(response.status).toBe(202);
    expect((JSON.parse(response.body) as { warnings?: string[] }).warnings).toContain(
      "attachment_context_large",
    );
  });
});

describe("retry and redelivery", () => {
  it("replays the stored inline mode with a new part id and fails only the old attempt", async () => {
    const f = fixture();
    insertAttachment(f, { id: "att_img", kind: "image", mime: "image/png", size: 100 });
    insertDelivery(f, {
      id: "del_old",
      attachmentId: "att_img",
      partId: "prt_old_attempt",
      messageId: "msg_old",
      state: "unknown",
    });
    const now = new Date().toISOString();
    f.db
      .prepare(
        `INSERT INTO pending_sends
           (id, app_id, session_id, message_id, text, attachments_json, state, error_code,
            created_at, updated_at)
         VALUES ('pend_1', 'p1:storefront', 'ses_1', 'msg_old', 'look',
                 '[{"id":"att_img","mode":"inline"}]', 'unknown', 'confirmation_unknown', ?, ?)`,
      )
      .run(now, now);
    const upstream = await fakeOpencode((incoming, outgoing, body) => {
      if (incoming.method === "GET" && incoming.url === "/config/providers") {
        json(outgoing, catalog({ image: true, attachment: true }));
        return;
      }
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title: "Existing" });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        const parts = partsOf(body);
        const file = parts.find((part) => part.type === "file");
        expect(String(file?.id)).toMatch(/^prt_att_att_img_del_/);
        expect(String(file?.id)).not.toBe("prt_old_attempt");
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    f.deps.manager = {
      ...(f.deps.manager as unknown as Record<string, unknown>),
      pendingRecovery: {
        recheck: async () => "unknown",
        recheckOnce: async () => "unknown",
        sessionMissing: async () => false,
      },
    } as unknown as InstanceManager;

    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/pending/pend_1/retry",
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ force: true }),
      }),
    );
    expect(response.status).toBe(200);
    const old = f.db
      .prepare("SELECT state FROM attachment_deliveries WHERE id = 'del_old'")
      .get() as { state: string };
    expect(old.state).toBe("failed");
    const created = f.db
      .prepare(
        "SELECT part_id AS partId, state, message_id AS messageId FROM attachment_deliveries WHERE id != 'del_old'",
      )
      .get() as { partId: string; state: string; messageId: string };
    expect(created.partId).toMatch(/^prt_att_att_img_del_/);
    expect(created.state).toBe("sending");
    expect(created.messageId).not.toBe("msg_old");
    expect((JSON.parse(response.body) as { retried: boolean }).retried).toBe(true);
  });
});

describe("blocking response projection", () => {
  it("returns the assistant message with ids, info, and projected parts", async () => {
    const f = fixture();
    const message = {
      info: {
        id: "msg_assistant",
        role: "assistant",
        sessionID: "ses_1",
        time: { created: 1, completed: 2 },
      },
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
    useManager(f, upstream.endpoint);
    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      messageID: string;
      userMessageID: string;
      info: unknown;
      parts: unknown;
    };
    expect(payload.messageID).toBe("msg_assistant");
    expect(payload.userMessageID).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(payload.info).toEqual(message.info);
    expect(payload.parts).toEqual(message.parts);
  });

  it("returns the safe truncated shape when the projected response exceeds 8 MiB", async () => {
    const f = fixture();
    const message = {
      info: { id: "msg_assistant", role: "assistant", sessionID: "ses_1" },
      parts: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
    };
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/message") {
        json(outgoing, message);
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
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      messageID: "msg_assistant",
      userMessageID: expect.stringMatching(/^msg_/),
      info: null,
      truncated: true,
    });
  });
});

describe("projected history", () => {
  it("rewrites a known file part and strips an unknown data URL", async () => {
    const f = fixture();
    insertAttachment(f, { id: "att_img", kind: "image", mime: "image/png", size: 42 });
    insertDelivery(f, {
      id: "del_1",
      attachmentId: "att_img",
      partId: "prt_att_att_img_del_1",
      messageId: "msg_1",
    });
    const messages = [
      {
        info: { id: "msg_1", role: "user" },
        parts: [
          { type: "file", id: "prt_att_att_img_del_1", url: "data:image/png;base64,AAAA" },
          { type: "file", id: "prt_other", url: `data:application/pdf;base64,${"A".repeat(100)}` },
        ],
      },
    ];
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1/message?limit=30") {
        json(outgoing, messages);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    const response = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", limit: "30" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).not.toContain("data:");
    const body = JSON.parse(response.body) as {
      messages: Array<{ info: { hanse?: { attachments: unknown[] } }; parts: unknown[] }>;
    };
    const message = body.messages[0];
    if (message === undefined) throw new Error("missing projected message");
    expect(message.parts[0]).toMatchObject({
      url: "/api/apps/storefront/attachments/att_img?project=p1",
      attachment: { id: "att_img" },
    });
    expect(message.parts[1]).toMatchObject({ url: "", truncated: true });
    expect(message.info.hanse?.attachments).toHaveLength(1);
  });

  it("falls back to single-message pages when a page exceeds the 48 MiB raw cap", async () => {
    const big = `{"messages":[],"pad":"${"x".repeat(49 * 1024 * 1024)}"}`;
    const one = [{ info: { id: "msg_old", role: "user" }, parts: [] }];
    const upstream = await fakeOpencode((incoming, outgoing) => {
      const url = incoming.url ?? "";
      if (url.startsWith("/session/ses_1/message?limit=2")) {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(big);
        return;
      }
      if (url.startsWith("/session/ses_1/message?limit=1")) {
        json(outgoing, one);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const page = await readProjectedPage(upstream.endpoint, "ses_1", {
      limit: 2,
      project: defaultMessageProjector,
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.info.id).toBe("msg_old");
  });
});

describe("app stream budget", () => {
  it("returns 429 stream_limit for the ninth browser stream", async () => {
    const f = fixture();
    useManager(f, "http://127.0.0.1:1");
    const releases = Array.from({ length: 8 }, () => appStreams.acquireBrowser("p1:storefront"));
    expect(releases.every((release) => typeof release === "function")).toBe(true);
    const written: { status?: number; body?: string } = {};
    const response = {
      writeHead(status: number) {
        written.status = status;
        return response;
      },
      end(body?: string) {
        written.body = body;
      },
      on() {},
      once() {},
      destroyed: false,
      writableEnded: false,
    };
    await streamAppEvents(
      f.deps,
      request({
        path: "/api/apps/storefront/events",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
      response as never,
    );
    expect(written.status).toBe(429);
    expect(JSON.parse(written.body ?? "{}")).toMatchObject({ code: "stream_limit" });
    for (const release of releases) release?.();
  });
});

describe("legacy session stream", () => {
  it("is human-only and forwards a projected raw envelope with no data URL", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/event") {
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        outgoing.end(
          `data: ${JSON.stringify({
            type: "message.part.updated",
            properties: {
              part: {
                id: "prt_att_att_img_del_1",
                type: "file",
                mime: "image/png",
                url: "data:image/png;base64,AAAA",
              },
            },
          })}\n\n`,
        );
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    insertAttachment(f, { id: "att_img", kind: "image", mime: "image/png", size: 42 });
    insertDelivery(f, {
      id: "del_1",
      attachmentId: "att_img",
      partId: "prt_att_att_img_del_1",
      messageId: "msg_1",
    });
    useManager(f, upstream.endpoint);
    f.deps.manager = {
      ...(f.deps.manager as unknown as Record<string, unknown>),
      attachmentsPathMode: () => "container",
      attachmentVisibleRoot: () => path.join(f.agentsHome, "p1", "storefront", "attachments"),
    } as unknown as InstanceManager;
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const agent = createPrincipal(f.db, { kind: "agent", name: "bot" }).token;
    const forbidden = await fetch(`${base}/api/apps/storefront/sessions/ses_1/events?project=p1`, {
      headers: auth(agent),
    });
    expect(forbidden.status).toBe(403);
    await forbidden.body?.cancel();

    const response = await fetch(`${base}/api/apps/storefront/sessions/ses_1/events?project=p1`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("data:image");
    expect(text).toContain("/api/apps/storefront/attachments/att_img?project=p1");
  });
});
