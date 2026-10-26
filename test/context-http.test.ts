import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeploymentInProgressError } from "../src/coordinator/deployment-lock.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleContext, isContextRoute } from "../src/http/context.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { DefaultImageUnavailableError, ImageNotReadyError } from "../src/images/service.js";
import { OpencodeHttpError } from "../src/opencode/client.js";
import {
  AgentNotRunningError,
  CompactInProgressError,
  type ContextSnapshot,
  ModelUnavailableError,
  NotTopLevelError,
  SessionBusyError,
  SessionNotFoundError,
} from "../src/opencode/context.js";
import {
  AgentTokenReconcileError,
  DeletionPendingError,
  type InstanceManager,
  type ManagedApp,
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
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CONTEXT = "/api/apps/storefront/sessions/ses_1/context";
const COMPACT = "/api/apps/storefront/sessions/ses_1/compact";

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

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-context-http-"));
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
  return { db, deps, token };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", path: CONTEXT, headers: {}, query: { project: "p1" }, ...overrides };
}

function snapshot(sessionID = "ses_1"): ContextSnapshot {
  return {
    sessionID,
    state: "ready",
    used: 124_000,
    limit: 200_000,
    percent: 62,
    model: { providerID: "deepseek", modelID: "deepseek-flash" },
    status: "idle",
    topLevel: true,
    activeChildren: false,
    pendingTask: false,
    updatedAt: "2026-10-21T00:00:00.000Z",
    lastCompactedAt: null,
    lastError: null,
    autoCompact: { enabled: true, percent: 80, source: "app", percentSource: "global" },
  };
}

interface Calls {
  ensure: ManagedApp[];
  snapshots: Array<{ appId: string; sessionId: string }>;
  compacts: Array<{ appId: string; sessionId: string }>;
}

function managerStub(
  options: {
    ensure?: (app: ManagedApp) => Promise<string>;
    snapshot?: (appId: string, sessionId: string) => Promise<ContextSnapshot>;
    compact?: (appId: string, sessionId: string) => Promise<{ accepted: true }>;
  } = {},
): { manager: InstanceManager; calls: Calls } {
  const calls: Calls = { ensure: [], snapshots: [], compacts: [] };
  const manager = {
    ensure: async (app: ManagedApp): Promise<string> => {
      calls.ensure.push(app);
      return options.ensure === undefined ? "http://127.0.0.1:1" : options.ensure(app);
    },
    contextSnapshot: async (appId: string, sessionId: string): Promise<ContextSnapshot> => {
      calls.snapshots.push({ appId, sessionId });
      return options.snapshot === undefined
        ? snapshot(sessionId)
        : options.snapshot(appId, sessionId);
    },
    compactSession: async (appId: string, sessionId: string): Promise<{ accepted: true }> => {
      calls.compacts.push({ appId, sessionId });
      return options.compact === undefined ? { accepted: true } : options.compact(appId, sessionId);
    },
  } as unknown as InstanceManager;
  return { manager, calls };
}

describe("isContextRoute", () => {
  it("matches the context and compact paths regardless of method", () => {
    expect(isContextRoute("GET", CONTEXT)).toBe(true);
    expect(isContextRoute("POST", COMPACT)).toBe(true);
    expect(isContextRoute("DELETE", CONTEXT)).toBe(true);
    expect(isContextRoute("GET", COMPACT)).toBe(true);
  });

  it("does not match unrelated application routes", () => {
    expect(isContextRoute("GET", "/api/apps/storefront/sessions/ses_1/messages")).toBe(false);
    expect(isContextRoute("GET", "/api/apps/storefront/sessions")).toBe(false);
    expect(isContextRoute("GET", "/chat")).toBe(false);
    expect(isContextRoute("GET", `${CONTEXT}/extra`)).toBe(false);
  });
});

describe("context routes: authentication and lookup", () => {
  it("returns 401 without a principal", async () => {
    const f = fixture();
    const response = await handleContext(f.deps, request());
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "sign in required" });
  });

  it("returns 403 for an agent principal on both routes", async () => {
    const f = fixture();
    const token = agentToken(f);
    for (const target of [
      request({ headers: auth(token) }),
      request({ method: "POST", path: COMPACT, headers: auth(token) }),
    ]) {
      const stub = managerStub();
      f.deps.manager = stub.manager;
      const response = await handleContext(f.deps, target);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ code: "human_only" });
      expect(JSON.parse(response.body).error).toMatch(/^only a human principal may /);
      expect(stub.calls.ensure).toEqual([]);
      expect(stub.calls.compacts).toEqual([]);
    }
  });

  it("returns 503 when no manager is configured", async () => {
    const f = fixture();
    const read = await handleContext(f.deps, request({ headers: auth(f.token) }));
    expect(read.status).toBe(503);
    expect(JSON.parse(read.body)).toEqual({ error: "agent runtime is not configured" });

    const write = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );
    expect(write.status).toBe(503);
    expect(JSON.parse(write.body)).toEqual({ error: "agent runtime is not configured" });
  });

  it("returns 404 unknown_app for an unknown application or project", async () => {
    const f = fixture();
    const stub = managerStub();
    f.deps.manager = stub.manager;

    for (const target of [
      { project: "p1", path: "/api/apps/missing/sessions/ses_1/context" },
      { project: "missing", path: CONTEXT },
      { project: "p2", path: "/api/apps/api/sessions/ses_1/context" },
    ]) {
      const response = await handleContext(
        f.deps,
        request({
          path: target.path,
          query: { project: target.project },
          headers: auth(f.token),
        }),
      );
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body).code).toBe("unknown_app");
    }
    expect(stub.calls.snapshots).toEqual([]);
  });

  it("scopes app lookup to the project query", async () => {
    const f = fixture();
    const stub = managerStub();
    f.deps.manager = stub.manager;

    const response = await handleContext(
      f.deps,
      request({ query: { project: "p2" }, headers: auth(f.token) }),
    );

    expect(response.status).toBe(200);
    expect(stub.calls.snapshots).toEqual([{ appId: "p2:storefront", sessionId: "ses_1" }]);
  });
});

describe("GET context", () => {
  it("returns the snapshot unchanged without starting the agent", async () => {
    const f = fixture();
    const stub = managerStub();
    f.deps.manager = stub.manager;

    const response = await handleContext(f.deps, request({ headers: auth(f.token) }));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(snapshot());
    const body = JSON.parse(response.body);
    expect(body.topLevel).toBe(true);
    expect(body.activeChildren).toBe(false);
    expect(body.pendingTask).toBe(false);
    expect(stub.calls.ensure).toEqual([]);
    expect(stub.calls.snapshots).toEqual([{ appId: "p1:storefront", sessionId: "ses_1" }]);
    expect(stub.calls.compacts).toEqual([]);
  });

  it("returns 503 agent_not_running when the app is stopped", async () => {
    const f = fixture();
    f.deps.manager = managerStub({
      snapshot: async () => {
        throw new AgentNotRunningError();
      },
    }).manager;

    const response = await handleContext(f.deps, request({ headers: auth(f.token) }));

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "agent is not running",
      code: "agent_not_running",
    });
  });

  it("maps a missing session from the monitor or upstream to 404", async () => {
    const errors: unknown[] = [
      new SessionNotFoundError(),
      new OpencodeHttpError("/session/ses_1/message", 404, "not found"),
    ];
    for (const error of errors) {
      const f = fixture();
      f.deps.manager = managerStub({
        snapshot: async () => {
          throw error;
        },
      }).manager;

      const response = await handleContext(f.deps, request({ headers: auth(f.token) }));
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: "session not found",
        code: "session_not_found",
      });
    }
  });

  it("returns a fixed 502 without leaking upstream bodies", async () => {
    const f = fixture();
    const secret = "SENTINEL_CONTEXT_PROVIDER_PAYLOAD";
    f.deps.manager = managerStub({
      snapshot: async () => {
        throw new OpencodeHttpError("/session/ses_1/message", 500, `provider said ${secret}`);
      },
    }).manager;

    const response = await handleContext(f.deps, request({ headers: auth(f.token) }));

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: "context is unavailable",
      code: "context_unavailable",
    });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("provider said");
  });

  it("maps transport failures to the same fixed 502", async () => {
    const f = fixture();
    const secret = "SENTINEL_CONTEXT_TRANSPORT";
    f.deps.manager = managerStub({
      snapshot: async () => {
        throw new Error(secret);
      },
    }).manager;

    const response = await handleContext(f.deps, request({ headers: auth(f.token) }));

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: "context is unavailable",
      code: "context_unavailable",
    });
    expect(response.body).not.toContain(secret);
  });
});

describe("POST compact", () => {
  it("ensures the app once and returns 202 without a request body", async () => {
    const f = fixture();
    const stub = managerStub();
    f.deps.manager = stub.manager;

    const response = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );

    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: true, sessionID: "ses_1" });
    expect(stub.calls.ensure).toHaveLength(1);
    expect(stub.calls.ensure[0]).toMatchObject({
      id: "p1:storefront",
      projectId: "p1",
      appKey: "storefront",
      appDir: "/tmp/p1/apps/storefront",
    });
    expect(stub.calls.compacts).toEqual([{ appId: "p1:storefront", sessionId: "ses_1" }]);
  });

  it("maps deletion-pending starts to 409 without compacting", async () => {
    const f = fixture();
    const stub = managerStub({
      ensure: async () => {
        throw new DeletionPendingError("p1:storefront");
      },
    });
    f.deps.manager = stub.manager;

    const response = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "application is pending deletion",
      code: "deletion_pending",
    });
    expect(stub.calls.compacts).toEqual([]);
  });

  it("maps a deployment lock to the shared 409 body", async () => {
    const f = fixture();
    const stub = managerStub({
      ensure: async () => {
        throw new DeploymentInProgressError("ensure", { phase: "switching" });
      },
    });
    f.deps.manager = stub.manager;

    const response = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );

    expect(response.status).toBe(409);
    expect(response.headers?.["retry-after"]).toBe("30");
    expect(JSON.parse(response.body)).toEqual({
      error: "deployment_in_progress",
      message: "deployment in progress: switching",
      retryAfter: 30,
    });
    expect(stub.calls.compacts).toEqual([]);
  });

  it("maps an agent-token reconciliation failure to the shared 500 body", async () => {
    const f = fixture();
    const stub = managerStub({
      ensure: async () => {
        throw new AgentTokenReconcileError("p1:storefront");
      },
    });
    f.deps.manager = stub.manager;

    const response = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "agent_token_reconcile_failed" });
    expect(stub.calls.compacts).toEqual([]);
  });

  it("maps other start failures to a fixed 502", async () => {
    const f = fixture();
    const secret = "SENTINEL_START_FAILURE";
    f.deps.manager = managerStub({
      ensure: async () => {
        throw new Error(secret);
      },
    }).manager;

    const response = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: "agent unavailable",
      code: "agent_unavailable",
    });
    expect(response.body).not.toContain(secret);
  });

  const conflicts: Array<{ name: string; error: Error; code: string; message: string }> = [
    {
      name: "session busy",
      error: new SessionBusyError(),
      code: "session_busy",
      message: "session is busy",
    },
    {
      name: "compaction in progress",
      error: new CompactInProgressError(),
      code: "compact_in_progress",
      message: "a compaction is already in progress",
    },
    {
      name: "model unavailable",
      error: new ModelUnavailableError(),
      code: "model_unavailable",
      message: "no model is available for compaction",
    },
    {
      name: "not top level",
      error: new NotTopLevelError(),
      code: "not_top_level",
      message: "compaction is only available for top-level sessions",
    },
  ];
  for (const conflict of conflicts) {
    it(`maps ${conflict.name} to 409`, async () => {
      const f = fixture();
      f.deps.manager = managerStub({
        compact: async () => {
          throw conflict.error;
        },
      }).manager;

      const response = await handleContext(
        f.deps,
        request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
      );

      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toEqual({
        error: conflict.message,
        code: conflict.code,
      });
    });
  }

  it("maps a missing session from the monitor or upstream to 404", async () => {
    const errors: unknown[] = [
      new SessionNotFoundError(),
      new OpencodeHttpError("/session/ses_1/summarize", 404, "not found"),
    ];
    for (const error of errors) {
      const f = fixture();
      f.deps.manager = managerStub({
        compact: async () => {
          throw error;
        },
      }).manager;

      const response = await handleContext(
        f.deps,
        request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
      );

      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: "session not found",
        code: "session_not_found",
      });
    }
  });

  it("maps a stopped agent during compaction to 503", async () => {
    const f = fixture();
    f.deps.manager = managerStub({
      compact: async () => {
        throw new AgentNotRunningError();
      },
    }).manager;

    const response = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "agent is not running",
      code: "agent_not_running",
    });
  });

  it("returns a fixed 502 without leaking upstream bodies", async () => {
    const f = fixture();
    const secret = "SENTINEL_COMPACT_PROVIDER_PAYLOAD";
    f.deps.manager = managerStub({
      compact: async () => {
        throw new OpencodeHttpError("/session/ses_1/summarize", 500, secret);
      },
    }).manager;

    const response = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: "compaction is unavailable",
      code: "compaction_unavailable",
    });
    expect(response.body).not.toContain(secret);
  });

  it("maps transport failures to the same fixed 502", async () => {
    const f = fixture();
    const secret = "SENTINEL_COMPACT_TRANSPORT";
    f.deps.manager = managerStub({
      compact: async () => {
        throw new Error(secret);
      },
    }).manager;

    const response = await handleContext(
      f.deps,
      request({ method: "POST", path: COMPACT, headers: auth(f.token) }),
    );

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: "compaction is unavailable",
      code: "compaction_unavailable",
    });
    expect(response.body).not.toContain(secret);
  });
});

describe("method handling", () => {
  it("returns 405 for a wrong method on either matched route", async () => {
    const f = fixture();
    const stub = managerStub();
    f.deps.manager = stub.manager;

    for (const target of [
      request({ method: "DELETE", headers: auth(f.token) }),
      request({ method: "GET", path: COMPACT, headers: auth(f.token) }),
    ]) {
      const response = await handleContext(f.deps, target);
      expect(response.status).toBe(405);
      expect(JSON.parse(response.body)).toEqual({ error: "method not allowed" });
    }
    expect(stub.calls.ensure).toEqual([]);
    expect(stub.calls.compacts).toEqual([]);
  });
});

describe("server dispatch", () => {
  it("routes context and compact before the generic chat route", async () => {
    const f = fixture();
    const stub = managerStub();
    f.deps.manager = stub.manager;
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const read = await fetch(`${base}${CONTEXT}?project=p1`, {
      headers: auth(f.token),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(snapshot());

    const write = await fetch(`${base}${COMPACT}?project=p1`, {
      method: "POST",
      headers: auth(f.token),
    });
    expect(write.status).toBe(202);
    expect(await write.json()).toEqual({ accepted: true, sessionID: "ses_1" });
    expect(stub.calls.ensure).toHaveLength(1);
    expect(stub.calls.compacts).toHaveLength(1);
  });
});

function agentToken(f: Fixture): string {
  return createPrincipal(f.db, { kind: "agent", name: "bot" }).token;
}

describe("context typed image failures", () => {
  it("maps image_not_ready to 409 for compaction", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new ImageNotReadyError(
          imageStateView({ appId: "p1:storefront", state: "not_ready" }),
        );
      },
    } as unknown as InstanceManager;

    const response = await handleContext(f.deps, {
      method: "POST",
      path: COMPACT,
      headers: auth(f.token),
      query: { project: "p1" },
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

  it("maps default_image_unavailable to 503 for compaction", async () => {
    const f = fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new DefaultImageUnavailableError(
          imageStateView({ appId: "p1:storefront", buildConfigured: false, state: "unknown" }),
        );
      },
    } as unknown as InstanceManager;

    const response = await handleContext(f.deps, {
      method: "POST",
      path: COMPACT,
      headers: auth(f.token),
      query: { project: "p1" },
    });

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "default_image_unavailable",
      code: "default_image_unavailable",
      appId: "p1:storefront",
      state: "unknown",
    });
  });
});
