import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentInProgressError } from "../src/coordinator/deployment-lock.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleCommands, isCommandsRoute } from "../src/http/commands.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { Logger } from "../src/logging/logger.js";
import { OpencodeHttpError, runSessionCommand } from "../src/opencode/client.js";
import { MASTER_DISABLED_REASON } from "../src/opencode/commands.js";
import {
  DeletionPendingError,
  type InstanceManager,
  type ManagedApp,
} from "../src/opencode/manager.js";
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
          server.closeAllConnections();
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
  vi.restoreAllMocks();
});

const LIST = "/api/apps/storefront/commands";
const SEND = "/api/apps/storefront/sessions/ses_1/commands";

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown>;
}

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
  logs: LogEntry[];
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

function captureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const push =
    (level: LogEntry["level"]) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      entries.push({ level, message, fields });
    };
  return {
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
    entries,
  };
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-commands-http-"));
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
  const { logger, entries } = captureLogger();
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    getProjects: () =>
      (
        db
          .prepare("SELECT id, name, root_path, deleting FROM projects ORDER BY rowid")
          .all() as Array<{
          id: string;
          name: string;
          root_path: string;
          deleting: number | null;
        }>
      ).map((row) => ({
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        workspaceRoot: "/tmp",
        deleting: row.deleting === 1,
        service: new CoordinatorService(db, row.id),
      })),
    logger,
  };
  return { db, deps, token, logs: entries };
}

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function listRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", path: LIST, headers: {}, query: { project: "p1" }, ...overrides };
}

function sendRequest(
  token: string,
  body: unknown,
  overrides: Partial<HttpRequest> = {},
): HttpRequest {
  return listRequest({
    method: "POST",
    path: SEND,
    headers: auth(token, { "content-type": "application/json" }),
    body: JSON.stringify(body),
    host: "hanse.test",
    ...overrides,
  });
}

interface Calls {
  ensure: ManagedApp[];
  isRunning: string[];
}

function managerStub(
  options: {
    endpoint?: string;
    running?: boolean;
    ensure?: (app: ManagedApp) => Promise<string>;
  } = {},
): { manager: InstanceManager; calls: Calls } {
  const calls: Calls = { ensure: [], isRunning: [] };
  const endpoint = options.endpoint ?? "http://127.0.0.1:1";
  const manager = {
    isRunning: (appId: string): boolean => {
      calls.isRunning.push(appId);
      return options.running ?? true;
    },
    ensure: async (app: ManagedApp): Promise<string> => {
      calls.ensure.push(app);
      return options.ensure === undefined ? endpoint : options.ensure(app);
    },
  } as unknown as InstanceManager;
  return { manager, calls };
}

interface UpstreamCall {
  method: string;
  url: string;
  body: string;
}

interface Reply {
  status?: number;
  body?: unknown;
  delayMs?: number;
  hang?: boolean;
}

interface UpstreamBehaviour {
  list?: (index: number) => Reply;
  send?: (body: string, index: number) => Reply;
}

async function fakeUpstream(
  behaviour: UpstreamBehaviour = {},
): Promise<{ endpoint: string; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  let listIndex = 0;
  let sendIndex = 0;
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("error", () => undefined);
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const method = incoming.method ?? "";
      const url = incoming.url ?? "";
      calls.push({ method, url, body });
      let reply: Reply;
      if (method === "GET" && url === "/command") {
        reply = behaviour.list?.(listIndex) ?? { body: [] };
        listIndex += 1;
      } else if (method === "POST" && url.startsWith("/session/")) {
        reply = behaviour.send?.(body, sendIndex) ?? {
          body: { info: { id: "msg_upstream" }, parts: [] },
        };
        sendIndex += 1;
      } else {
        reply = { status: 404, body: { error: "not found" } };
      }
      if (reply.hang === true) {
        return;
      }
      const send = (): void => {
        if (outgoing.destroyed || outgoing.writableEnded) {
          return;
        }
        const payload =
          typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? null);
        try {
          outgoing.writeHead(reply.status ?? 200, { "content-type": "application/json" });
          outgoing.end(payload);
        } catch {
          // The client aborted; nothing to send.
        }
      };
      if (reply.delayMs !== undefined && reply.delayMs > 0) {
        setTimeout(send, reply.delayMs);
      } else {
        send();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}`, calls };
}

function listCalls(calls: UpstreamCall[]): UpstreamCall[] {
  return calls.filter((call) => call.method === "GET" && call.url === "/command");
}

function sendCalls(calls: UpstreamCall[]): UpstreamCall[] {
  return calls.filter((call) => call.method === "POST" && call.url.startsWith("/session/"));
}

function parsed(response: HttpResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function commands(response: HttpResponse): Array<Record<string, unknown>> {
  return parsed(response).commands as Array<Record<string, unknown>>;
}

function findCommand(response: HttpResponse, name: string): Record<string, unknown> | undefined {
  return commands(response).find((entry) => entry.name === name);
}

function warningCodes(response: HttpResponse): string[] {
  return (parsed(response).warnings as Array<{ code: string }>).map((warning) => warning.code);
}

function useManager(f: Fixture, stub: { manager: InstanceManager }): void {
  f.deps.manager = stub.manager;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("isCommandsRoute", () => {
  it("matches both command paths regardless of method", () => {
    expect(isCommandsRoute("GET", LIST)).toBe(true);
    expect(isCommandsRoute("POST", LIST)).toBe(true);
    expect(isCommandsRoute("GET", SEND)).toBe(true);
    expect(isCommandsRoute("DELETE", SEND)).toBe(true);
  });

  it("does not match neighbouring routes", () => {
    expect(isCommandsRoute("GET", "/api/apps/storefront/sessions/ses_1/messages")).toBe(false);
    expect(isCommandsRoute("GET", "/api/apps/storefront/commands/extra")).toBe(false);
    expect(isCommandsRoute("GET", "/api/apps/storefront/runtime")).toBe(false);
    expect(isCommandsRoute("GET", "/chat")).toBe(false);
  });
});

describe("GET commands: authentication and lookup", () => {
  it("returns 401 without a principal", async () => {
    const f = fixture();
    const response = await handleCommands(f.deps, listRequest());
    expect(response.status).toBe(401);
    expect(parsed(response)).toEqual({
      error: "Sign in required.",
      code: "sign_in_required",
    });
  });

  it("returns 403 for an agent principal before probing the app", async () => {
    const f = fixture();
    const token = createPrincipal(f.db, { kind: "agent", name: "bot" }).token;
    const response = await handleCommands(
      f.deps,
      listRequest({ path: "/api/apps/missing/commands", headers: auth(token) }),
    );
    expect(response.status).toBe(403);
    expect(parsed(response)).toEqual({
      error: "Only a human principal may run commands.",
      code: "human_only",
    });
  });

  it("returns the merged list for a human principal", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", description: "Create AGENTS.md", template: "text" }] }),
    });
    const stub = managerStub({ endpoint: upstream.endpoint });
    useManager(f, stub);

    const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(parsed(response).sources).toEqual({ hanse: "ok", opencode: "ok" });
    expect(findCommand(response, "new")).toMatchObject({ source: "hanse", shell: "none" });
    expect(findCommand(response, "init")).toMatchObject({
      source: "opencode",
      description: "Create AGENTS.md",
      shell: "none",
    });
    expect(stub.calls.isRunning).toEqual(["p1:storefront"]);
    expect(stub.calls.ensure).toHaveLength(1);
    expect(stub.calls.ensure[0]).toMatchObject({ id: "p1:storefront", appKey: "storefront" });
    expect(listCalls(upstream.calls)).toHaveLength(1);
  });

  it("disambiguates a shared app key with the project query", async () => {
    const f = fixture();
    const upstream = await fakeUpstream();
    const stub = managerStub({ endpoint: upstream.endpoint });
    useManager(f, stub);

    const response = await handleCommands(
      f.deps,
      listRequest({ query: { project: "p2" }, headers: auth(f.token) }),
    );

    expect(response.status).toBe(200);
    expect(stub.calls.ensure[0]).toMatchObject({ id: "p2:storefront", projectId: "p2" });
  });

  it("returns 404 unknown_app for an unknown app or project", async () => {
    const f = fixture();
    const upstream = await fakeUpstream();
    const stub = managerStub({ endpoint: upstream.endpoint });
    useManager(f, stub);

    for (const target of [
      { project: "p1", app: "missing" },
      { project: "p99", app: "storefront" },
      { project: "p2", app: "api" },
    ]) {
      const response = await handleCommands(
        f.deps,
        listRequest({
          path: `/api/apps/${target.app}/commands`,
          query: { project: target.project },
          headers: auth(f.token),
        }),
      );
      expect(response.status).toBe(404);
      expect(parsed(response)).toEqual({
        error: "Unknown application.",
        code: "unknown_app",
      });
    }
    expect(stub.calls.ensure).toEqual([]);
  });

  it("returns 405 for a wrong method on either path", async () => {
    const f = fixture();
    const stub = managerStub();
    useManager(f, stub);

    const listPost = await handleCommands(
      f.deps,
      listRequest({ method: "POST", headers: auth(f.token), body: "" }),
    );
    expect(listPost.status).toBe(405);
    expect(parsed(listPost).code).toBe("method_not_allowed");

    const sendGet = await handleCommands(
      f.deps,
      listRequest({ path: SEND, headers: auth(f.token) }),
    );
    expect(sendGet.status).toBe(405);
    expect(parsed(sendGet)).toEqual({
      error: "Method not allowed.",
      code: "method_not_allowed",
      outcome: "not_sent",
    });
    expect(stub.calls.ensure).toEqual([]);
  });
});

describe("GET commands: runtime states and deletion", () => {
  it("returns a Hanse-only list when no manager is configured", async () => {
    const f = fixture();
    const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(parsed(response).sources).toEqual({ hanse: "ok", opencode: "unconfigured" });
    expect(warningCodes(response)).toEqual(["agent_runtime_unconfigured"]);
    expect((parsed(response).warnings as Array<{ message: string }>)[0]?.message).toBe(
      "No agent runtime is configured; Hanse commands still work.",
    );
    expect(findCommand(response, "new")).toBeDefined();
    expect(commands(response).every((entry) => entry.source === "hanse")).toBe(true);
  });

  it("returns a Hanse-only list for a stopped app without starting it", async () => {
    const f = fixture();
    const stub = managerStub({ running: false });
    useManager(f, stub);

    const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(parsed(response).sources).toEqual({ hanse: "ok", opencode: "stopped" });
    expect(warningCodes(response)).toEqual(["agent_stopped"]);
    expect((parsed(response).warnings as Array<{ message: string }>)[0]?.message).toBe(
      "Application commands load when the agent starts.",
    );
    expect(stub.calls.isRunning).toEqual(["p1:storefront"]);
    expect(stub.calls.ensure).toEqual([]);
  });

  it("checks app and project deletion markers before any runtime branch", async () => {
    const appDeleting = fixture();
    appDeleting.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run("p1:storefront");
    const stub = managerStub({ running: false });
    useManager(appDeleting, stub);

    const appResponse = await handleCommands(
      appDeleting.deps,
      listRequest({ headers: auth(appDeleting.token) }),
    );
    expect(appResponse.status).toBe(409);
    expect(parsed(appResponse)).toEqual({
      error: "Application is pending deletion.",
      code: "deletion_pending",
    });
    expect(stub.calls.isRunning).toEqual([]);
    expect(stub.calls.ensure).toEqual([]);

    const projectDeleting = fixture();
    projectDeleting.db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run("p1");
    const projectResponse = await handleCommands(
      projectDeleting.deps,
      listRequest({ headers: auth(projectDeleting.token) }),
    );
    expect(projectResponse.status).toBe(409);
    expect(parsed(projectResponse).code).toBe("deletion_pending");
  });

  it("maps a deletion-pending ensure to 409", async () => {
    const f = fixture();
    const stub = managerStub({
      ensure: async () => {
        throw new DeletionPendingError("p1:storefront");
      },
    });
    useManager(f, stub);

    const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(409);
    expect(parsed(response).code).toBe("deletion_pending");
    expect(listCalls([])).toEqual([]);
  });

  it("degrades to unavailable with 200 for upstream list failures", async () => {
    const cases: Array<(index: number) => Reply> = [
      () => ({ status: 404, body: { error: "missing" } }),
      () => ({ status: 500, body: { error: "boom" } }),
      () => ({ body: { not: "an array" } }),
    ];
    for (const list of cases) {
      const f = fixture();
      const upstream = await fakeUpstream({ list });
      const stub = managerStub({ endpoint: upstream.endpoint });
      useManager(f, stub);

      const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

      expect(response.status).toBe(200);
      expect(parsed(response).sources).toEqual({ hanse: "ok", opencode: "unavailable" });
      expect(warningCodes(response)).toEqual(["commands_unavailable"]);
      expect((parsed(response).warnings as Array<{ message: string }>)[0]?.message).toBe(
        "Application commands are unavailable; Hanse commands still work.",
      );
      expect(findCommand(response, "new")).toBeDefined();
      expect(commands(response).every((entry) => entry.source === "hanse")).toBe(true);
    }
  });
});

describe("GET commands: DTO, shell, warnings, and cache", () => {
  it("never returns templates and classifies the shell tri-state", async () => {
    const f = fixture();
    const templateSentinel = "TEMPLATE_SENTINEL";
    const upstream = await fakeUpstream({
      list: () => ({
        body: [
          { name: "plain", template: `plain ${templateSentinel}` },
          { name: "shell", template: `run !\`echo ${templateSentinel}\`` },
          { name: "mcp", template: {} },
          { name: "absent" },
        ],
      }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(response.body).not.toContain("template");
    expect(response.body).not.toContain(templateSentinel);
    for (const entry of commands(response)) {
      expect(Object.hasOwn(entry, "template")).toBe(false);
    }
    expect(findCommand(response, "plain")?.shell).toBe("none");
    expect(findCommand(response, "shell")?.shell).toBe("present");
    expect(findCommand(response, "mcp")?.shell).toBe("unknown");
    expect(findCommand(response, "absent")?.shell).toBe("unknown");
  });

  it("shadows a Hanse command and records the fixed warning", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "help", description: "upstream help", template: "text" }] }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(findCommand(response, "help")).toMatchObject({ source: "opencode" });
    expect(commands(response).filter((entry) => entry.name === "help")).toHaveLength(1);
    expect(warningCodes(response)).toContain("command_shadowed");
    const shadowed = (
      parsed(response).warnings as Array<{ code: string; message?: string; command?: string }>
    ).find((warning) => warning.code === "command_shadowed");
    expect(shadowed).toMatchObject({
      command: "help",
      message: "/help is provided by the application.",
    });
    expect(
      f.logs.some(
        (entry) => entry.message === "commands.list.shadowed" && entry.fields.command === "help",
      ),
    ).toBe(true);
  });

  it("disables editor and diff for the master application", async () => {
    const f = fixture();
    addProject(f.db, "hanse-master", "Hanse master", [{ key: "master", path: ".hanse-master" }]);
    const upstream = await fakeUpstream();
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(
      f.deps,
      listRequest({
        path: "/api/apps/master/commands",
        query: { project: "hanse-master" },
        headers: auth(f.token),
      }),
    );

    expect(response.status).toBe(200);
    expect(findCommand(response, "editor")).toMatchObject({
      available: false,
      unavailableReason: MASTER_DISABLED_REASON,
    });
    expect(findCommand(response, "diff")).toMatchObject({
      available: false,
      unavailableReason: MASTER_DISABLED_REASON,
    });
    expect(findCommand(response, "restart")).toMatchObject({ available: true });
  });

  it("caches summaries for 5 seconds per endpoint without caching templates", async () => {
    const f = fixture();
    const templateSentinel = "CACHE_TEMPLATE_SENTINEL";
    const upstream = await fakeUpstream({
      list: (index) =>
        index === 0
          ? { body: [{ name: "cached", description: "first", template: "plain text" }] }
          : {
              body: [
                {
                  name: "cached",
                  description: "second",
                  template: `run !\`echo ${templateSentinel}\``,
                },
              ],
            },
    });
    const stub = managerStub({ endpoint: upstream.endpoint });
    useManager(f, stub);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    const first = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));
    expect(findCommand(first, "cached")).toMatchObject({ description: "first", shell: "none" });

    const second = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));
    expect(findCommand(second, "cached")).toMatchObject({ description: "first", shell: "none" });
    expect(listCalls(upstream.calls)).toHaveLength(1);

    now.mockReturnValue(1_000_000 + 6_000);
    const third = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));
    expect(findCommand(third, "cached")).toMatchObject({ description: "second", shell: "present" });
    expect(listCalls(upstream.calls)).toHaveLength(2);
    expect(third.body).not.toContain("template");
    expect(third.body).not.toContain(templateSentinel);
    expect(third.body).not.toContain("echo");
  });

  it("drops extras beyond 500 per list with command_dropped", async () => {
    const f = fixture();
    const many = Array.from({ length: 501 }, (_, index) => ({
      name: `cmd${index}`,
      template: "plain",
    }));
    const upstream = await fakeUpstream({ list: () => ({ body: many }) });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(warningCodes(response)).toContain("command_dropped");
    const dropped = (parsed(response).warnings as Array<{ code: string; message?: string }>).find(
      (warning) => warning.code === "command_dropped",
    );
    expect(dropped?.message).toBe("Some application commands were skipped.");
    expect(warningCodes(response)).not.toContain("command_cap_reached");
  });

  it("caps the merged response at 1 MiB and keeps Hanse entries", async () => {
    const f = fixture();
    const description = "d".repeat(500);
    const hints = Array.from({ length: 10 }, () => "h".repeat(200));
    const many = Array.from({ length: 500 }, (_, index) => ({
      name: `big${index}`,
      description,
      hints,
      template: "plain",
    }));
    const upstream = await fakeUpstream({ list: () => ({ body: many }) });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(Buffer.byteLength(response.body, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    const capWarnings = (parsed(response).warnings as Array<{ code: string }>).filter(
      (warning) => warning.code === "command_cap_reached",
    );
    expect(capWarnings).toHaveLength(1);
    for (const name of ["new", "help", "editor", "compact", "diff", "restart"]) {
      expect(findCommand(response, name)).toBeDefined();
    }
  }, 20_000);

  it("logs no templates or descriptions", async () => {
    const f = fixture();
    const sentinel = "GET_LOG_SENTINEL";
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", description: sentinel, template: sentinel }] }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));

    expect(JSON.stringify(f.logs)).not.toContain(sentinel);
    expect(f.logs.some((entry) => entry.message === "commands.list")).toBe(true);
  });
});

describe("POST commands: validation and pre-dispatch failures", () => {
  it("returns 401 without a principal", async () => {
    const f = fixture();
    const response = await handleCommands(
      f.deps,
      listRequest({
        method: "POST",
        path: SEND,
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
    expect(parsed(response)).toEqual({
      error: "Sign in required.",
      code: "sign_in_required",
      outcome: "not_sent",
    });
  });

  it("returns 403 for an agent principal before probing the app", async () => {
    const f = fixture();
    const token = createPrincipal(f.db, { kind: "agent", name: "bot" }).token;
    const response = await handleCommands(
      f.deps,
      sendRequest(token, { name: "init" }, { path: "/api/apps/missing/sessions/ses_1/commands" }),
    );
    expect(response.status).toBe(403);
    expect(parsed(response).code).toBe("human_only");
  });

  it("rejects a cross-site Origin before app or body work", async () => {
    const f = fixture();
    const response = await handleCommands(
      f.deps,
      sendRequest(
        f.token,
        { name: "init" },
        {
          path: "/api/apps/missing/sessions/ses_1/commands",
          origin: "http://evil.test",
          host: "hanse.test",
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(parsed(response)).toEqual({
      error: "Cross-site request rejected.",
      code: "cross_site",
      outcome: "not_sent",
    });
  });

  it("accepts a same-origin Origin", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", template: "text" }] }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(
      f.deps,
      sendRequest(f.token, { name: "init" }, { origin: "http://hanse.test", host: "hanse.test" }),
    );

    expect(response.status).toBe(202);
    expect(sendCalls(upstream.calls)).toHaveLength(1);
  });

  it("requires application/json", async () => {
    const f = fixture();
    const response = await handleCommands(
      f.deps,
      listRequest({
        method: "POST",
        path: SEND,
        headers: auth(f.token, { "content-type": "text/plain" }),
        body: JSON.stringify({ name: "init" }),
      }),
    );
    expect(response.status).toBe(415);
    expect(parsed(response)).toEqual({
      error: "Content type must be application/json.",
      code: "unsupported_media_type",
      outcome: "not_sent",
    });
  });

  it("rejects malformed and non-object JSON", async () => {
    const f = fixture();
    for (const body of ["{", "[]", "null", "7"]) {
      const response = await handleCommands(f.deps, sendRequest(f.token, undefined, { body }));
      expect(response.status).toBe(400);
      expect(parsed(response)).toMatchObject({
        error: "Invalid JSON body.",
        code: "invalid_json",
        outcome: "not_sent",
      });
    }
  });

  it("rejects empty, invalid, and oversized names or arguments", async () => {
    const f = fixture();
    const cases: Array<{ body: unknown; code: string; message: string }> = [
      { body: {}, code: "empty_command", message: "Choose a command." },
      { body: { name: "" }, code: "empty_command", message: "Choose a command." },
      { body: { name: "bad name" }, code: "invalid_command", message: "Invalid command name." },
      { body: { name: "init", arguments: 7 }, code: "invalid_json", message: "Invalid JSON body." },
      {
        body: { name: "init", arguments: "a".repeat(32 * 1024 + 1) },
        code: "command_too_large",
        message: "Command arguments are too large.",
      },
    ];
    for (const target of cases) {
      const response = await handleCommands(f.deps, sendRequest(f.token, target.body));
      expect(response.status).toBe(400);
      expect(parsed(response)).toEqual({
        error: target.message,
        code: target.code,
        outcome: "not_sent",
      });
    }
  });

  it("returns 503 when no runtime is configured", async () => {
    const f = fixture();
    const response = await handleCommands(f.deps, sendRequest(f.token, { name: "init" }));
    expect(response.status).toBe(503);
    expect(parsed(response)).toEqual({
      error: "Agent runtime is not configured.",
      code: "agent_runtime_unconfigured",
      outcome: "not_sent",
    });
  });

  it("returns 404 unknown_app and checks deletion before ensure", async () => {
    const missing = fixture();
    const upstream = await fakeUpstream();
    const missingStub = managerStub({ endpoint: upstream.endpoint });
    useManager(missing, missingStub);

    const unknown = await handleCommands(
      missing.deps,
      sendRequest(
        missing.token,
        { name: "init" },
        {
          path: "/api/apps/missing/sessions/ses_1/commands",
        },
      ),
    );
    expect(unknown.status).toBe(404);
    expect(parsed(unknown).code).toBe("unknown_app");
    expect(missingStub.calls.ensure).toEqual([]);

    const deleting = fixture();
    deleting.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run("p1:storefront");
    const deletingStub = managerStub({ endpoint: upstream.endpoint });
    useManager(deleting, deletingStub);
    const deletion = await handleCommands(
      deleting.deps,
      sendRequest(deleting.token, { name: "init" }),
    );
    expect(deletion.status).toBe(409);
    expect(parsed(deletion).code).toBe("deletion_pending");
    expect(deletingStub.calls.ensure).toEqual([]);
  });

  it("maps ensure failures to agent_unavailable and lifecycle responses", async () => {
    const secret = "ENSURE_SENTINEL";
    const failing = fixture();
    useManager(
      failing,
      managerStub({
        ensure: async () => {
          throw new Error(secret);
        },
      }),
    );
    const unavailable = await handleCommands(
      failing.deps,
      sendRequest(failing.token, { name: "init" }),
    );
    expect(unavailable.status).toBe(502);
    expect(parsed(unavailable)).toEqual({
      error: "Agent is unavailable.",
      code: "agent_unavailable",
      outcome: "not_sent",
    });
    expect(unavailable.body).not.toContain(secret);

    const locked = fixture();
    useManager(
      locked,
      managerStub({
        ensure: async () => {
          throw new DeploymentInProgressError("ensure", { phase: "switching" });
        },
      }),
    );
    const lifecycle = await handleCommands(
      locked.deps,
      sendRequest(locked.token, { name: "init" }),
    );
    expect(lifecycle.status).toBe(409);
    expect(lifecycle.headers?.["retry-after"]).toBe("30");
    expect(parsed(lifecycle)).toMatchObject({ error: "deployment_in_progress" });
  });

  it("returns 404 after exactly two fresh list calls for an unknown command", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", template: "text" }] }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, sendRequest(f.token, { name: "missing" }));

    expect(response.status).toBe(404);
    expect(parsed(response)).toEqual({
      error: "Command not found; refresh the list.",
      code: "command_not_found",
      outcome: "not_sent",
    });
    expect(listCalls(upstream.calls)).toHaveLength(2);
    expect(sendCalls(upstream.calls)).toHaveLength(0);
  });

  it("never dispatches a Hanse action", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", template: "text" }] }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, sendRequest(f.token, { name: "help" }));

    expect(response.status).toBe(404);
    expect(parsed(response).code).toBe("command_not_found");
    expect(listCalls(upstream.calls)).toHaveLength(2);
    expect(sendCalls(upstream.calls)).toHaveLength(0);
  });

  it("maps a fresh list failure to 502 before dispatch", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({ list: () => ({ status: 500, body: { error: "boom" } }) });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, sendRequest(f.token, { name: "init" }));

    expect(response.status).toBe(502);
    expect(parsed(response)).toEqual({
      error: "Commands are unavailable.",
      code: "commands_unavailable",
      outcome: "not_sent",
    });
    expect(sendCalls(upstream.calls)).toHaveLength(0);
  });
});

describe("POST commands: shell confirmation", () => {
  it("re-derives the shell from a fresh list, not the GET cache", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: (index) =>
        index === 0
          ? { body: [{ name: "custom", template: "plain" }] }
          : { body: [{ name: "custom", template: "run !`echo hi`" }] },
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const cached = await handleCommands(f.deps, listRequest({ headers: auth(f.token) }));
    expect(findCommand(cached, "custom")?.shell).toBe("none");

    const response = await handleCommands(f.deps, sendRequest(f.token, { name: "custom" }));

    expect(response.status).toBe(400);
    expect(parsed(response)).toEqual({
      error: "Confirm the shell command before running it.",
      code: "shell_confirmation_required",
      outcome: "not_sent",
    });
    expect(listCalls(upstream.calls)).toHaveLength(2);
    expect(sendCalls(upstream.calls)).toHaveLength(0);
  });

  it("requires confirmation for an argument-injected shell block", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "custom", template: "plain" }] }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const blocked = await handleCommands(
      f.deps,
      sendRequest(f.token, { name: "custom", arguments: "please !`rm -rf /tmp/x`" }),
    );
    expect(blocked.status).toBe(400);
    expect(parsed(blocked).code).toBe("shell_confirmation_required");
    expect(sendCalls(upstream.calls)).toHaveLength(0);

    const accepted = await handleCommands(
      f.deps,
      sendRequest(f.token, {
        name: "custom",
        arguments: "please !`rm -rf /tmp/x`",
        confirmShell: true,
      }),
    );
    expect(accepted.status).toBe(202);
    expect(sendCalls(upstream.calls)).toHaveLength(1);
  });

  it("requires confirmation for a non-string template and never forwards confirmShell", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "mcp", template: {} }] }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const blocked = await handleCommands(f.deps, sendRequest(f.token, { name: "mcp" }));
    expect(blocked.status).toBe(400);
    expect(parsed(blocked).code).toBe("shell_confirmation_required");

    const accepted = await handleCommands(
      f.deps,
      sendRequest(f.token, { name: "mcp", arguments: "arg", confirmShell: true }),
    );
    expect(accepted.status).toBe(202);

    const sent = JSON.parse(sendCalls(upstream.calls)[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent.command).toBe("mcp");
    expect(sent.arguments).toBe("arg");
    expect(Object.keys(sent).sort()).toEqual(["arguments", "command", "messageID"]);
  });
});

describe("POST commands: dispatch and early window", () => {
  it("returns the exact 202 body, forwards messageID, and hides upstream bodies", async () => {
    const f = fixture();
    const upstreamSentinel = "UPSTREAM_BODY_SENTINEL";
    const templateSentinel = "TEMPLATE_SENTINEL";
    const argumentSentinel = "ARGUMENT_SENTINEL";
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", description: "text", template: templateSentinel }] }),
      send: () => ({
        body: { info: { id: "upstream" }, parts: [{ type: "text", text: upstreamSentinel }] },
      }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(
      f.deps,
      sendRequest(f.token, { name: "init", arguments: argumentSentinel }),
    );

    expect(response.status).toBe(202);
    const body = parsed(response);
    expect(body).toEqual({
      accepted: true,
      sessionID: "ses_1",
      name: "init",
      messageID: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    });
    expect(response.body).not.toContain(upstreamSentinel);
    expect(response.body).not.toContain(templateSentinel);
    expect(response.body).not.toContain(argumentSentinel);

    const sent = JSON.parse(sendCalls(upstream.calls)[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent).toEqual({
      command: "init",
      arguments: argumentSentinel,
      messageID: body.messageID,
    });

    const logged = JSON.stringify(f.logs);
    expect(logged).not.toContain(upstreamSentinel);
    expect(logged).not.toContain(templateSentinel);
    expect(logged).not.toContain(argumentSentinel);
    expect(f.logs.some((entry) => entry.message === "commands.send.accepted")).toBe(true);
  });

  it("returns a fixed 502 command_failed for a missing session", async () => {
    const f = fixture();
    const sentinel = "MISSING_SESSION_SENTINEL";
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", template: "text" }] }),
      send: () => ({ status: 404, body: { error: sentinel } }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, sendRequest(f.token, { name: "init" }));

    expect(response.status).toBe(502);
    const body = parsed(response);
    expect(body).toEqual({
      error: "Command outcome unknown.",
      code: "command_failed",
      outcome: "unknown",
      messageID: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
      sessionID: "ses_1",
      name: "init",
    });
    expect(response.body).not.toContain(sentinel);
    const sent = JSON.parse(sendCalls(upstream.calls)[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent.messageID).toBe(body.messageID);
    expect(
      f.logs.some(
        (entry) => entry.message === "commands.send.early_failed" && entry.fields.status === 404,
      ),
    ).toBe(true);
    expect(JSON.stringify(f.logs)).not.toContain(sentinel);
  });

  it("returns 202 and logs a failure that arrives after the early window", async () => {
    const f = fixture();
    const sentinel = "LATE_FAILURE_SENTINEL";
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", template: "text" }] }),
      send: () => ({ status: 500, body: { error: sentinel }, delayMs: 1_200 }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));

    const response = await handleCommands(f.deps, sendRequest(f.token, { name: "init" }));

    expect(response.status).toBe(202);
    expect(parsed(response)).toMatchObject({ accepted: true, sessionID: "ses_1", name: "init" });
    expect(response.body).not.toContain(sentinel);

    await waitFor(() =>
      f.logs.some(
        (entry) => entry.message === "commands.send.failed" && entry.fields.status === 500,
      ),
    );
    expect(JSON.stringify(f.logs)).not.toContain(sentinel);
  });

  it("aborts a hung client command with status 0 at the client level", async () => {
    const upstream = await fakeUpstream({ send: () => ({ hang: true }) });

    const error = await runSessionCommand(upstream.endpoint, "ses_1", "init", "", "msg_test", {
      timeoutMs: 50,
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect((error as OpencodeHttpError).status).toBe(0);
  });
});

describe("server dispatch", () => {
  it("routes both command paths before the chat route and enforces the body cap", async () => {
    const f = fixture();
    const upstream = await fakeUpstream({
      list: () => ({ body: [{ name: "init", template: "text" }] }),
    });
    useManager(f, managerStub({ endpoint: upstream.endpoint }));
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const list = await fetch(`${base}${LIST}?project=p1`, { headers: auth(f.token) });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { commands: unknown[] }).commands).toBeInstanceOf(Array);

    const send = await fetch(`${base}${SEND}?project=p1`, {
      method: "POST",
      headers: auth(f.token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "init" }),
    });
    expect(send.status).toBe(202);

    const wrongMethod = await fetch(`${base}${LIST}?project=p1`, {
      method: "DELETE",
      headers: auth(f.token),
    });
    expect(wrongMethod.status).toBe(405);

    const oversized = await fetch(`${base}${SEND}?project=p1`, {
      method: "POST",
      headers: auth(f.token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "init", arguments: "a".repeat(70 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as { code: string }).code).toBe("payload_too_large");
  });
});
