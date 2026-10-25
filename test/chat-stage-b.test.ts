import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { uploadCoordinator } from "../src/attachments/quota.js";
import { PendingRecovery } from "../src/chat/pending.js";
import {
  insertEmptySessionState,
  localSessionBlockReason,
  readDraft,
  readPendingSends,
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
  uploadCoordinator.resetForTests();
  for (const recovery of recoveries.splice(0)) recovery.dispose();
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
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-stage-b-"));
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
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p2','Beta','main',?,?,?)",
  ).run(path.join(dir, "project2"), now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p2:other','p2','other','apps/other','AGENTS.md',?)",
  ).run(now);
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentsHome = path.join(dir, "agents");
  mkdirSync(agentsHome, { recursive: true });
  const appRoot = path.join(agentsHome, "p1", "storefront");
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
      {
        id: "p2",
        name: "Beta",
        rootPath: path.join(dir, "project2"),
        workspaceRoot: dir,
        deleting: false,
        service: new CoordinatorService(db, "p2"),
      },
    ],
  };
  return { dir, db, deps, token, agentsHome, appRoot };
}

interface UpstreamCall {
  method: string;
  url: string;
  body: string;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function text(body: Buffer): string {
  return body.toString("utf8");
}

async function fakeOpencode(
  handler: (incoming: IncomingMessage, outgoing: ServerResponse, body: string) => void,
): Promise<{ endpoint: string; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = text(Buffer.concat(chunks));
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

function useManager(
  f: Fixture,
  endpoint: string | undefined,
  recovery?: PendingRecovery,
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
    attachmentsPathMode: () => "container",
    containerAgentsRoot: () => "/data/agents",
    attachmentVisibleRoot: () => path.join(f.agentsHome, "p1", "storefront", "attachments"),
    ...(recovery === undefined ? {} : { pendingRecovery: recovery }),
  } as unknown as InstanceManager;
  return state;
}

function recoveryFor(f: Fixture, endpoint: () => string | undefined): PendingRecovery {
  const recovery = new PendingRecovery({
    db: f.db,
    endpointFor: () => endpoint(),
    backoffMs: [0],
    routeDeadlineMs: 2_000,
  });
  recoveries.push(recovery);
  return recovery;
}

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/chat", headers: {}, query: {}, ...overrides };
}

async function startServer(f: Fixture): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createHttpServer(f.deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function dispositionHeader(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function upload(
  base: string,
  token: string,
  name: string,
  body: Uint8Array,
  options: {
    session?: string;
    project?: string;
    origin?: string;
    authorization?: string | null;
  } = {},
): Promise<Response> {
  const session = options.session ?? "ses_1";
  const project = options.project ?? "p1";
  const headers: Record<string, string> = {
    "content-disposition": dispositionHeader(name),
    "content-type": "application/octet-stream",
    ...(options.authorization === null
      ? {}
      : { authorization: `Bearer ${options.authorization ?? token}` }),
  };
  if (options.origin !== undefined) headers.origin = options.origin;
  return fetch(`${base}/api/apps/storefront/attachments?project=${project}&session=${session}`, {
    method: "POST",
    headers,
    body,
  });
}

function attachmentRow(f: Fixture, id: string) {
  return f.db
    .prepare(
      `SELECT id, state, rel_path AS relPath, temp_rel_path AS tempRelPath, mime, size, kind, mode
       FROM app_attachments WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        state: string;
        relPath: string | null;
        tempRelPath: string | null;
        mime: string;
        size: number;
        kind: string;
        mode: string;
      }
    | undefined;
}

function fileFor(f: Fixture, relPath: string): string {
  return path.join(f.appRoot, relPath);
}

function insertAvailable(
  f: Fixture,
  input: { id: string; size: number; relPath: string; name?: string },
): void {
  const now = new Date().toISOString();
  f.db
    .prepare(
      `INSERT INTO app_attachments
         (id, app_id, session_id, original_name, stored_name, rel_path, temp_rel_path, mime, size,
          declared_size, kind, mode, state, created_at, updated_at)
       VALUES (?, 'p1:storefront', 'ses_1', ?, ?, ?, NULL, 'text/plain', ?, NULL, 'file', 'auto',
               'available', ?, ?)`,
    )
    .run(
      input.id,
      input.name ?? "file.txt",
      path.posix.basename(input.relPath),
      input.relPath,
      input.size,
      now,
      now,
    );
}

function insertDelivery(
  f: Fixture,
  input: { id: string; attachmentId: string; messageId: string; state: string },
): void {
  const now = new Date().toISOString();
  f.db
    .prepare(
      `INSERT INTO attachment_deliveries
         (id, attachment_id, app_id, session_id, part_id, message_id, state, error_code, created_at, updated_at)
       VALUES (?, ?, 'p1:storefront', 'ses_1', NULL, ?, ?, NULL, ?, ?)`,
    )
    .run(input.id, input.attachmentId, input.messageId, input.state, now, now);
}

describe("attachment upload route", () => {
  it("rejects an unauthenticated or cross-site upload before storing a file", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => {
      json(outgoing, { id: "ses_1" });
    });
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const body = new TextEncoder().encode("hello");

    const unauth = await upload(base, f.token, "x.txt", body, { authorization: null });
    expect(unauth.status).toBe(401);
    const crossSite = await upload(base, f.token, "x.txt", body, { origin: "http://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(upstream.calls).toEqual([]);
    expect(
      (f.db.prepare("SELECT COUNT(*) AS count FROM app_attachments").get() as { count: number })
        .count,
    ).toBe(0);
  });

  it("rejects an over-cap Content-Length and a non-human principal", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const agent = createPrincipal(f.db, { kind: "agent", name: "bot" });

    const forbidden = await upload(base, f.token, "x.txt", new Uint8Array([1]), {
      authorization: agent.token,
    });
    expect(forbidden.status).toBe(403);

    const address = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${base}/api/apps/storefront/attachments?project=p1&session=ses_1`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            "content-disposition": dispositionHeader("big.bin"),
            "content-length": String(101 * 1024 * 1024),
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.on("error", (error) => {
        if (address.port !== 0) reject(error);
      });
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it("rejects an invalid session or missing filename before touching storage", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const invalidSession = await upload(base, f.token, "x.txt", new Uint8Array([1]), {
      session: "../ses_1",
    });
    expect(invalidSession.status).toBe(400);
    expect(await invalidSession.json()).toMatchObject({ code: "invalid_session" });
    const noName = await fetch(`${base}/api/apps/storefront/attachments?project=p1&session=ses_1`, {
      method: "POST",
      headers: { ...auth(f.token), "content-type": "application/octet-stream" },
      body: new Uint8Array([1]),
    });
    expect(noName.status).toBe(400);
    expect(await noName.json()).toMatchObject({ code: "invalid_filename" });
    expect(
      (f.db.prepare("SELECT COUNT(*) AS count FROM app_attachments").get() as { count: number })
        .count,
    ).toBe(0);
  });

  it("rejects an empty or oversized image upload and removes its temp file", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const empty = await upload(base, f.token, "empty.txt", new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: "empty_file" });

    const png = Buffer.alloc(26 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    const tooLarge = await upload(base, f.token, "big.png", png);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: "file_too_large" });
    expect(
      (f.db.prepare("SELECT COUNT(*) AS count FROM app_attachments").get() as { count: number })
        .count,
    ).toBe(0);
    const tmp = path.join(f.appRoot, "attachments", "ses_1", ".tmp");
    expect(existsSync(tmp) ? (await import("node:fs")).readdirSync(tmp).length === 0 : true).toBe(
      true,
    );
  });

  it("rejects a symlinked attachments root without writing outside the app state", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const outside = path.join(f.dir, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(f.appRoot, { recursive: true });
    (await import("node:fs")).symlinkSync(outside, path.join(f.appRoot, "attachments"));
    const { base } = await startServer(f);
    const response = await upload(base, f.token, "x.txt", new TextEncoder().encode("hello"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_session" });
    expect((await import("node:fs")).readdirSync(outside)).toEqual([]);
  });

  it("rejects a third concurrent upload with 429 and a full quota with 507", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    expect(uploadCoordinator.reserve("p1:storefront", 10).ok).toBe(true);
    expect(uploadCoordinator.reserve("p1:storefront", 10).ok).toBe(true);
    const busy = await upload(base, f.token, "x.txt", new TextEncoder().encode("x"));
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("2");
    uploadCoordinator.resetForTests();

    insertAvailable(f, {
      id: "att_full",
      size: 5 * 1024 * 1024 * 1024,
      relPath: "attachments/ses_1/att_full-f.txt",
    });
    const full = await upload(base, f.token, "x.txt", new TextEncoder().encode("x"));
    expect(full.status).toBe(507);
    expect(await full.json()).toMatchObject({ code: "attachment_quota_exceeded" });
  });

  it("recomputes the quota under the per-app lock so concurrent uploads cannot both win", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    insertAvailable(f, {
      id: "att_near",
      size: 5 * 1024 * 1024 * 1024 - 100,
      relPath: "attachments/ses_1/att_near-f.txt",
    });
    const body = new Uint8Array(60);
    const results = await Promise.all([
      upload(base, f.token, "a.bin", body),
      upload(base, f.token, "b.bin", body),
    ]);
    const statuses = results.map((result) => result.status).sort((left, right) => left - right);
    expect(statuses).toEqual([201, 507]);
    expect(
      (
        f.db
          .prepare("SELECT COUNT(*) AS count FROM app_attachments WHERE state = 'available'")
          .get() as { count: number }
      ).count,
    ).toBe(2);
  });

  it("streams to a temp file, commits metadata, and survives a reconcile", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const bytes = new TextEncoder().encode("%PDF-1.7\npayload");
    const response = await upload(base, f.token, "report.pdf", bytes);
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      attachment: {
        id: string;
        name: string;
        mime: string;
        kind: string;
        state: string;
        inline: boolean;
      };
      quota: { percent: number };
    };
    expect(payload.attachment).toMatchObject({
      name: "report.pdf",
      mime: "application/pdf",
      kind: "pdf",
      state: "draft",
      inline: false,
    });
    expect(payload.quota.percent).toBe(0);
    const row = attachmentRow(f, payload.attachment.id);
    expect(row?.state).toBe("available");
    expect(row?.tempRelPath).toBeNull();
    expect(row?.relPath).toBeTruthy();
    expect(existsSync(fileFor(f, row?.relPath ?? ""))).toBe(true);
    expect(existsSync(path.join(f.appRoot, "attachments/ses_1/.tmp"))).toBe(true);

    const { runAttachmentMaintenance } = await import("../src/attachments/reconcile.js");
    runAttachmentMaintenance(f.db, f.agentsHome, { startup: true });
    expect(attachmentRow(f, payload.attachment.id)?.state).toBe("available");
  });

  it("downloads with the stored MIME, inline only for safe images, and 404s a missing file", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const image = (await (await upload(base, f.token, "pic.png", png)).json()) as {
      attachment: { id: string };
    };
    const imageResponse = await fetch(
      `${base}/api/apps/storefront/attachments/${image.attachment.id}?project=p1`,
      { headers: auth(f.token) },
    );
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(imageResponse.headers.get("content-disposition")).toContain("inline");
    expect(imageResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(Buffer.from(png));

    const svg = (await (
      await upload(base, f.token, "x.svg", new TextEncoder().encode("<svg></svg>"))
    ).json()) as { attachment: { id: string } };
    const svgResponse = await fetch(
      `${base}/api/apps/storefront/attachments/${svg.attachment.id}?project=p1`,
      { headers: auth(f.token) },
    );
    expect(svgResponse.headers.get("content-disposition")).toContain("attachment");
    const crossApp = await fetch(
      `${base}/api/apps/other/attachments/${image.attachment.id}?project=p2`,
      { headers: auth(f.token) },
    );
    expect(crossApp.status).toBe(404);

    const row = attachmentRow(f, image.attachment.id);
    rmSync(fileFor(f, row?.relPath ?? ""));
    const missing = await fetch(
      `${base}/api/apps/storefront/attachments/${image.attachment.id}?project=p1`,
      { headers: auth(f.token) },
    );
    expect(missing.status).toBe(404);
    expect(attachmentRow(f, image.attachment.id)?.state).toBe("missing");
  });
});

describe("draft, patch, and delete", () => {
  it("returns draft attachments and a quota, rejects inline, and deletes a draft file", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session") {
        json(outgoing, [{ id: "ses_1", title: "One" }]);
        return;
      }
      json(outgoing, { id: "ses_1", title: "One" });
    });
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const payload = (await (
      await upload(base, f.token, "notes.txt", new TextEncoder().encode("hello"))
    ).json()) as { attachment: { id: string } };
    const id = payload.attachment.id;

    const draft = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/draft",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    const draftBody = JSON.parse(draft.body) as {
      attachments: Array<{ id: string; state: string }>;
      quota: { percent: number };
    };
    expect(draftBody.attachments).toMatchObject([{ id, state: "draft" }]);
    expect(draftBody.quota.percent).toBe(0);
    const list = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(
      (JSON.parse(list.body) as { sessions: Array<{ draft: { attachmentCount: number } }> })
        .sessions[0]?.draft.attachmentCount,
    ).toBe(1);

    const patchInline = await handleChat(
      f.deps,
      request({
        method: "PATCH",
        path: `/api/apps/storefront/attachments/${id}`,
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ mode: "inline" }),
      }),
    );
    expect(patchInline.status).toBe(400);
    expect(JSON.parse(patchInline.body).code).toBe("mode_not_supported");

    const patched = await handleChat(
      f.deps,
      request({
        method: "PATCH",
        path: `/api/apps/storefront/attachments/${id}`,
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ mode: "file" }),
      }),
    );
    expect(patched.status).toBe(200);
    expect(attachmentRow(f, id)?.mode).toBe("file");

    const row = attachmentRow(f, id);
    const deleted = await handleChat(
      f.deps,
      request({
        method: "DELETE",
        path: `/api/apps/storefront/attachments/${id}`,
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(deleted.status).toBe(200);
    expect(attachmentRow(f, id)).toBeUndefined();
    expect(existsSync(fileFor(f, row?.relPath ?? ""))).toBe(false);
  });

  it("blocks delete-if-empty for an uploading row, a draft attachment, and an in-flight delivery", async () => {
    const f = fixture();
    useManager(f, undefined);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());
    const now = new Date().toISOString();
    f.db
      .prepare(
        `INSERT INTO app_attachments
           (id, app_id, session_id, original_name, temp_rel_path, declared_size, mode, state, created_at, updated_at)
         VALUES ('att_up','p1:storefront','ses_1','x', 'attachments/ses_1/.tmp/att_up.part', 10, 'auto', 'uploading', ?, ?)`,
      )
      .run(now, now);
    expect(localSessionBlockReason(f.db, "p1:storefront", "ses_1")).toBe("uploading");

    f.db.prepare("DELETE FROM app_attachments").run();
    insertAvailable(f, {
      id: "att_draft",
      size: 10,
      relPath: "attachments/ses_1/att_draft-x.txt",
    });
    expect(localSessionBlockReason(f.db, "p1:storefront", "ses_1")).toBe("has_draft");

    insertDelivery(f, {
      id: "del_1",
      attachmentId: "att_draft",
      messageId: "msg_1",
      state: "sending",
    });
    expect(localSessionBlockReason(f.db, "p1:storefront", "ses_1")).toBe("in_flight");
  });

  it("keeps a sweep candidate that still has a draft attachment", async () => {
    const f = fixture();
    let deleted = false;
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1/message?limit=1") {
        json(outgoing, []);
        return;
      }
      if (incoming.method === "DELETE") {
        deleted = true;
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", "2020-01-01T00:00:00.000Z");
    insertAvailable(f, {
      id: "att_draft",
      size: 1,
      relPath: "attachments/ses_1/att_draft-x.txt",
    });
    mkdirSync(path.join(f.appRoot, "attachments", "ses_1"), { recursive: true });
    writeFileSync(fileFor(f, "attachments/ses_1/att_draft-x.txt"), "x");
    const sweep = new ChatSweep({
      db: f.db,
      agentsHome: f.agentsHome,
      endpointFor: () => upstream.endpoint,
      now: () => Date.parse("2026-10-25T00:00:00.000Z"),
    });
    await sweep.runOnce();
    expect(deleted).toBe(false);
    expect(attachmentRow(f, "att_draft")?.state).toBe("available");
  });

  it("removes attachment rows and the session folder on manual delete", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "DELETE") {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      json(outgoing, { id: "ses_1" });
    });
    useManager(f, upstream.endpoint);
    const folder = path.join(f.appRoot, "attachments", "ses_1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "orphan.txt"), "x");
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
    expect(existsSync(folder)).toBe(false);
    expect(
      (f.db.prepare("SELECT COUNT(*) AS count FROM app_attachments").get() as { count: number })
        .count,
    ).toBe(0);
  });
});

describe("attachment sends", () => {
  it("sends an attachment-only message with a synthetic manifest and confirms the delivery", async () => {
    const f = fixture();
    let sentBody = "";
    const upstream = await fakeOpencode((incoming, outgoing, body) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title: "Existing session" });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        sentBody = body;
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      if (incoming.method === "GET" && incoming.url?.startsWith("/session/ses_1/message")) {
        const messageID = (JSON.parse(sentBody) as { messageID: string }).messageID;
        json(outgoing, [
          { info: { id: messageID, role: "user" }, parts: [{ type: "text", text: "manifest" }] },
        ]);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const recovery = recoveryFor(f, () => upstream.endpoint);
    useManager(f, upstream.endpoint, recovery);
    const { base } = await startServer(f);
    const uploaded = (await (
      await upload(base, f.token, "data.csv", new TextEncoder().encode("a,b\n1,2\n"))
    ).json()) as { attachment: { id: string } };
    const attachmentId = uploaded.attachment.id;
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());

    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ attachments: [{ id: attachmentId }] }),
      }),
    );
    expect(response.status).toBe(202);
    const payload = JSON.parse(response.body) as { messageID: string };
    const upstreamBody = JSON.parse(sentBody) as {
      messageID: string;
      parts: Array<{
        type: string;
        synthetic?: boolean;
        metadata?: { hanse?: string };
        text?: string;
      }>;
    };
    expect(upstreamBody.messageID).toBe(payload.messageID);
    expect(upstreamBody.parts).toHaveLength(1);
    expect(upstreamBody.parts[0]?.metadata?.hanse).toBe("attachment-manifest");
    expect(upstreamBody.parts[0]?.text).toContain(
      path.join(f.agentsHome, "p1", "storefront", "attachments", "ses_1"),
    );
    expect(upstreamBody.parts[0]?.text).toContain("text/csv");
    expect(upstreamBody.parts[0]?.text).toContain(", file)");
    expect(upstreamBody.parts.some((part) => part.type === "file")).toBe(false);
    expect(readDraft(f.db, "p1:storefront", "ses_1")).toBeUndefined();
    const pending = readPendingSends(f.db, "p1:storefront", "ses_1");
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]?.attachmentsJson ?? "[]")).toEqual([{ id: attachmentId }]);
    const draftWithPending = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/draft",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(
      (
        JSON.parse(draftWithPending.body) as {
          pendingSends: Array<{ attachments: unknown[]; attachmentIDs: string[] }>;
        }
      ).pendingSends[0],
    ).toMatchObject({ attachments: [{ id: attachmentId }], attachmentIDs: [attachmentId] });
    expect(
      (
        f.db
          .prepare("SELECT state FROM attachment_deliveries WHERE message_id = ?")
          .get(payload.messageID) as { state: string }
      ).state,
    ).toBe("sending");

    recovery.observe("p1:storefront", {
      type: "message.updated",
      sessionID: "ses_1",
      messageID: payload.messageID,
      role: "user",
    });
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")).toEqual([]);
    expect(
      (
        f.db
          .prepare("SELECT state FROM attachment_deliveries WHERE message_id = ?")
          .get(payload.messageID) as { state: string }
      ).state,
    ).toBe("sent");

    const history = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    const messages = JSON.parse(history.body).messages as Array<{
      info: { hanse?: { attachments?: Array<{ id: string; state: string; downloadURL: string }> } };
      parts: Array<{ url?: string }>;
    }>;
    expect(messages[0]?.info.hanse?.attachments).toMatchObject([
      { id: attachmentId, state: "sent" },
    ]);
    expect(messages[0]?.info.hanse?.attachments?.[0]?.downloadURL).toContain(
      `/api/apps/storefront/attachments/${attachmentId}`,
    );
  });

  it("keeps an ambiguous dispatch delivery unknown instead of failed", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title: "Existing" });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(
      f,
      upstream.endpoint,
      recoveryFor(f, () => upstream.endpoint),
    );
    const { base } = await startServer(f);
    const uploaded = (await (
      await upload(base, f.token, "x.txt", new TextEncoder().encode("hello"))
    ).json()) as { attachment: { id: string } };
    insertEmptySessionState(f.db, "p1:storefront", "ses_1", new Date().toISOString());

    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ attachments: [{ id: uploaded.attachment.id }] }),
      }),
    );
    expect(response.status).toBe(502);
    expect((JSON.parse(response.body) as { outcome: string }).outcome).toBe("unknown");
    const pending = readPendingSends(f.db, "p1:storefront", "ses_1");
    expect(pending[0]?.state).toBe("unknown");
    expect(
      (
        f.db
          .prepare("SELECT state FROM attachment_deliveries WHERE attachment_id = ?")
          .get(uploaded.attachment.id) as { state: string }
      ).state,
    ).toBe("unknown");
  });

  it("fails a missing file before dispatch and rejects cross-session ids", async () => {
    const f = fixture();
    const calls: string[] = [];
    const upstream = await fakeOpencode((incoming, outgoing) => {
      calls.push(`${incoming.method} ${incoming.url}`);
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title: "Existing" });
        return;
      }
      if (incoming.method === "GET" && incoming.url === "/session/ses_2") {
        json(outgoing, { id: "ses_2", title: "Other" });
        return;
      }
      if (incoming.method === "POST" && incoming.url?.endsWith("/prompt_async")) {
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const uploaded = (await (
      await upload(base, f.token, "x.txt", new TextEncoder().encode("hello"))
    ).json()) as { attachment: { id: string } };
    const row = attachmentRow(f, uploaded.attachment.id);
    rmSync(fileFor(f, row?.relPath ?? ""));

    const missing = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ attachments: [{ id: uploaded.attachment.id }] }),
      }),
    );
    expect(missing.status).toBe(409);
    expect(JSON.parse(missing.body).code).toBe("attachment_missing");
    expect(calls.some((call) => call.endsWith("/prompt_async"))).toBe(false);
    expect(readPendingSends(f.db, "p1:storefront", "ses_1")).toEqual([]);

    // A file-only row in ses_1 is invisible to a ses_2 send.
    insertAvailable(f, {
      id: "att_other",
      size: 1,
      relPath: "attachments/ses_1/att_other-x.txt",
    });
    writeFileSync(fileFor(f, "attachments/ses_1/att_other-x.txt"), "x");
    const crossSession = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_2/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ attachments: [{ id: "att_other" }] }),
      }),
    );
    expect(crossSession.status).toBe(404);
    expect(JSON.parse(crossSession.body).code).toBe("attachment_not_found");
  });

  it("patches a default title before dispatch and fails closed with title_required", async () => {
    const f = fixture();
    let title = "New session - 2026-10-25T00:00:00.000Z";
    let patchFails = false;
    const calls: string[] = [];
    const upstream = await fakeOpencode((incoming, outgoing, body) => {
      calls.push(`${incoming.method} ${incoming.url}`);
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title });
        return;
      }
      if (incoming.method === "PATCH" && incoming.url === "/session/ses_1") {
        if (patchFails) {
          outgoing.writeHead(500);
          outgoing.end("boom");
          return;
        }
        title = (JSON.parse(body) as { title: string }).title;
        json(outgoing, { id: "ses_1", title });
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
    const { base } = await startServer(f);
    const uploaded = (await (
      await upload(base, f.token, "x.txt", new TextEncoder().encode("hello"))
    ).json()) as { attachment: { id: string } };
    f.db
      .prepare("INSERT INTO message_drafts (app_id, session_id, text, updated_at) VALUES (?,?,?,?)")
      .run("p1:storefront", "ses_1", "keep me", new Date().toISOString());

    const sent = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({
          text: "Look at this",
          attachments: [{ id: uploaded.attachment.id }],
        }),
      }),
    );
    expect(sent.status).toBe(202);
    expect(title).toBe("Look at this");
    expect(calls.indexOf("PATCH /session/ses_1")).toBeLessThan(
      calls.indexOf("POST /session/ses_1/prompt_async"),
    );

    title = "New session - 2026-10-26T00:00:00.000Z";
    patchFails = true;
    const failed = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ attachments: [{ id: uploaded.attachment.id }] }),
      }),
    );
    expect(failed.status).toBe(409);
    expect(JSON.parse(failed.body).code).toBe("title_required");
    expect(calls.filter((call) => call === "POST /session/ses_1/prompt_async")).toHaveLength(1);
  });

  it("requires a mode to redeliver a sent attachment and keeps the old attempt unchanged", async () => {
    const f = fixture();
    const promptCalls: string[] = [];
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title: "Existing" });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        promptCalls.push(incoming.method);
        outgoing.writeHead(204);
        outgoing.end();
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const uploaded = (await (
      await upload(base, f.token, "x.txt", new TextEncoder().encode("hello"))
    ).json()) as { attachment: { id: string } };
    insertDelivery(f, {
      id: "del_sent",
      attachmentId: uploaded.attachment.id,
      messageId: "msg_old",
      state: "sent",
    });
    const noMode = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ attachments: [{ id: uploaded.attachment.id }] }),
      }),
    );
    expect(noMode.status).toBe(409);
    expect(JSON.parse(noMode.body).code).toBe("attachment_sent");
    expect(promptCalls).toHaveLength(0);

    const redelivered = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ attachments: [{ id: uploaded.attachment.id, mode: "file" }] }),
      }),
    );
    expect(redelivered.status).toBe(202);
    const states = f.db
      .prepare(
        "SELECT message_id AS messageId, state FROM attachment_deliveries ORDER BY created_at, id",
      )
      .all() as Array<{ messageId: string; state: string }>;
    expect(states).toContainEqual({ messageId: "msg_old", state: "sent" });
    expect(states.some((row) => row.messageId !== "msg_old" && row.state === "sending")).toBe(true);
  });

  it("does not serve a stored rel_path that escapes the app root", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((_incoming, outgoing) => json(outgoing, { id: "ses_1" }));
    useManager(f, upstream.endpoint);
    const outside = path.join(f.dir, "escape.txt");
    writeFileSync(outside, "secret");
    insertAvailable(f, {
      id: "att_escape",
      size: 6,
      relPath: "../escape.txt",
    });
    const { base } = await startServer(f);
    const response = await fetch(`${base}/api/apps/storefront/attachments/att_escape?project=p1`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  it("passes the generated user message id on the blocking route too", async () => {
    const f = fixture();
    let sentBody = "";
    const message = {
      info: { id: "msg_assistant", role: "assistant" },
      parts: [{ type: "text", text: "ok" }],
    };
    const upstream = await fakeOpencode((incoming, outgoing, body) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1") {
        json(outgoing, { id: "ses_1", title: "Existing" });
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/message") {
        sentBody = body;
        json(outgoing, message);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    const { base } = await startServer(f);
    const uploaded = (await (
      await upload(base, f.token, "x.txt", new TextEncoder().encode("hello"))
    ).json()) as { attachment: { id: string } };
    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1" },
        headers: auth(f.token),
        body: JSON.stringify({ text: "hi", attachments: [{ id: uploaded.attachment.id }] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(sentBody).messageID).toBeTruthy();
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
  });

  it("strips any data: URL from history and adds no base64 for file-only sends", async () => {
    const f = fixture();
    const upstream = await fakeOpencode((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/message") {
        json(outgoing, [
          {
            info: { id: "msg_1", role: "assistant" },
            parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }],
          },
        ]);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useManager(f, upstream.endpoint);
    insertAvailable(f, {
      id: "att_1",
      size: 1,
      relPath: "attachments/ses_1/att_1-x.txt",
    });
    insertDelivery(f, { id: "del_1", attachmentId: "att_1", messageId: "msg_1", state: "sent" });
    const response = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.body).not.toContain("data:");
    const body = JSON.parse(response.body) as {
      messages: Array<{
        parts: Array<{ url?: string; truncated?: boolean }>;
        info: { hanse?: { attachments?: unknown[] } };
      }>;
    };
    expect(body.messages[0]?.parts[0]?.url).toBe("");
    expect(body.messages[0]?.parts[0]?.truncated).toBe(true);
    expect(body.messages[0]?.info.hanse?.attachments).toHaveLength(1);
  });
});
