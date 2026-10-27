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
import { handleChat, streamSessionEvents } from "../src/http/chat.js";
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
import { PreviewService } from "../src/preview/service.js";
import { SettingsService } from "../src/settings/index.js";
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
    expect(response.body).toContain('data-runtime-url="/api/apps/storefront/runtime?project=p1"');
    expect(response.body).toContain('id="chat-composer"');
    expect(response.body).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content" />',
    );
    expect(response.body).toContain('enterkeyhint="enter"');
    expect(response.body).toContain('id="chat-context"');
    expect(response.body).toContain("data-chat-context-toggle");
    expect(response.body).toContain("/assets/chat.js");
    expect(response.body).toContain('<script type="module" src="/assets/chat.js"></script>');
    expect(response.body).not.toContain('<script src="/assets/chat.js" defer></script>');
    expect(response.body).toContain('aria-live="off"');
    expect(response.body).not.toContain("aria-relevant");
    expect(response.body).toContain('id="chat-working-label"');
    expect(response.body).toContain('id="chat-working-elapsed"');
    expect(response.body).toContain('id="chat-working-queued"');
    expect(response.body).toContain('class="chat-working__label"');
    expect(response.body).toContain('class="chat-working__elapsed"');
    expect(response.body).toContain('class="chat-working__queued"');
    expect(response.body).toContain('<optgroup label="Alpha">');
    expect(response.body).toContain("Message storefront agent");
    expect(response.body).not.toMatch(/id="chat-prompt"[^>]*\brequired\b/);
    expect(response.body).toContain('href="/projects/p1/apps/storefront"');
    expect(response.body).toContain(">Application</a>");
    expect(response.body).toContain(
      'class="policy-warning" id="chat-policy-warning" role="status"',
    );
    expect(response.body).toContain('class="prompt-dock" id="chat-prompt-dock"');
    expect(response.body).toContain('class="chat-queue-strip" id="chat-queue-strip"');
    expect(response.body).toContain('id="chat-queue-strip-count"');
    expect(response.body).toContain('id="chat-queue-strip-list"');
    expect(response.body).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(response.body).toContain('class="chat-session-notice" id="chat-session-notice"');
    expect(response.body).toContain("Session too large to refresh; showing the last loaded state.");
    expect(response.body).toContain('id="chat-send-recovery"');
    expect(response.body).toContain("Delivery unknown; checking…");
    expect(response.body).toContain('id="chat-send-check"');
    expect(response.body).toContain('id="chat-send-remove"');
    expect(response.body).toContain('id="chat-input-needed"');
    expect(response.body).toContain('id="chat-input-needed-count"');
    expect(response.body).toContain('id="chat-policy-chip"');
    expect(response.body).toContain('id="chat-waiting"');
    expect(response.body).toContain('id="chat-plan-chip"');
    expect(response.body).toContain('<hr class="rule" id="chat-plan-divider" hidden />');
    expect(response.body).toContain(
      'id="chat-plan-section" aria-labelledby="context-plan-title" hidden',
    );
    expect(response.body).toContain('id="context-plan-title"');
    expect(response.body).toContain('id="chat-plan-list"');
    expect(response.body).toContain('<hr class="rule" id="chat-saved-divider" hidden />');
    expect(response.body).toContain('id="chat-saved-section"');
    expect(response.body).toContain('id="chat-saved-list"');
    expect(response.body).toContain('class="btn btn-ghost btn-sm chat-context-chip"');
    expect(response.body).toContain('id="chat-context-chip"');
    expect(response.body).toContain(
      'id="chat-context-chip" type="button" aria-controls="chat-context-usage" hidden',
    );
    expect(response.body).toContain('id="chat-context-chip-label">Context —<');
    expect(response.body).toContain('id="chat-context-chip-exact"');
    expect(response.body).toContain('class="chat-context__section chat-context-usage"');
    expect(response.body).toContain('id="chat-context-usage"');
    expect(response.body).toContain('aria-labelledby="context-usage-title"');
    expect(response.body).toContain('id="context-usage-title"');
    expect(response.body).toContain('id="chat-context-summary">—<');
    expect(response.body).toContain(
      'id="chat-context-meter" role="meter" aria-label="Context usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Unknown"',
    );
    expect(response.body).toContain('id="chat-context-meter-fill"');
    expect(response.body).toContain('id="chat-context-detail">Waiting for a completed step.<');
    expect(response.body).toContain('id="chat-context-auto">Auto-compact off<');
    expect(response.body).toContain(
      'id="chat-context-settings" href="/projects/p1/apps/storefront/settings"',
    );
    expect(response.body).toContain('id="chat-context-compact" type="button" disabled');
    expect(response.body).toContain('aria-describedby="chat-context-compact-reason"');
    expect(response.body).toContain("Start a session to compact.");
    expect(response.body).toContain('id="chat-context-confirm" hidden');
    expect(response.body).toContain(
      "Summarization replaces the session history and can lose detail.",
    );
    expect(response.body).toContain(
      'class="btn btn-danger btn-sm" id="chat-context-confirm-compact"',
    );
    expect(response.body).toContain(
      'class="btn btn-ghost btn-sm" id="chat-context-confirm-cancel"',
    );
    expect(response.body).toContain('id="chat-context-error" role="alert" hidden');
    expect(response.body).toContain('id="chat-announcer"');
    expect(response.body).toContain('aria-live="polite"');
    expect(response.body).toContain('id="chat-queue"');
    expect(response.body).toContain('id="chat-composer-hint-text"');
    expect(response.body).toContain('id="chat-question-placeholder"');
    const messages = response.body.indexOf('id="chat-messages"');
    const questionPlaceholder = response.body.indexOf('id="chat-question-placeholder"');
    const history = response.body.indexOf('id="chat-history"');
    const generating = response.body.indexOf('id="chat-generating"');
    expect(messages).toBeGreaterThan(-1);
    expect(questionPlaceholder).toBeGreaterThan(messages);
    expect(history).toBeGreaterThan(-1);
    expect(history).toBeLessThan(messages);
    expect(generating).toBeGreaterThan(messages);
    expect(generating).toBeLessThan(questionPlaceholder);
    expect(response.body).toContain('id="chat-history-label"');
    expect(response.body).toContain('id="chat-generating-label"');
    expect(response.body).toContain('id="chat-generating-elapsed"');
    expect(response.body).toMatch(/id="chat-generating"[^>]*aria-hidden="true"/);
    const ids = Array.from(response.body.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(response.body).not.toContain('class="page-header"');
    const application = response.body.indexOf('id="context-app-title"');
    const usage = response.body.indexOf('id="context-usage-title"');
    const plan = response.body.indexOf('id="context-plan-title"');
    const saved = response.body.indexOf('id="context-saved-title"');
    const handoffs = response.body.indexOf('id="context-handoffs-title"');
    const shortcuts = response.body.indexOf('id="context-shortcuts-title"');
    expect(application).toBeLessThan(usage);
    expect(usage).toBeLessThan(plan);
    expect(plan).toBeLessThan(saved);
    expect(saved).toBeLessThan(handoffs);
    expect(handoffs).toBeLessThan(shortcuts);
  });

  it("renders hidden image gate and warning containers before the thread", async () => {
    const f = fixture();
    const response = await handleChat(
      f.deps,
      request({
        query: { app: "storefront", project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain(
      '<section class="chat-image-gate" id="image-gate" role="region" aria-live="polite" hidden></section>',
    );
    expect(response.body).toContain(
      '<div class="chat-image-warning" id="image-warning" role="status" hidden></div>',
    );
    expect(response.body).toContain('id="chat-composer"');
    const gate = response.body.indexOf('id="image-gate"');
    const warning = response.body.indexOf('id="image-warning"');
    const scroll = response.body.indexOf('id="chat-scroll"');
    const composer = response.body.indexOf('id="chat-composer"');
    expect(gate).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(gate);
    expect(scroll).toBeGreaterThan(warning);
    expect(composer).toBeGreaterThan(warning);
  });

  it("renders the command palette, confirm dialog, and command data attributes", async () => {
    const f = fixture();
    const response = await handleChat(
      f.deps,
      request({ query: { app: "storefront", project: "p1" }, headers: auth(f.token) }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain('id="chat-command-palette"');
    expect(response.body).toContain('id="chat-command-listbox"');
    expect(response.body).toContain('role="listbox" aria-label="Slash commands"');
    expect(response.body).toContain('id="chat-command-status"');
    expect(response.body).toContain('id="chat-command-shadow"');
    expect(response.body).toContain('id="chat-commands-button"');
    expect(response.body).toContain('aria-label="Commands"');
    expect(response.body).toContain('id="chat-command-confirm"');
    expect(response.body).toContain('class="dialog command-confirm"');
    expect(response.body).toContain('aria-modal="true"');
    expect(response.body).toContain('aria-labelledby="chat-command-confirm-title"');
    expect(response.body).toContain('id="chat-command-confirm-body"');
    expect(response.body).toContain('id="chat-command-confirm-cancel"');
    expect(response.body).toContain('id="chat-command-confirm-accept"');
    expect(response.body).toContain('role="combobox"');
    expect(response.body).toContain('aria-autocomplete="list"');
    expect(response.body).toContain('aria-haspopup="listbox"');
    expect(response.body).toContain('aria-controls="chat-command-listbox"');
    expect(response.body).toContain('aria-expanded="false"');
    expect(response.body).toContain('data-ide-url="/ide/?folder=');
    expect(response.body).toContain('data-app-url="/projects/p1/apps/storefront"');
    expect(response.body).not.toContain('data-master="1"');
    const palette = response.body.indexOf('id="chat-command-palette"');
    const composer = response.body.indexOf('id="chat-composer"');
    const dock = response.body.indexOf('id="chat-prompt-dock"');
    expect(dock).toBeGreaterThan(-1);
    expect(palette).toBeGreaterThan(dock);
    expect(palette).toBeLessThan(composer);
  });

  it("marks the master chat shell with data-master", async () => {
    const f = fixture();
    addProject(f.db, "hanse-master", "Hanse master", [{ key: "master", path: ".hanse-master" }]);
    const response = await handleChat(
      f.deps,
      request({
        query: { app: "master", project: "hanse-master" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain('data-master="1"');
  });

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

  it("keeps command palette wiring free of template interpolation and innerHTML", () => {
    const f = fixture();
    const response = handleRequest(f.deps, {
      method: "GET",
      path: "/assets/chat.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('from "./chat-commands.js"');
    expect(response.body).toContain("function dispatchComposerDraft()");
    expect(response.body).toContain("if (paletteOpen)");
    expect(response.body).toContain("sendServerCommand");
    expect(response.body).not.toContain("innerHTML");
    expect(response.body).not.toContain("template");
  });

  it("shows settings, a pending restart marker, and a restart action without leaking keys", async () => {
    const f = fixture();
    f.settings.setProviderKey("global", {}, "deepseek", "sk-chat-secret", "owner");
    f.deps.manager = {
      pendingRestart: (appId: string) =>
        appId === "p1:storefront"
          ? { pending: true, reasons: ["settings_changed"] }
          : { pending: false, reasons: [] },
    } as unknown as InstanceManager;

    const response = await handleChat(
      f.deps,
      request({ query: { app: "storefront", project: "p1" }, headers: auth(f.token) }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain('href="/projects/p1/apps/storefront/settings"');
    expect(response.body).toContain('id="chat-settings-pending"');
    expect(response.body).toContain("Restart required");
    expect(response.body).toContain('action="/api/apps/storefront/restart?project=p1"');
    expect(response.body).not.toContain("sk-chat-secret");
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
    expect(response.body).toContain("async=1");
    expect(response.body).toContain("function sendPrompt()");
    expect(response.body).toContain("rekeyOptimistic");
    expect(response.body).toContain("chat-queue-strip");
    expect(response.body).toContain("chat-prompt-dock");
    expect(response.body).toContain("allPendingForSession");
    expect(response.body).toContain("dockRenderEntries");
    expect(response.body).toContain("dataset.correlationKey");
    expect(response.body).toContain("Question part unavailable");
    expect(response.body).toContain("Answered elsewhere");
    expect(response.body).toContain("message--system");
    expect(response.body).toContain("message--pending");
    expect(response.body).toContain("omo-card__details");
    expect(response.body).toContain("classificationPending");
    expect(response.body).toContain("tool-todo__item");
    expect(response.body).toContain("tool-call__truncated");
    expect(response.body).toContain("tool-call__view");
    expect(response.body).toContain("apply_patch");
    expect(response.body).toContain('from "./chat-core.js"');
    expect(response.body).toContain('from "./chat-diff.js"');
    expect(response.body).toContain('from "./chat-highlight.js"');
    expect(response.body).toContain('from "./markdown.js"');
    expect(response.body).toContain("extractToolView");
    expect(response.body).toContain("mountToolView");
    expect(response.body).toContain('type === "context.updated"');
    expect(response.body).not.toContain("innerHTML");
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

  it("polls the runtime endpoint and never guesses the runtime chip", () => {
    const f = fixture();
    const response = handleRequest(f.deps, {
      method: "GET",
      path: "/assets/chat.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("function refreshRuntime()");
    expect(response.body).toContain("function runtimeChip(");
    expect(response.body).toContain("function toolStatusChip(");
    expect(response.body).toContain('credentials: "same-origin"');
    expect(response.body).toContain('cache: "no-store"');
    expect(response.body).toContain("RUNTIME_POLL_MS = 10000");
    expect(response.body).toContain("Runtime status unavailable");
    expect(response.body).toContain("syncRuntimePolling");
    expect(response.body).toContain('setConnection("Starting agent...", "starting")');
    expect(response.body).not.toContain("setRuntime(");
    expect(response.body).not.toContain("setLive(");
  });

  it("keeps runtime and connection untouched by hydration, sends, errors, and session switches", () => {
    const source = readFileSync(path.join(process.cwd(), "assets", "chat.js"), "utf8");
    for (const name of [
      "hydrateMessages",
      "selectSession",
      "startDraft",
      "ensureSession",
      "sendPrompt",
      "showThreadError",
    ]) {
      const body = source.slice(source.indexOf(`function ${name}(`));
      const next = body.slice(1).search(/\n {2}(?:async )?function /);
      const scope = next === -1 ? body : body.slice(0, next + 1);
      expect(scope, name).not.toContain("setConnection(");
      expect(scope, name).not.toContain("setRuntime(");
    }
    const savedStore = source.slice(source.indexOf("function savedStoreFor("));
    const savedScope = savedStore.slice(
      0,
      savedStore.slice(1).search(/\n {2}(?:async )?function /) + 1,
    );
    expect(savedScope).not.toContain("connection:");
  });

  it("switches the session before the draft flush and paints the loading placeholder", () => {
    const source = readFileSync(path.join(process.cwd(), "assets", "chat.js"), "utf8");
    const start = source.indexOf("function selectSession(");
    const end = source.indexOf("\n  function startDraft(", start);
    const scope = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(scope).not.toContain("await flushDraftForSwitch");
    expect(scope).toContain("showMessagesLoading();");
    expect(scope.indexOf("sessionId = id;")).toBeLessThan(scope.indexOf("await Promise.all"));
    expect(scope).toContain("abortHydrationFetch();");
    expect(scope).toContain("selectionSeq !== selection");
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
    const modules = ["chat.js", "chat-diff.js", "chat-highlight.js", "chat-highlight-worker.js"];
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
    f.deps.manager = managerFor(upstream.endpoint, counters);

    const response = await handleChat(f.deps, abortRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ aborted: true });
    expect(upstream.calls).toEqual([{ method: "POST", url: "/session/ses_1/abort", body: "" }]);
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

  it("starts the agent through ensure when no endpoint is attached", async () => {
    const f = fixture();
    const upstream = await emptyUpstream();
    const calls = counters();
    f.deps.manager = readManager(undefined, upstream.endpoint, calls);

    const response = await handleChat(f.deps, sessionsRequest(f));

    expect(response.status).toBe(200);
    expect(calls).toEqual({ ensure: 1, endpoint: 1 });
  });

  it("falls back to ensure when the attached endpoint stops answering", async () => {
    const f = fixture();
    const upstream = await emptyUpstream();
    const calls = counters();
    f.deps.manager = readManager("http://127.0.0.1:1", upstream.endpoint, calls);

    const response = await handleChat(f.deps, messagesRequest(f));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ messages: [], nextCursor: null });
    expect(calls).toEqual({ ensure: 1, endpoint: 1 });
    expect(upstream.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /session/ses_1/message?limit=30",
    ]);
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

  it("maps a pending deletion on the SSE ensure path to 409", async () => {
    const f = fixture();
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

  it("maps a deployment lock on the SSE ensure path to 409", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DeploymentInProgressError("ensure", { phase: "switching" });
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
      error: "deployment_in_progress",
      message: "deployment in progress: switching",
      retryAfter: 30,
    });
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

describe("chat previews rail", () => {
  function chatRequest(f: Fixture): HttpRequest {
    return request({ query: { app: "storefront", project: "p1" }, headers: auth(f.token) });
  }

  function previewServiceFor(
    entries: Array<{ key: string; name: string; port?: number }>,
  ): PreviewService {
    let clock = 1_700_000_000_000;
    const service = new PreviewService({ now: () => (clock += 1_000) });
    for (const entry of entries) {
      service.open({
        appId: "p1:storefront",
        projectId: "p1",
        appKey: "storefront",
        key: entry.key,
        name: entry.name,
        port: entry.port ?? 3000,
        targetHost: "storefront",
      });
    }
    return service;
  }

  it("always renders the wrapper and hides it when there are no previews", async () => {
    const f = fixture();
    const response = await handleChat(f.deps, chatRequest(f));
    expect(response.status).toBe(200);
    expect(response.body).toContain('<div class="chat-context__group" id="chat-previews" hidden>');
    expect(response.body).toContain('id="chat-previews-count">0 active<');
    expect(response.body).not.toMatch(/<li class="chat-preview"/);
  });

  it("keeps the divider inside the hidden wrapper so an empty block leaves no rule", async () => {
    const f = fixture();
    const response = await handleChat(f.deps, chatRequest(f));
    const start = response.body.indexOf('id="chat-previews"');
    const end = response.body.indexOf('<section class="chat-context__section chat-context-usage"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = response.body.slice(start, end);
    expect(block).toContain('<hr class="rule" />');
    expect(block.match(/<hr class="rule" \/>/g)).toHaveLength(1);
    expect(block).toContain('aria-labelledby="context-previews-title"');
  });

  it("renders one ruled row per preview with the server URL and new-tab link", async () => {
    const f = fixture();
    f.deps.previews = previewServiceFor([
      { key: "api-docs", name: "API docs" },
      { key: "storefront", name: "Storefront" },
    ]);
    const response = await handleChat(f.deps, chatRequest(f));
    const body = response.body;
    expect(body).toContain('<div class="chat-context__group" id="chat-previews">');
    expect(body).toContain('id="chat-previews-count">2 active<');
    expect(body).toContain('class="chat-preview" data-preview-key="api-docs"');
    expect(body).toContain('class="chat-preview" data-preview-key="storefront"');
    expect(body).toContain('href="/preview/p1/storefront/storefront/"');
    expect(body).toContain('href="/preview/p1/storefront/api-docs/"');
    expect(body).toContain('target="_blank" rel="noopener noreferrer"');
    expect(body).toContain(
      '<span class="chat-preview__key mono" title="storefront">storefront</span>',
    );
    expect(body).toContain("(opens in a new tab)");
    expect(body).toContain('aria-label="Close preview Storefront" hidden');
    expect(body).toContain('aria-label="Close preview API docs" hidden');
    // Newest first: storefront was opened after api-docs.
    expect(body.indexOf('data-preview-key="storefront"')).toBeLessThan(
      body.indexOf('data-preview-key="api-docs"'),
    );
  });

  it("escapes preview names in text, title, and the close accessible label", async () => {
    const f = fixture();
    f.deps.previews = previewServiceFor([{ key: "xss", name: "<script>alert(1)</script>" }]);
    const response = await handleChat(f.deps, chatRequest(f));
    expect(response.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(response.body).toContain(
      'aria-label="Close preview &lt;script&gt;alert(1)&lt;/script&gt;"',
    );
    expect(response.body).not.toContain("<script>alert(1)</script>");
  });

  it("inserts the block after Application and before Context usage", async () => {
    const f = fixture();
    f.deps.previews = previewServiceFor([{ key: "web", name: "Web" }]);
    const response = await handleChat(f.deps, chatRequest(f));
    const body = response.body;
    const application = body.indexOf('id="context-app-title"');
    const wrapper = body.indexOf('id="chat-previews"');
    const heading = body.indexOf('id="context-previews-title"');
    const usage = body.indexOf('id="context-usage-title"');
    expect(application).toBeGreaterThan(-1);
    expect(wrapper).toBeGreaterThan(application);
    expect(heading).toBeGreaterThan(wrapper);
    expect(usage).toBeGreaterThan(heading);
  });

  it("does not change the wrapper contract for multiple app scopes", async () => {
    const f = fixture();
    f.deps.previews = previewServiceFor([{ key: "p1-only", name: "P1 only" }]);
    const other = await handleChat(
      f.deps,
      request({
        query: { app: "storefront", project: "p2" },
        headers: auth(f.token),
      }),
    );
    expect(other.status).toBe(200);
    expect(other.body).toContain('<div class="chat-context__group" id="chat-previews" hidden>');
    expect(other.body).not.toContain('data-preview-key="p1-only"');
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
