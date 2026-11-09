import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allocateView, extractToolView } from "../assets/chat-diff.js";
import {
  isHighlightEligible,
  mountToolView,
  reservationFits,
  reservationUnits,
} from "../assets/chat-highlight.js";
import { DeploymentInProgressError } from "../src/coordinator/deployment-lock.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import {
  handleChat,
  resetTurnSnapshotCacheForTests,
  streamSessionEvents,
} from "../src/http/chat.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { DefaultImageUnavailableError, ImageNotReadyError } from "../src/images/service.js";
import {
  AgentStartingError,
  AgentTokenReconcileError,
  DeletionPendingError,
  type InstanceManager,
} from "../src/opencode/manager.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { assistantMessage, textPart, userMessage } from "./fixtures/chat-turn.js";
import { imageStateView } from "./fixtures/image-state.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  resetTurnSnapshotCacheForTests();
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
  settings: SettingsService;
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
  const settings = new SettingsService({ db, secretKey: randomBytes(32) });
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    settings,
    getProjects: () =>
      (
        db
          .prepare("SELECT id, name, root_path, deleting FROM projects ORDER BY rowid")
          .all() as Array<{
          id: string;
          name: string;
          root_path: string;
          deleting: number;
        }>
      ).map((row) => ({
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        workspaceRoot: "/tmp",
        deleting: row.deleting === 1,
        service: new CoordinatorService(db, row.id),
      })),
  };
  return { db, deps, token, settings };
}

class FakeNode {
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent = "";
  className = "";
  title = "";
  tabIndex = -1;

  constructor(public tagName: string) {}

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

function fakeDocument(): { createElement: (tag: string) => FakeNode; activeElement: null } {
  return { createElement: (tag: string) => new FakeNode(tag), activeElement: null };
}

function fakeText(node: FakeNode): string {
  const own = node.children.length === 0 ? node.textContent : "";
  return [own, ...node.children.map((child) => fakeText(child))].join("\n");
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-hanse-ui-version": "2" };
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

async function fakeOpencodeHandler(
  handler: (incoming: IncomingMessage, outgoing: ServerResponse, body: string) => void,
): Promise<{ endpoint: string; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        body,
      });
      handler(incoming, outgoing, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}`, calls };
}

function noContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

function createSessionFolder(agentsHome: string, sessionId: string): string {
  const folder = path.join(agentsHome, "p1", "storefront", "attachments", sessionId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "note.txt"), sessionId, "utf8");
  return folder;
}

function seedSessionChatRows(db: SqliteDatabase, sessionId: string): void {
  const now = new Date().toISOString();
  const appId = "p1:storefront";
  db.prepare(
    "INSERT INTO message_drafts (app_id, session_id, text, updated_at) VALUES (?, ?, ?, ?)",
  ).run(appId, sessionId, `draft-${sessionId}`, now);
  db.prepare(
    `INSERT INTO session_state
       (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(appId, sessionId, now, now, now);
  db.prepare(
    `INSERT INTO app_attachments
       (id, app_id, session_id, original_name, state, created_at, updated_at)
     VALUES (?, ?, ?, 'file.txt', 'available', ?, ?)`,
  ).run(`att_${sessionId}`, appId, sessionId, now, now);
  db.prepare(
    `INSERT INTO attachment_deliveries
       (id, attachment_id, app_id, session_id, part_id, message_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'sent', ?, ?)`,
  ).run(`del_${sessionId}`, `att_${sessionId}`, appId, sessionId, `msg_${sessionId}`, now, now);
  db.prepare(
    `INSERT INTO pending_sends
       (id, app_id, session_id, message_id, text, attachments_json, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', '[]', 'unknown', ?, ?)`,
  ).run(`pend_${sessionId}`, appId, sessionId, `msg_pending_${sessionId}`, now, now);
  db.prepare(
    `INSERT INTO session_notices
       (id, app_id, session_id, parent_session_id, dedupe_key, kind, reason, payload_json, created_at)
     VALUES (?, ?, ?, NULL, ?, 'agent_stopped', 'process_exit', '{}', ?)`,
  ).run(`notice_${sessionId}`, appId, sessionId, `stop|${sessionId}`, now);
  db.prepare(
    `INSERT INTO session_notice_dedupe (app_id, session_id, dedupe_key, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(appId, sessionId, `stop|${sessionId}`, now);
  db.prepare(
    `INSERT INTO session_resume
       (app_id, session_id, observed_status, observed_at, last_busy_seen_at, created_at, updated_at)
     VALUES (?, ?, 'busy', ?, ?, ?, ?)`,
  ).run(appId, sessionId, now, now, now, now);
}

function seedNotice(
  db: SqliteDatabase,
  sessionId: string,
  id: string,
  createdAt: string,
  kind = "agent_stopped",
  reason = "process_exit",
): void {
  db.prepare(
    `INSERT INTO session_notices
       (id, app_id, session_id, parent_session_id, dedupe_key, kind, reason, payload_json, created_at)
     VALUES (?, 'p1:storefront', ?, NULL, ?, ?, ?, '{"exitCode":137}', ?)`,
  ).run(id, sessionId, `key-${id}`, kind, reason, createdAt);
  db.prepare(
    `INSERT INTO session_notice_dedupe (app_id, session_id, dedupe_key, created_at)
     VALUES ('p1:storefront', ?, ?, ?)`,
  ).run(sessionId, `key-${id}`, createdAt);
}

function countSessionRows(db: SqliteDatabase, table: string, sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE app_id = ? AND session_id = ?`)
    .get("p1:storefront", sessionId) as { count: number };
  return row.count;
}

function insertParentHandoff(db: SqliteDatabase, sourceSessionId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO handoffs
       (id, project_id, from_app_id, to_app_id, state, summary, spec,
        idempotency_key, attempts, source_session_id, created_at, updated_at)
     VALUES ('handoff_parent', 'p1', 'p1:storefront', 'p1:api', 'pending', 'summary', 'spec',
             'idem-parent', 0, ?, ?, ?)`,
  ).run(sourceSessionId, now, now);
}

function asyncRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return request({
    method: "POST",
    path: "/api/apps/storefront/sessions/ses_1/messages",
    query: { project: "p1", async: "1" },
    body: JSON.stringify({ text: "hello" }),
    ...overrides,
  });
}

function useUpstream(deps: HttpDeps, endpoint: string): void {
  deps.manager = {
    ensure: async () => endpoint,
    endpointFor: () => endpoint,
  } as unknown as InstanceManager;
}

describe("chat page", () => {
  it("serves chat-commands.js from the asset allowlist", () => {
    const f = fixture();
    const response = handleRequest(f.deps, {
      method: "GET",
      path: "/assets/chat-commands.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/javascript; charset=utf-8");
    expect(response.body).toContain("export function parseComposerCommand");
    expect(response.body).toContain("export function resolveComposerCommand");
    expect(response.body).toContain("export const HANSE_ACTIONS");
  });

  it("serves the shared markdown renderer from the asset allowlist", () => {
    const f = fixture();
    const response = handleRequest(f.deps, {
      method: "GET",
      path: "/assets/markdown.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/javascript");
    expect(response.body).toContain("message__table-wrap");
    expect(response.body).toContain("function renderMarkdown(");
    expect(response.body).toContain("function element(");
    expect(response.body).not.toMatch(/\.innerHTML\s*=/);
  });

  it("serves the chat-core module from the asset allowlist", () => {
    const f = fixture();
    const response = handleRequest(f.deps, {
      method: "GET",
      path: "/assets/chat-core.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/javascript; charset=utf-8");
    expect(response.body).toContain("export function deriveQueue");
    expect(response.body).toContain("export function applySnapshot");
  });

  it("serves the diff model and highlight worker modules from the asset allowlist", () => {
    const f = fixture();
    const assets = [
      ["/assets/chat-diff.js", "chat-diff.js", "export function extractToolView"],
      ["/assets/chat-highlight.js", "chat-highlight.js", "export function mountToolView"],
      [
        "/assets/chat-highlight-worker.js",
        "chat-highlight-worker.js",
        "self.onmessage = onMessage",
      ],
    ] as const;
    for (const [assetPath, file, marker] of assets) {
      const response = handleRequest(f.deps, {
        method: "GET",
        path: assetPath,
        headers: {},
      });
      expect(response.status).toBe(200);
      expect(response.contentType).toBe("text/javascript; charset=utf-8");
      expect(response.body).toContain(marker);
      expect(response.body).toBe(readFileSync(path.join(process.cwd(), "assets", file), "utf8"));
    }
    expect(readFileSync(path.join(process.cwd(), "assets", "chat-diff.js"), "utf8")).toContain(
      "truncated for live view; the full result may load when the turn ends.",
    );
  });

  it("keeps client highlighting sources free of HTML sinks and eager worker imports", () => {
    const source = (file: string) => readFileSync(path.join(process.cwd(), "assets", file), "utf8");
    const modules = ["chat-diff.js", "chat-highlight.js", "chat-highlight-worker.js"];
    for (const file of modules) {
      const text = source(file);
      expect(text).not.toContain("innerHTML");
      expect(text).not.toContain("insertAdjacentHTML");
      expect(text).not.toContain("Prism.highlight");
      expect(text).not.toContain("highlightElement");
    }

    const controller = source("chat-highlight.js");
    expect(controller).not.toMatch(/\bPrism\b/);
    expect(controller).not.toContain("vendor/prism");
    expect(controller).not.toMatch(/from\s+["'][^"']*chat-highlight-worker/);
    expect(controller).not.toMatch(/^\s*await\b/m);
    expect(controller).toContain('new URL("./chat-highlight-worker.js", import.meta.url)');

    const worker = source("chat-highlight-worker.js");
    expect(worker).toContain("self.onmessage = onMessage");
    expect(worker).toContain("Prism.tokenize");
    expect(worker).toContain(
      "globalThis.Prism = { manual: true, disableWorkerMessageHandler: true }",
    );
  });

  it("mounts a completed read part as a structured tool-code block without raw XML", () => {
    const output = [
      "<path>/workspace/apps/demo-app/tools/analyzer/webui.py</path>",
      "<type>file</type>",
      "<content>",
      "1418: def bundle_bytes(data, drop_index, mins=2.0):",
      "1419:     # trim the bundle",
      "1420:     return data",
      "",
      "(Showing lines 1418-1420 of 5169. Use offset=1421 to continue.)",
      "</content>",
    ].join("\n");
    const view = extractToolView(
      {
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "webui.py", offset: 1418, limit: 3 },
          metadata: {},
          output,
        },
      },
      "read",
      "completed",
    );
    expect(view?.kind).toBe("read");
    const allocated = allocateView(view);
    expect(allocated.kind).toBe("read");

    const globalRecord = globalThis as unknown as { document?: unknown };
    const previous = globalRecord.document;
    globalRecord.document = fakeDocument();
    let mounted: FakeNode | null = null;
    try {
      mounted = mountToolView(allocated, {
        partID: "read-1",
        viewKey: "read-key",
      }) as FakeNode | null;
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalRecord, "document");
      else globalRecord.document = previous;
    }

    expect(mounted?.className).toBe("tool-code");
    const head = mounted?.children.find((child) => child.className === "tool-code__head");
    const scroller = mounted?.children.find((child) => child.className === "tool-code__scroll");
    const foot = mounted?.children.find((child) => child.className === "tool-code__foot");
    expect(fakeText(head as FakeNode)).toContain("webui.py");
    expect(fakeText(head as FakeNode)).toContain("1418–1420 of 5169");
    expect(fakeText(head as FakeNode)).toContain("python");
    expect(scroller?.children.map((row) => row.children[0].textContent)).toEqual([
      "1418",
      "1419",
      "1420",
    ]);
    expect(scroller?.attributes["aria-label"]).toBe(
      "File content for /workspace/apps/demo-app/tools/analyzer/webui.py, scrollable",
    );
    expect(foot?.textContent).toBe("Showing lines 1418-1420 of 5169. Use offset=1421 to continue.");

    const text = fakeText(mounted as FakeNode);
    expect(text).toContain("def bundle_bytes");
    expect(text).not.toContain("<path>");
    expect(text).not.toContain("<content>");
  });

  it("reserves highlight budget all-or-nothing per file", () => {
    expect(reservationUnits(1)).toEqual({ streams: 1, nodes: 10_000 });
    expect(reservationUnits(2)).toEqual({ streams: 2, nodes: 20_000 });
    expect(reservationFits(0, 0, 2)).toBe(true);
    expect(reservationFits(100_000, 10, 2)).toBe(true);
    expect(reservationFits(100_001, 10, 2)).toBe(false);
    expect(reservationFits(0, 11, 2)).toBe(false);
    expect(reservationFits(120_000, 12, 1)).toBe(false);
    expect(isHighlightEligible("typescript", "diff")).toBe(true);
    expect(isHighlightEligible("diff", "diff")).toBe(false);
    expect(isHighlightEligible("diff", "write")).toBe(true);
    expect(isHighlightEligible("plain", "write")).toBe(false);
  });

  it("vendors the Prism 1.30.0 bundle with a matching checksum and language set", () => {
    const vendorDir = path.join(process.cwd(), "assets", "vendor", "prism");
    const bundlePath = path.join(vendorDir, "prism-1.30.0.min.js");
    const bytes = readFileSync(bundlePath);

    expect(statSync(bundlePath).size).toBeLessThanOrEqual(88 * 1024);
    expect(readFileSync(path.join(vendorDir, "VERSION"), "utf8").trim()).toBe("PrismJS 1.30.0");

    const recorded = readFileSync(path.join(vendorDir, "SHA256SUMS"), "utf8").trim().split(/\s+/);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toBe("prism-1.30.0.min.js");
    const actual = createHash("sha256").update(bytes).digest("hex");
    expect(actual).toBe(recorded[0]);

    const source = bytes.toString("utf8");
    expect(source.startsWith("/*! PrismJS 1.30.0 | MIT |")).toBe(true);
    expect(source.trimEnd().endsWith("export default Prism;")).toBe(true);

    // Import through a real Node ESM loader: Vitest transforms the bundle and trips its
    // CommonJS branch (`module.exports = Prism`), which never runs in Node ESM or a worker.
    const probe = `const { pathToFileURL } = await import("node:url");
const { default: Prism } = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
console.log(JSON.stringify(Object.keys(Prism.languages)));`;
    const languages = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" }),
    ) as string[];
    const requiredLanguages = [
      "javascript",
      "typescript",
      "jsx",
      "tsx",
      "json",
      "yaml",
      "bash",
      "markdown",
      "css",
      "markup",
      "python",
      "go",
      "rust",
      "sql",
      "docker",
      "diff",
    ];
    for (const language of requiredLanguages) {
      expect(languages).toContain(language);
    }
  });

  it("keeps the new chat modules within the Q1 size budget", () => {
    const files = ["chat-diff.js", "chat-highlight.js", "chat-highlight-worker.js"];
    const sizes = files.map((file) => statSync(path.join(process.cwd(), "assets", file)).size);
    const gzip = files.map(
      (file) => gzipSync(readFileSync(path.join(process.cwd(), "assets", file))).length,
    );

    expect(sizes[0] + sizes[1]).toBeLessThanOrEqual(88 * 1024);
    expect(sizes[2]).toBeLessThanOrEqual(12 * 1024);
    expect(sizes[0] + sizes[1] + sizes[2]).toBeLessThanOrEqual(96 * 1024);
    expect(gzip[0] + gzip[1]).toBeLessThanOrEqual(24 * 1024);
    expect(gzip[2]).toBeLessThanOrEqual(8 * 1024);
    expect(gzip[0] + gzip[1] + gzip[2]).toBeLessThanOrEqual(32 * 1024);
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
    expect(upstream.calls).toEqual([
      { method: "GET", url: "/session", body: "" },
      { method: "DELETE", url: "/session/ses_1", body: "" },
    ]);
  });

  it("cleans the whole upstream subtree on delete", async () => {
    const f = fixture();
    const agentsHome = mkdtempSync(path.join(tmpdir(), "hanse-agents-"));
    dirs.push(agentsHome);
    f.deps.agentsHome = agentsHome;
    const parentFolder = createSessionFolder(agentsHome, "ses_parent");
    const childFolder = createSessionFolder(agentsHome, "ses_child");
    const otherFolder = createSessionFolder(agentsHome, "ses_other");
    for (const id of ["ses_parent", "ses_child", "ses_other"]) seedSessionChatRows(f.db, id);
    insertParentHandoff(f.db, "ses_parent");

    const sessions = [
      { id: "ses_parent", title: "Parent" },
      { id: "ses_child", title: "Child", parentID: "ses_parent" },
      { id: "ses_other", title: "Other" },
    ];
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(sessions));
        return;
      }
      if (incoming.method === "DELETE" && incoming.url === "/session/ses_parent") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end("true");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(
      f.deps,
      request({
        method: "DELETE",
        path: "/api/apps/storefront/sessions/ses_parent",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ deleted: true });
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /session",
      "DELETE /session/ses_parent",
    ]);

    const tables = [
      "message_drafts",
      "session_state",
      "app_attachments",
      "attachment_deliveries",
      "pending_sends",
      "session_notices",
      "session_notice_dedupe",
      "session_resume",
    ];
    for (const table of tables) {
      expect(countSessionRows(f.db, table, "ses_parent")).toBe(0);
      expect(countSessionRows(f.db, table, "ses_child")).toBe(0);
      expect(countSessionRows(f.db, table, "ses_other")).toBe(1);
    }
    expect(existsSync(parentFolder)).toBe(false);
    expect(existsSync(childFolder)).toBe(false);
    expect(existsSync(otherFolder)).toBe(true);
    const handoff = f.db
      .prepare("SELECT source_session_deleted_at AS deletedAt FROM handoffs WHERE id = ?")
      .get("handoff_parent") as { deletedAt: string | null };
    expect(handoff.deletedAt).not.toBeNull();
  });

  it("serves persisted notices from the coordinator database without a runtime", async () => {
    const f = fixture();
    seedNotice(f.db, "ses_1", "notice_1", "2026-10-27T10:00:00.000Z");

    const response = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/notices",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );

    expect(f.deps.manager).toBeUndefined();
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      notices: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(body.nextCursor).toBeNull();
    expect(body.notices).toHaveLength(1);
    expect(body.notices[0]).toMatchObject({
      id: "notice_1",
      appId: "p1:storefront",
      sessionId: "ses_1",
      kind: "agent_stopped",
      reason: "process_exit",
      payload: { exitCode: 137 },
      createdAt: "2026-10-27T10:00:00.000Z",
    });
  });

  it("requires a human principal for notices", async () => {
    const f = fixture();
    seedNotice(f.db, "ses_1", "notice_1", "2026-10-27T10:00:00.000Z");
    const agent = createPrincipal(f.db, { kind: "agent", name: "bot" });

    const anonymous = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/notices",
        query: { project: "p1" },
      }),
    );
    expect(anonymous.status).toBe(401);

    const nonHuman = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/notices",
        query: { project: "p1" },
        headers: auth(agent.token),
      }),
    );
    expect(nonHuman.status).toBe(403);
  });

  it("bounds notice limits and cursors and paginates by before", async () => {
    const f = fixture();
    seedNotice(f.db, "ses_1", "notice_a", "2026-10-27T10:00:00.000Z");
    seedNotice(f.db, "ses_1", "notice_b", "2026-10-27T10:01:00.000Z");
    seedNotice(f.db, "ses_1", "notice_c", "2026-10-27T10:02:00.000Z");

    for (const limit of ["0", "101", "abc"]) {
      const invalid = await handleChat(
        f.deps,
        request({
          path: "/api/apps/storefront/sessions/ses_1/notices",
          query: { project: "p1", limit },
          headers: auth(f.token),
        }),
      );
      expect(invalid.status).toBe(400);
      expect(JSON.parse(invalid.body).code).toBe("invalid_limit");
    }

    const longCursor = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/notices",
        query: { project: "p1", before: "a".repeat(257) },
        headers: auth(f.token),
      }),
    );
    expect(longCursor.status).toBe(400);
    expect(JSON.parse(longCursor.body).code).toBe("invalid_cursor");

    const first = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/notices",
        query: { project: "p1", limit: "2" },
        headers: auth(f.token),
      }),
    );
    const firstBody = JSON.parse(first.body) as {
      notices: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(firstBody.notices.map((notice) => notice.id)).toEqual(["notice_c", "notice_b"]);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/notices",
        query: {
          project: "p1",
          limit: "2",
          before: firstBody.nextCursor,
        },
        headers: auth(f.token),
      }),
    );
    const secondBody = JSON.parse(second.body) as {
      notices: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondBody.notices.map((notice) => notice.id)).toEqual(["notice_a"]);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("rejects notices for a deleting app and keeps a notice-only session on delete-if-empty", async () => {
    const f = fixture();
    const now = new Date().toISOString();
    f.db
      .prepare(
        `INSERT INTO session_state (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
         VALUES ('p1:storefront', 'ses_1', 0, ?, ?, ?)`,
      )
      .run(now, now, now);
    seedNotice(f.db, "ses_1", "notice_1", now);
    useUpstream(f.deps, "http://unused");

    const deleted = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.body)).toEqual({ deleted: false, reason: "has_notice" });

    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p1:storefront'").run();
    const blocked = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/notices",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(blocked.status).toBe(409);
    expect(JSON.parse(blocked.body).code).toBe("deletion_pending");
  });

  it("rejects an old-client delete-if-empty without the UI version", async () => {
    const f = fixture();
    const response = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/delete-if-empty",
        query: { project: "p1" },
        headers: { authorization: `Bearer ${f.token}` },
        body: "{}",
      }),
    );
    expect(response.status).toBe(409);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual({
      error: "UI reload required",
      code: "ui_reload_required",
    });
  });

  it("deletes only the requested id when the session list is not an array", async () => {
    const f = fixture();
    const agentsHome = mkdtempSync(path.join(tmpdir(), "hanse-agents-"));
    dirs.push(agentsHome);
    f.deps.agentsHome = agentsHome;
    const parentFolder = createSessionFolder(agentsHome, "ses_parent");
    const childFolder = createSessionFolder(agentsHome, "ses_child");
    seedSessionChatRows(f.db, "ses_parent");
    seedSessionChatRows(f.db, "ses_child");
    const upstream = await fakeOpencode();
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(
      f.deps,
      request({
        method: "DELETE",
        path: "/api/apps/storefront/sessions/ses_parent",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ deleted: true });
    expect(upstream.calls).toEqual([
      { method: "GET", url: "/session", body: "" },
      { method: "DELETE", url: "/session/ses_parent", body: "" },
    ]);
    expect(countSessionRows(f.db, "message_drafts", "ses_parent")).toBe(0);
    expect(countSessionRows(f.db, "message_drafts", "ses_child")).toBe(1);
    expect(existsSync(parentFolder)).toBe(false);
    expect(existsSync(childFolder)).toBe(true);
  });

  it("still deletes when the session listing fails", async () => {
    const f = fixture();
    const agentsHome = mkdtempSync(path.join(tmpdir(), "hanse-agents-"));
    dirs.push(agentsHome);
    f.deps.agentsHome = agentsHome;
    const folder = createSessionFolder(agentsHome, "ses_1");
    seedSessionChatRows(f.db, "ses_1");
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session") {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end('{"error":"boom"}');
        return;
      }
      if (incoming.method === "DELETE" && incoming.url === "/session/ses_1") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end("true");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
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
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /session",
      "DELETE /session/ses_1",
    ]);
    expect(countSessionRows(f.db, "message_drafts", "ses_1")).toBe(0);
    expect(existsSync(folder)).toBe(false);
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
    expect(JSON.parse(response.body).error).toContain("opencode /session/ses_1 -> 500");
  });
});

describe("abort route", () => {
  const abortPath = "/api/apps/storefront/sessions/ses_1/abort";

  function abortRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
    return request({
      method: "POST",
      path: abortPath,
      query: { project: "p1" },
      ...overrides,
    });
  }

  function managerFor(
    endpoint: string | undefined,
    counters: { ensure: number; endpoint: number },
    aborts?: string[],
  ): InstanceManager {
    return {
      ensure: async () => {
        counters.ensure += 1;
        return endpoint ?? "http://127.0.0.1:1";
      },
      endpointFor: () => {
        counters.endpoint += 1;
        return endpoint;
      },
      ...(aborts === undefined
        ? {}
        : {
            recordOperatorAbort: (appId: string, sessionId: string) => {
              aborts.push(`${appId}:${sessionId}`);
            },
          }),
    } as unknown as InstanceManager;
  }

  function newCounters(): { ensure: number; endpoint: number } {
    return { ensure: 0, endpoint: 0 };
  }

  it("forbids an agent principal before any app or runtime lookup", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    const counters = newCounters();
    f.deps.manager = managerFor(upstream.endpoint, counters);
    const { token } = createPrincipal(f.db, { kind: "agent", name: "bot" });

    const response = await handleChat(f.deps, abortRequest({ headers: auth(token) }));

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "only a human principal may abort a session",
    });
    expect(counters).toEqual({ ensure: 0, endpoint: 0 });
    expect(upstream.calls).toEqual([]);
  });

  it("rejects every non-POST method without touching the runtime", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    const counters = newCounters();
    f.deps.manager = managerFor(upstream.endpoint, counters);

    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const response = await handleChat(f.deps, abortRequest({ method, headers: auth(f.token) }));
      expect(response.status, method).toBe(405);
      expect(JSON.parse(response.body)).toEqual({ error: "method not allowed" });
    }
    expect(counters).toEqual({ ensure: 0, endpoint: 0 });
    expect(upstream.calls).toEqual([]);
  });

  it("returns 404 for an unknown application without starting it", async () => {
    const f = fixture();
    const upstream = await fakeOpencode();
    const counters = newCounters();
    f.deps.manager = managerFor(upstream.endpoint, counters);

    const response = await handleChat(
      f.deps,
      abortRequest({
        path: "/api/apps/nope/sessions/ses_1/abort",
        headers: auth(f.token),
      }),
    );

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: "unknown application: nope",
      code: "unknown_app",
    });
    expect(counters).toEqual({ ensure: 0, endpoint: 0 });
    expect(upstream.calls).toEqual([]);
  });

  it("returns 409 when the app or its project is pending deletion", async () => {
    const markers = [
      { table: "apps", id: "p1:storefront" },
      { table: "projects", id: "p1" },
    ] as const;
    for (const marker of markers) {
      const f = fixture();
      const upstream = await fakeOpencode();
      const counters = newCounters();
      f.deps.manager = managerFor(upstream.endpoint, counters);
      f.db.prepare(`UPDATE ${marker.table} SET deleting = 1 WHERE id = ?`).run(marker.id);

      const response = await handleChat(f.deps, abortRequest({ headers: auth(f.token) }));

      expect(response.status, marker.table).toBe(409);
      expect(JSON.parse(response.body)).toEqual({
        error: "application is pending deletion",
        code: "deletion_pending",
      });
      expect(counters).toEqual({ ensure: 0, endpoint: 0 });
      expect(upstream.calls).toEqual([]);
    }
  });

  it("returns 503 when the agent is not running and never calls ensure", async () => {
    const f = fixture();
    const counters = newCounters();
    f.deps.manager = managerFor(undefined, counters);

    const response = await handleChat(f.deps, abortRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "agent is not running",
      code: "agent_not_running",
    });
    expect(counters).toEqual({ ensure: 0, endpoint: 1 });
  });

  it("aborts through the running endpoint without starting the agent", async () => {
    const f = fixture();
    const upstream = await fakeOpencode(200, "true");
    const counters = newCounters();
    const aborts: string[] = [];
    f.deps.manager = managerFor(upstream.endpoint, counters, aborts);

    const response = await handleChat(f.deps, abortRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ aborted: true });
    expect(upstream.calls).toEqual([{ method: "POST", url: "/session/ses_1/abort", body: "" }]);
    expect(aborts).toEqual(["p1:storefront:ses_1"]);
    expect(counters).toEqual({ ensure: 0, endpoint: 1 });
  });

  it("maps an upstream 404 to session_not_found", async () => {
    const f = fixture();
    const upstream = await fakeOpencode(404, '{"error":"no session"}');
    f.deps.manager = managerFor(upstream.endpoint, newCounters());

    const response = await handleChat(f.deps, abortRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: "session not found",
      code: "session_not_found",
    });
  });

  it("maps any other upstream failure to abort_failed", async () => {
    for (const status of [500, 502]) {
      const f = fixture();
      const upstream = await fakeOpencode(status, '{"error":"boom"}');
      f.deps.manager = managerFor(upstream.endpoint, newCounters());

      const response = await handleChat(f.deps, abortRequest({ headers: auth(f.token) }));

      expect(response.status, String(status)).toBe(502);
      expect(JSON.parse(response.body)).toEqual({
        error: "could not stop the turn",
        code: "abort_failed",
      });
    }
  });
});

describe("paged message list route", () => {
  const messagesPath = "/api/apps/storefront/sessions/ses_1/messages";

  function listRequest(f: Fixture, query: Record<string, string>): HttpRequest {
    return request({
      path: messagesPath,
      query: { project: "p1", ...query },
      headers: auth(f.token),
    });
  }

  it("returns nextCursor and forwards limit for a paged read", async () => {
    const f = fixture();
    const messages = [{ info: { id: "msg_1", role: "user" }, parts: [] }];
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1/message?limit=30") {
        outgoing.writeHead(200, {
          "content-type": "application/json",
          "x-next-cursor": "next-1",
        });
        outgoing.end(JSON.stringify(messages));
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, listRequest(f, { limit: "30" }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ messages, nextCursor: "next-1" });
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /session/ses_1/message?limit=30",
    ]);
  });

  it("forwards an opaque before cursor encoded to upstream", async () => {
    const f = fixture();
    const before = "op/aque+ =值";
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      const url = new URL(incoming.url ?? "/", "http://localhost");
      if (incoming.method === "GET" && url.pathname === "/session/ses_1/message") {
        expect(url.searchParams.get("limit")).toBe("30");
        expect(url.searchParams.get("before")).toBe(before);
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end("[]");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, listRequest(f, { limit: "30", before }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ messages: [], nextCursor: null });
    const url = new URL(upstream.calls[0]?.url ?? "/", "http://localhost");
    expect(url.searchParams.get("before")).toBe(before);
    expect(upstream.calls[0]?.url).not.toContain(before);
  });

  it("rejects non-canonical or out-of-range limits before starting the agent", async () => {
    const f = fixture();
    const upstream = await fakeOpencode(200, "[]");
    let ensureCalls = 0;
    f.deps.manager = {
      ensure: async () => {
        ensureCalls += 1;
        return upstream.endpoint;
      },
    } as unknown as InstanceManager;

    for (const limit of ["0", "201", "-1", "1.5", "abc", "", "030", " 30", "+30", "1e2"]) {
      const response = await handleChat(f.deps, listRequest(f, { limit }));
      expect(response.status, `limit=${JSON.stringify(limit)}`).toBe(400);
      expect(JSON.parse(response.body).code).toBe("invalid_limit");
    }
    expect(ensureCalls).toBe(0);
    expect(upstream.calls).toEqual([]);
  });

  it("rejects before without limit", async () => {
    const f = fixture();
    const upstream = await fakeOpencode(200, "[]");
    let ensureCalls = 0;
    f.deps.manager = {
      ensure: async () => {
        ensureCalls += 1;
        return upstream.endpoint;
      },
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, listRequest(f, { before: "cur-1" }));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "before requires limit",
      code: "cursor_requires_limit",
    });
    expect(ensureCalls).toBe(0);
  });

  it("rejects an empty or whitespace-only before cursor", async () => {
    const f = fixture();
    const upstream = await fakeOpencode(200, "[]");
    let ensureCalls = 0;
    f.deps.manager = {
      ensure: async () => {
        ensureCalls += 1;
        return upstream.endpoint;
      },
    } as unknown as InstanceManager;

    for (const before of ["", "   "]) {
      const response = await handleChat(f.deps, listRequest(f, { limit: "30", before }));
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "invalid message cursor",
        code: "invalid_cursor",
      });
    }
    expect(ensureCalls).toBe(0);
  });

  it("keeps the legacy response without limit", async () => {
    const f = fixture();
    const messages = [{ info: { id: "msg_1", role: "assistant" }, parts: [] }];
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_1/message") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(messages));
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, listRequest(f, {}));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ messages });
  });

  it("maps an upstream 400 on a before request to invalid_cursor", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url?.startsWith("/session/ses_1/message")) {
        outgoing.writeHead(400, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "bad cursor" }));
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, listRequest(f, { limit: "30", before: "bad" }));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "invalid message cursor",
      code: "invalid_cursor",
    });
  });

  it("maps an upstream 404 on a paged read to session_not_found", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url?.startsWith("/session/ses_1/message")) {
        outgoing.writeHead(404);
        outgoing.end("no session");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, listRequest(f, { limit: "30" }));
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: "session not found",
      code: "session_not_found",
    });
  });
});

describe("read routes attach to the running agent", () => {
  function counters(): { ensure: number; endpoint: number } {
    return { ensure: 0, endpoint: 0 };
  }

  function readManager(
    attached: string | undefined,
    ensured: string,
    calls: { ensure: number; endpoint: number },
  ): InstanceManager {
    return {
      ensure: async () => {
        calls.ensure += 1;
        return ensured;
      },
      endpointFor: () => {
        calls.endpoint += 1;
        return attached;
      },
    } as unknown as InstanceManager;
  }

  function sessionsRequest(f: Fixture): HttpRequest {
    return request({
      path: "/api/apps/storefront/sessions",
      query: { project: "p1" },
      headers: auth(f.token),
    });
  }

  function messagesRequest(f: Fixture): HttpRequest {
    return request({
      path: "/api/apps/storefront/sessions/ses_1/messages",
      query: { project: "p1", limit: "30" },
      headers: auth(f.token),
    });
  }

  function emptyUpstream() {
    return fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "GET") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end("[]");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
  }

  it("reads the session list without ensure when an endpoint is attached", async () => {
    const f = fixture();
    const upstream = await emptyUpstream();
    const calls = counters();
    f.deps.manager = readManager(upstream.endpoint, upstream.endpoint, calls);

    const response = await handleChat(f.deps, sessionsRequest(f));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).sessions).toEqual([]);
    expect(calls).toEqual({ ensure: 0, endpoint: 1 });
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual(["GET /session"]);
  });

  it("reads a message page without ensure when an endpoint is attached", async () => {
    const f = fixture();
    const upstream = await emptyUpstream();
    const calls = counters();
    f.deps.manager = readManager(upstream.endpoint, upstream.endpoint, calls);

    const response = await handleChat(f.deps, messagesRequest(f));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ messages: [], nextCursor: null });
    expect(calls).toEqual({ ensure: 0, endpoint: 1 });
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /session/ses_1/message?limit=30",
    ]);
  });

  it("returns 503 agent_stopped for reads when no endpoint is attached and never calls ensure", async () => {
    const f = fixture();
    const calls = counters();
    f.deps.manager = {
      ensure: async () => {
        calls.ensure += 1;
        throw new Error("reads must not start the agent");
      },
      endpointFor: () => {
        calls.endpoint += 1;
        return undefined;
      },
    } as unknown as InstanceManager;

    const sessions = await handleChat(f.deps, sessionsRequest(f));
    expect(sessions.status).toBe(503);
    expect(JSON.parse(sessions.body)).toEqual({
      error: "agent is stopped",
      code: "agent_stopped",
    });

    const messages = await handleChat(f.deps, messagesRequest(f));
    expect(messages.status).toBe(503);
    expect(JSON.parse(messages.body)).toEqual({
      error: "agent is stopped",
      code: "agent_stopped",
    });

    expect(calls).toEqual({ ensure: 0, endpoint: 2 });
  });

  it("does not start the agent when the attached endpoint stops answering", async () => {
    const f = fixture();
    const calls = counters();
    f.deps.manager = readManager("http://127.0.0.1:1", "http://127.0.0.1:2", calls);

    const response = await handleChat(f.deps, messagesRequest(f));

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: "agent is unavailable",
      code: "agent_unavailable",
    });
    expect(calls).toEqual({ ensure: 0, endpoint: 1 });
  });

  it("keeps deletion and unknown-app responses on the read routes", async () => {
    const f = fixture();
    const calls = counters();
    f.deps.manager = readManager(undefined, "http://127.0.0.1:1", calls);
    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p1:storefront'").run();

    for (const deletionRequest of [sessionsRequest(f), messagesRequest(f)]) {
      const deleting = await handleChat(f.deps, deletionRequest);
      expect(deleting.status).toBe(409);
      expect(JSON.parse(deleting.body)).toEqual({
        error: "application is pending deletion",
        code: "deletion_pending",
      });
    }

    const unknown = await handleChat(
      f.deps,
      request({
        path: "/api/apps/nope/sessions",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({
      error: "unknown application: nope",
      code: "unknown_app",
    });
    expect(calls).toEqual({ ensure: 0, endpoint: 0 });
  });
});

describe("turn route", () => {
  function turnRequest(f: Fixture, overrides: Partial<HttpRequest> = {}): HttpRequest {
    return request({
      path: "/api/apps/storefront/sessions/ses_1/turn",
      query: { project: "p1" },
      headers: auth(f.token),
      ...overrides,
    });
  }

  function manager(
    endpoint: string | undefined,
    counters: { ensure: number; endpoint: number },
  ): InstanceManager {
    return {
      ensure: async () => {
        counters.ensure += 1;
        return endpoint ?? "http://127.0.0.1:1";
      },
      endpointFor: () => {
        counters.endpoint += 1;
        return endpoint;
      },
    } as unknown as InstanceManager;
  }

  function counters(): { ensure: number; endpoint: number } {
    return { ensure: 0, endpoint: 0 };
  }

  function statusHandler(input: {
    status: () => unknown;
    messages: () => unknown;
    sessions?: () => unknown;
    onSend?: () => void;
  }): (incoming: IncomingMessage, outgoing: ServerResponse) => void {
    return (incoming, outgoing) => {
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      if (incoming.method === "GET" && path === "/session/status") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(input.status()));
        return;
      }
      if (incoming.method === "GET" && path === "/session") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(input.sessions?.() ?? []));
        return;
      }
      if (incoming.method === "GET" && path === "/session/ses_1/message") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(input.messages()));
        return;
      }
      if (incoming.method === "POST" && path === "/session/ses_1/prompt_async") {
        input.onSend?.();
        noContent(outgoing);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    };
  }

  it("returns a busy pre-first-part snapshot without starting the agent", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler(
      statusHandler({
        status: () => ({ ses_1: { type: "busy" } }),
        messages: () => [userMessage("msg_u1", [textPart("run")])],
      }),
    );
    const calls = counters();
    f.deps.manager = manager(upstream.endpoint, calls);

    const response = await handleChat(f.deps, turnRequest(f));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      sessionID: "ses_1",
      status: { type: "busy" },
      turnContinues: false,
      runningPromptID: "msg_u1",
      activePromptID: "msg_u1",
      queuedPromptIDs: ["msg_u1"],
      queuedTruncated: false,
      settling: false,
    });
    expect(calls).toEqual({ ensure: 0, endpoint: 1 });
    expect(upstream.calls.map((call) => `${call.method} ${call.url.split("?")[0]}`)).toEqual([
      "GET /session/status",
      "GET /session/ses_1/message",
      "GET /session/status",
    ]);
  });

  it("requires a human principal before any upstream read", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler(
      statusHandler({
        status: () => ({ ses_1: { type: "idle" } }),
        messages: () => [],
      }),
    );
    const calls = counters();
    f.deps.manager = manager(upstream.endpoint, calls);
    const agent = createPrincipal(f.db, { kind: "agent", name: "bot" });

    const response = await handleChat(f.deps, turnRequest(f, { headers: auth(agent.token) }));

    expect(response.status).toBe(403);
    expect(calls).toEqual({ ensure: 0, endpoint: 0 });
    expect(upstream.calls).toEqual([]);
  });

  it("rejects every non-GET method without touching the runtime", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler(
      statusHandler({
        status: () => ({ ses_1: { type: "idle" } }),
        messages: () => [],
      }),
    );
    const calls = counters();
    f.deps.manager = manager(upstream.endpoint, calls);

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await handleChat(f.deps, turnRequest(f, { method }));
      expect(response.status, method).toBe(405);
    }
    expect(calls).toEqual({ ensure: 0, endpoint: 0 });
    expect(upstream.calls).toEqual([]);
  });

  it("keeps the unknown-app and deletion responses on the turn route", async () => {
    const f = fixture();
    const calls = counters();
    f.deps.manager = manager(undefined, calls);

    const unknown = await handleChat(
      f.deps,
      request({
        path: "/api/apps/nope/sessions/ses_1/turn",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({
      error: "unknown application: nope",
      code: "unknown_app",
    });

    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p1:storefront'").run();
    const deleting = await handleChat(f.deps, turnRequest(f));
    expect(deleting.status).toBe(409);
    expect(JSON.parse(deleting.body).code).toBe("deletion_pending");
    expect(calls).toEqual({ ensure: 0, endpoint: 0 });
  });

  it("returns 503 agent_stopped without starting a stopped app", async () => {
    const f = fixture();
    const calls = counters();
    f.deps.manager = manager(undefined, calls);

    const response = await handleChat(f.deps, turnRequest(f));

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "agent is stopped",
      code: "agent_stopped",
    });
    expect(calls).toEqual({ ensure: 0, endpoint: 1 });
  });

  it("returns 502 turn_unavailable for a malformed status map", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler(
      statusHandler({
        status: () => ({ ses_1: { label: "no type" } }),
        messages: () => [userMessage("msg_u1", [textPart("run")])],
      }),
    );
    const calls = counters();
    f.deps.manager = manager(upstream.endpoint, calls);

    const response = await handleChat(f.deps, turnRequest(f));

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: "turn state is unavailable",
      code: "turn_unavailable",
    });
    expect(upstream.calls.map((call) => call.url.split("?")[0])).toEqual(["/session/status"]);
  });

  it("maps an upstream missing session to 404 session_not_found", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      if (incoming.method === "GET" && path === "/session/status") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({}));
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const calls = counters();
    f.deps.manager = manager(upstream.endpoint, calls);

    const response = await handleChat(f.deps, turnRequest(f));

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: "session not found",
      code: "session_not_found",
    });
  });

  it("invalidates the cached snapshot on an accepted send", async () => {
    const f = fixture();
    let status: unknown = { ses_1: { type: "busy" } };
    let statusCalls = 0;
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      if (incoming.method === "GET" && path === "/session/status") {
        statusCalls += 1;
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(status));
        return;
      }
      if (incoming.method === "GET" && path === "/session/ses_1/message") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify([userMessage("msg_u1", [textPart("run")])]));
        return;
      }
      if (incoming.method === "POST" && path === "/session/ses_1/prompt_async") {
        status = { ses_1: { type: "idle" } };
        noContent(outgoing);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const calls = counters();
    f.deps.manager = manager(upstream.endpoint, calls);

    const first = await handleChat(f.deps, turnRequest(f));
    expect(JSON.parse(first.body).status.type).toBe("busy");
    expect(statusCalls).toBe(2);

    const send = await handleChat(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
        body: JSON.stringify({ text: "next" }),
      }),
    );
    expect(send.status).toBe(202);

    const second = await handleChat(f.deps, turnRequest(f));
    expect(JSON.parse(second.body).status.type).toBe("idle");
    expect(statusCalls).toBe(4);
  });

  it("serves concurrent reads through one single-flight computation", async () => {
    const f = fixture();
    let messageCalls = 0;
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
      if (incoming.method === "GET" && path === "/session/status") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ ses_1: { type: "busy" } }));
        return;
      }
      if (incoming.method === "GET" && path === "/session/ses_1/message") {
        messageCalls += 1;
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify([userMessage("msg_u1", [textPart("run")])]));
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    const calls = counters();
    f.deps.manager = manager(upstream.endpoint, calls);

    const [first, second] = await Promise.all([
      handleChat(f.deps, turnRequest(f)),
      handleChat(f.deps, turnRequest(f)),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(messageCalls).toBe(1);
  });

  it("keeps the same completed-turn snapshot stable across cache hits", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler(
      statusHandler({
        status: () => ({ ses_1: { type: "idle" } }),
        messages: () => [
          userMessage("msg_u1", [textPart("run")]),
          assistantMessage("msg_a1", [textPart("done")], {
            parentID: "msg_u1",
            finish: "stop",
            completed: true,
          }),
        ],
      }),
    );
    const calls = counters();
    f.deps.manager = manager(upstream.endpoint, calls);

    const first = await handleChat(f.deps, turnRequest(f));
    const second = await handleChat(f.deps, turnRequest(f));
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
    expect(upstream.calls).toHaveLength(3);
  });
});

describe("async chat send", () => {
  it("returns 202 after upstream 204 with the generated message id", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        noContent(outgoing);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
    expect(response.status).toBe(202);
    const payload = JSON.parse(response.body) as {
      accepted: boolean;
      messageID: string;
      sessionID: string;
    };
    expect(payload.accepted).toBe(true);
    expect(payload.sessionID).toBe("ses_1");
    expect(payload.messageID).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.method).toBe("POST");
    expect(upstream.calls[0]?.url).toBe("/session/ses_1/prompt_async");
    expect(JSON.parse(upstream.calls[0]?.body ?? "")).toEqual({
      parts: [{ type: "text", text: "hello" }],
      messageID: payload.messageID,
      model: { providerID: "deepseek", modelID: "deepseek-flash" },
    });
  });

  it("forwards a global model override to prompt_async", async () => {
    const f = fixture();
    f.settings.set("global", {}, "llm.model", "deepseek/deepseek-v4-pro", "owner");
    const upstream = await fakeOpencodeHandler((incoming, outgoing, body) => {
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        expect(JSON.parse(body)).toMatchObject({
          model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
        });
        noContent(outgoing);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
    expect(response.status).toBe(202);
    expect(upstream.calls).toHaveLength(1);
  });

  it("returns 202 for a busy session and never probes session status", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.url === "/session/ses_1/status") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ type: "busy" }));
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        noContent(outgoing);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
    expect(response.status).toBe(202);
    expect(JSON.parse(response.body).accepted).toBe(true);
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /session/ses_1/prompt_async",
    ]);
  });

  it("rejects invalid JSON, empty text, and whitespace-only text", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((_incoming, outgoing) => noContent(outgoing));
    useUpstream(f.deps, upstream.endpoint);

    const invalid = await handleChat(
      f.deps,
      asyncRequest({ headers: auth(f.token), body: "{not json" }),
    );
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body).code).toBe("invalid_json");

    for (const text of ["", "   ", "\n\t "]) {
      const response = await handleChat(
        f.deps,
        asyncRequest({ headers: auth(f.token), body: JSON.stringify({ text }) }),
      );
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).code).toBe("empty_message");
    }
    expect(upstream.calls).toEqual([]);
  });

  it("enforces the 32 KiB UTF-8 boundary with multibyte text", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        noContent(outgoing);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const exact = "a".repeat(32 * 1024);
    const exactResponse = await handleChat(
      f.deps,
      asyncRequest({ headers: auth(f.token), body: JSON.stringify({ text: exact }) }),
    );
    expect(exactResponse.status).toBe(202);

    const over = "é".repeat(16_385);
    expect(Buffer.byteLength(over, "utf8")).toBeGreaterThan(32 * 1024);
    const overResponse = await handleChat(
      f.deps,
      asyncRequest({ headers: auth(f.token), body: JSON.stringify({ text: over }) }),
    );
    expect(overResponse.status).toBe(400);
    expect(JSON.parse(overResponse.body).code).toBe("message_too_large");
  });

  it("returns 413 when the JSON body exceeds the 256 KiB chat route cap", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((_incoming, outgoing) => noContent(outgoing));
    useUpstream(f.deps, upstream.endpoint);
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/apps/storefront/sessions/ses_1/messages?project=p1&async=1`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(300 * 1024) }),
      },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "request body too large",
      code: "payload_too_large",
    });
    expect(upstream.calls).toEqual([]);
  });

  it("maps upstream 404, 405, and 5xx to the async error contract", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.url === "/session/missing/prompt_async") {
        outgoing.writeHead(404);
        outgoing.end("no session");
        return;
      }
      if (incoming.url === "/session/old/prompt_async") {
        outgoing.writeHead(405);
        outgoing.end("no route");
        return;
      }
      if (incoming.url === "/session/broken/prompt_async") {
        outgoing.writeHead(500);
        outgoing.end("boom");
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const missing = await handleChat(
      f.deps,
      asyncRequest({
        headers: auth(f.token),
        path: "/api/apps/storefront/sessions/missing/messages",
      }),
    );
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe("session_not_found");

    const old = await handleChat(
      f.deps,
      asyncRequest({
        headers: auth(f.token),
        path: "/api/apps/storefront/sessions/old/messages",
      }),
    );
    expect(old.status).toBe(502);
    expect(JSON.parse(old.body)).toMatchObject({
      code: "async_unavailable",
      outcome: "not_sent",
    });

    const broken = await handleChat(
      f.deps,
      asyncRequest({
        headers: auth(f.token),
        path: "/api/apps/storefront/sessions/broken/messages",
      }),
    );
    expect(broken.status).toBe(502);
    expect(JSON.parse(broken.body)).toMatchObject({
      code: "agent_unavailable",
      outcome: "not_sent",
    });
  });

  it("reports a transport failure as an unknown outcome with the generated id", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming) => {
      incoming.socket.destroy();
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
    expect(response.status).toBe(502);
    const payload = JSON.parse(response.body) as {
      code: string;
      outcome: string;
      messageID: string;
      sessionID: string;
    };
    expect(payload.code).toBe("agent_unavailable");
    expect(payload.outcome).toBe("unknown");
    expect(payload.messageID).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(payload.sessionID).toBe("ses_1");
  });

  it("maps an instance start failure to 502 not_sent", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new Error("launch failed");
      },
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "agent_unavailable",
      outcome: "not_sent",
    });
  });

  it("maps a not-ready agent to a transient 503", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new AgentStartingError("p1:storefront");
      },
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
    expect(response.status).toBe(503);
    expect(response.headers?.["retry-after"]).toBe("5");
    expect(JSON.parse(response.body)).toMatchObject({
      error: "agent is starting; retry shortly",
      code: "agent_starting",
    });
  });

  it("maps a pending deletion to 409 without changing start failures", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DeletionPendingError("p1:storefront");
      },
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "application p1:storefront is pending deletion",
      code: "deletion_pending",
    });
  });

  it("returns 503 agent_stopped on the legacy session SSE without calling ensure", async () => {
    const f = fixture();
    let ensureCalls = 0;
    let endpointCalls = 0;
    f.deps.manager = {
      ensure: async () => {
        ensureCalls += 1;
        throw new DeletionPendingError("p1:storefront");
      },
      endpointFor: () => {
        endpointCalls += 1;
        return undefined;
      },
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
      on() {},
      destroyed: false,
      writableEnded: false,
    } as unknown as ServerResponse;

    await streamSessionEvents(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/events",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
      response,
    );

    expect(written.status).toBe(503);
    expect(JSON.parse(written.body ?? "")).toEqual({
      error: "agent is stopped",
      code: "agent_stopped",
    });
    expect(ensureCalls).toBe(0);
    expect(endpointCalls).toBe(1);
  });

  it("keeps the pending-deletion response on the legacy session SSE", async () => {
    const f = fixture();
    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p1:storefront'").run();
    f.deps.manager = {
      ensure: async () => {
        throw new DeletionPendingError("p1:storefront");
      },
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
      on() {},
      destroyed: false,
      writableEnded: false,
    } as unknown as ServerResponse;

    await streamSessionEvents(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/events",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
      response,
    );

    expect(written.status).toBe(409);
    expect(JSON.parse(written.body ?? "")).toEqual({
      error: "application is pending deletion",
      code: "deletion_pending",
    });
  });

  it("maps a deployment lock to the shared 409 body", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DeploymentInProgressError("ensure", { phase: "switching" });
      },
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
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
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, asyncRequest({ headers: auth(f.token) }));
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "agent_token_reconcile_failed" });
  });

  it("keeps the existing auth, manager, and unknown-app responses", async () => {
    const missingPrincipal = await handleChat(fixture().deps, asyncRequest());
    expect(missingPrincipal.status).toBe(401);

    const noManagerFixture = fixture();
    const noManager = await handleChat(
      noManagerFixture.deps,
      asyncRequest({ headers: auth(noManagerFixture.token) }),
    );
    expect(noManager.status).toBe(503);

    const f = fixture();
    const upstream = await fakeOpencodeHandler((_incoming, outgoing) => noContent(outgoing));
    useUpstream(f.deps, upstream.endpoint);
    const unknown = await handleChat(
      f.deps,
      asyncRequest({
        headers: auth(f.token),
        path: "/api/apps/nope/sessions/ses_1/messages",
      }),
    );
    expect(unknown.status).toBe(404);
    const payload = JSON.parse(unknown.body) as { error: string; code: string };
    expect(payload.error).toBe("unknown application: nope");
    expect(payload.code).toBe("unknown_app");
    expect(upstream.calls).toEqual([]);
  });

  it("sends the default effective model on the blocking path", async () => {
    const f = fixture();
    const message = {
      info: { id: "msg_1", role: "assistant" },
      parts: [{ type: "text", text: "hello" }],
    };
    const upstream = await fakeOpencodeHandler((incoming, outgoing, body) => {
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/message") {
        const sent = JSON.parse(body) as {
          messageID?: string;
          parts: unknown;
          model: unknown;
        };
        expect(sent.messageID).toMatch(/^msg_[0-9a-f]{32}$/);
        expect(sent).toMatchObject({
          parts: [{ type: "text", text: "hello" }],
          model: { providerID: "deepseek", modelID: "deepseek-flash" },
        });
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(message));
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(
      f.deps,
      asyncRequest({
        headers: auth(f.token),
        query: { project: "p1" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(response.status).toBe(200);
    const blocking = JSON.parse(response.body) as {
      messageID: string;
      userMessageID: string;
      info: unknown;
      parts: unknown;
    };
    expect(blocking.messageID).toBe("msg_1");
    expect(blocking.userMessageID).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(blocking.info).toEqual(message.info);
    expect(blocking.parts).toEqual(message.parts);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toBe("/session/ses_1/message");
  });

  it("reads large-but-valid messages and maps over-cap responses to 502", async () => {
    const f = fixture();
    const text = "x".repeat(2 * 1024 * 1024);
    const messages = [
      { info: { id: "msg_1", role: "assistant" }, parts: [{ type: "text", text }] },
    ];
    const upstream = await fakeOpencodeHandler((_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(messages));
    });
    useUpstream(f.deps, upstream.endpoint);

    const response = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      messages: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(payload.messages[0]?.parts[0]?.text).toBe(text);

    const huge = "x".repeat(8 * 1024 * 1024);
    const overUpstream = await fakeOpencodeHandler((_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(
        JSON.stringify([
          { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "text", text: huge }] },
        ]),
      );
    });
    useUpstream(f.deps, overUpstream.endpoint);

    const over = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(over.status).toBe(502);
    expect(JSON.parse(over.body)).toEqual({
      error: "session too large to refresh",
      code: "messages_too_large",
    });
  });

  it("composes async=1 with project and leaves the list routes unchanged", async () => {
    const f = fixture();
    const upstream = await fakeOpencodeHandler((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end("[]");
        return;
      }
      if (incoming.method === "GET" && incoming.url === "/session/ses_1/message") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end("[]");
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/session/ses_1/prompt_async") {
        noContent(outgoing);
        return;
      }
      outgoing.writeHead(404);
      outgoing.end("missing");
    });
    useUpstream(f.deps, upstream.endpoint);

    const sessions = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions",
        query: { project: "p2" },
        headers: auth(f.token),
      }),
    );
    expect(sessions.status).toBe(200);
    expect(JSON.parse(sessions.body)).toEqual({ sessions: [] });

    const messages = await handleChat(
      f.deps,
      request({
        path: "/api/apps/storefront/sessions/ses_1/messages",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(messages.status).toBe(200);
    expect(JSON.parse(messages.body)).toEqual({ messages: [] });

    const sent = await handleChat(
      f.deps,
      asyncRequest({ headers: auth(f.token), query: { project: "p2", async: "1" } }),
    );
    expect(sent.status).toBe(202);
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /session",
      "GET /session/ses_1/message",
      "POST /session/ses_1/prompt_async",
    ]);
  });
});

describe("start route", () => {
  it("is human-only and requires an authenticated principal", async () => {
    const f = fixture();
    const anonymous = await handleChat(f.deps, {
      method: "POST",
      path: "/api/apps/storefront/start",
      query: { project: "p1" },
      headers: {},
    });
    expect(anonymous.status).toBe(401);

    const agent = createPrincipal(f.db, { kind: "agent", name: "bot" });
    const forbidden = await handleChat(f.deps, {
      method: "POST",
      path: "/api/apps/storefront/start",
      query: { project: "p1" },
      headers: auth(agent.token),
    });
    expect(forbidden.status).toBe(403);
  });

  it("scopes the lookup to the project query and starts through manager.ensure", async () => {
    const f = fixture();
    const ensure = vi.fn(async () => "http://127.0.0.1:1");
    f.deps.manager = { ensure } as unknown as InstanceManager;

    const response = await handleChat(f.deps, {
      method: "POST",
      path: "/api/apps/storefront/start",
      query: { project: "p2" },
      headers: auth(f.token),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ appId: "p2:storefront", state: "running" });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({ projectId: "p2", appKey: "storefront" });
  });

  it("rejects a cross-site start before ensure", async () => {
    const f = fixture();
    const ensure = vi.fn(async () => "http://127.0.0.1:1");
    f.deps.manager = { ensure } as unknown as InstanceManager;

    const response = await handleChat(f.deps, {
      method: "POST",
      path: "/api/apps/storefront/start",
      query: { project: "p1" },
      headers: auth(f.token),
      origin: "https://evil.example",
      host: "localhost",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "cross-site request rejected",
      code: "cross_site_request",
    });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("returns the typed 409 when no usable image exists", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new ImageNotReadyError(
          imageStateView({ appId: "p1:storefront", state: "not_ready" }),
        );
      },
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, {
      method: "POST",
      path: "/api/apps/storefront/start",
      query: { project: "p1" },
      headers: auth(f.token),
    });

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "image_not_ready",
      code: "image_not_ready",
      appId: "p1:storefront",
      state: "not_ready",
      imageStatus: "missing",
      buildConfigured: true,
    });
  });

  it("returns the typed 503 when the default image is unavailable", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DefaultImageUnavailableError(
          imageStateView({ appId: "p1:storefront", buildConfigured: false, state: "unknown" }),
        );
      },
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, {
      method: "POST",
      path: "/api/apps/storefront/start",
      query: { project: "p1" },
      headers: auth(f.token),
    });

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "default_image_unavailable",
      code: "default_image_unavailable",
      appId: "p1:storefront",
      state: "unknown",
    });
  });

  it("reconnects a running app without restarting it", async () => {
    const f = fixture();
    const beginRestart = vi.fn(() => ({ accepted: true, completion: Promise.resolve(true) }));
    const restartIfRunning = vi.fn(async () => true);
    f.deps.manager = {
      ensure: async () => "http://127.0.0.1:1",
      beginRestart,
      restartIfRunning,
    } as unknown as InstanceManager;

    const response = await handleChat(f.deps, {
      method: "POST",
      path: "/api/apps/storefront/start",
      query: { project: "p1" },
      headers: auth(f.token),
    });

    expect(response.status).toBe(200);
    expect(beginRestart).not.toHaveBeenCalled();
    expect(restartIfRunning).not.toHaveBeenCalled();
  });
});
