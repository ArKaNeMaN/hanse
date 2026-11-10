import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffDispatcher } from "../src/coordinator/dispatcher.js";
import { getHandoff, transitionHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import { listHandoffPolicies } from "../src/coordinator/policy.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { handleHandoffHttp } from "../src/http/handoff.js";
import { createPrincipal } from "../src/identity/principals.js";
import { ImageNotReadyError } from "../src/images/service.js";
import { MASTER_PROJECT_ID } from "../src/master/constants.js";
import type { OpencodeSession } from "../src/opencode/client.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { imageStateView } from "./fixtures/image-state.js";

const dirs: string[] = [];
const active: Array<{ dispatcher: HandoffDispatcher; db: SqliteDatabase }> = [];

afterEach(() => {
  for (const entry of active.splice(0)) {
    entry.dispatcher.stop();
    entry.db.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ExtraProject {
  id: string;
  deleting?: boolean;
  appKeys?: readonly string[];
}

function fixture(extraProjects: readonly ExtraProject[] = []): {
  db: SqliteDatabase;
  service: CoordinatorService;
  dispatcher: HandoffDispatcher;
  deps: HttpDeps;
  token: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-hh-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  for (const key of ["a", "b"]) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
    ).run(`p:${key}`, key, `apps/${key}`, now);
  }
  for (const extra of extraProjects) {
    db.prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at,deleting) VALUES (?,?, 'main', ?,?,?,?)",
    ).run(extra.id, extra.id, dir, now, now, extra.deleting === true ? 1 : 0);
    for (const key of extra.appKeys ?? ["x"]) {
      db.prepare(
        "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, ?, ?, ?, 'AGENTS.md', ?)",
      ).run(`${extra.id}:${key}`, extra.id, key, `apps/${key}`, now);
    }
  }
  const service = new CoordinatorService(db, "p");
  const sessions = new Map<string, OpencodeSession[]>([["http://a.test", []]]);
  const client = {
    createSession: vi.fn(async (endpoint: string, title?: string) => {
      const session = { id: `ses_${sessions.get(endpoint)?.length ?? 0}`, title };
      sessions.set(endpoint, [...(sessions.get(endpoint) ?? []), session]);
      return session;
    }),
    listSessions: vi.fn(async (endpoint: string) => sessions.get(endpoint) ?? []),
    sendPromptAsync: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => []),
  };
  const dispatcher = new HandoffDispatcher({
    db,
    manager: {
      ensure: vi.fn(async (app) => `http://${app.appKey}.test`),
      endpointFor: vi.fn((appId: string) => `http://${appId.split(":").pop()}.test`),
    },
    workspaceRoot: dir,
    client,
  });
  active.push({ dispatcher, db });
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const deps = {
    db,
    workspaceRoot: dir,
    getProjects: () => [
      { id: "p", name: "P", rootPath: dir, workspaceRoot: dir, service },
      ...extraProjects.map((extra) => ({
        id: extra.id,
        name: extra.id,
        rootPath: dir,
        workspaceRoot: dir,
        deleting: extra.deleting === true,
        service: new CoordinatorService(db, extra.id),
      })),
    ],
    git: {} as HttpDeps["git"],
    dispatcher,
  } as HttpDeps;
  return { db, service, dispatcher, deps, token };
}

function request(
  method: string,
  requestPath: string,
  token: string,
  body?: string,
): {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
} {
  return {
    method,
    path: requestPath,
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
  };
}

function deliverable(db: SqliteDatabase, service: CoordinatorService): string {
  const { handoffId } = service.requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary: "s",
    spec: "x",
  });
  transitionHandoff(db, handoffId, "dispatching");
  transitionHandoff(db, handoffId, "in_progress");
  transitionHandoff(db, handoffId, "delivered", { result: "done", outcome: "completed" });
  updateHandoff(db, handoffId, { replyState: "waiting_operator" });
  return handoffId;
}

describe("handoff HTTP actions", () => {
  it("stores and lists project handoff policy rules", async () => {
    const f = fixture();
    const saved = await handleHandoffHttp(
      f.deps,
      request(
        "POST",
        "/api/projects/p/handoff-policy",
        f.token,
        "from=a&to=b&dispatch_mode=approve&reply_mode=approve",
      ),
    );
    expect(saved?.status).toBe(200);
    const listed = await handleHandoffHttp(
      f.deps,
      request("GET", "/api/projects/p/handoff-policy", f.token),
    );
    expect(listed?.status).toBe(200);
    expect(JSON.parse(listed?.body ?? "{}").policies).toHaveLength(1);
    expect(listHandoffPolicies(f.db, "p")[0]?.dispatchMode).toBe("approve");
  });

  it("relaunches a waiting reply with a note", async () => {
    const f = fixture();
    const handoffId = deliverable(f.db, f.service);
    const response = await handleHandoffHttp(
      f.deps,
      request("POST", `/api/handoffs/${handoffId}/reply/relaunch`, f.token, "note=please+continue"),
    );
    expect(response?.status).toBe(200);
    const body = JSON.parse(response?.body ?? "{}") as { sessionId?: string };
    expect(body.sessionId).toBeTruthy();
    const handoff = getHandoff(f.db, handoffId);
    expect(handoff?.replyState).toBe("delivered");
    expect(handoff?.operatorNote).toBe("please continue");
    expect(handoff?.deliveredVia).toBe("operator_relaunch");
  });

  it("cancels an open handoff", async () => {
    const f = fixture();
    const { handoffId } = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "s",
      spec: "x",
    });
    const response = await handleHandoffHttp(
      f.deps,
      request("POST", `/api/handoffs/${handoffId}/cancel`, f.token),
    );
    expect(response?.status).toBe(200);
    expect(getHandoff(f.db, handoffId)?.state).toBe("cancelled");
  });

  it("cancels a thread atomically through the human-only cancel route", async () => {
    const f = fixture();
    const result = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "thread",
      spec: "thread spec",
      mode: "thread",
      idempotencyKey: "http-thread-cancel",
    });
    const response = await handleHandoffHttp(
      f.deps,
      request("POST", `/api/handoffs/${result.handoffId}/cancel`, f.token),
    );
    expect(response?.status).toBe(200);
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("cancelled");
    const message = f.db
      .prepare("SELECT state, error_code AS errorCode FROM handoff_messages WHERE handoff_id = ?")
      .get(result.handoffId) as { state: string; errorCode: string | null };
    expect(message).toEqual({ state: "cancelled", errorCode: "operator_cancel" });
  });

  it("rejects an agent principal", async () => {
    const f = fixture();
    const agentToken = createPrincipal(f.db, { kind: "agent", name: "a" }).token;
    const response = await handleHandoffHttp(
      f.deps,
      request(
        "POST",
        "/api/projects/p/handoff-policy",
        agentToken,
        "from=a&to=b&dispatch_mode=auto&reply_mode=auto",
      ),
    );
    expect(response?.status).toBe(403);
  });
});

describe("handoff reply typed image failures", () => {
  it("maps a relaunch image failure to a bounded operator error", async () => {
    const f = fixture();
    const handoffId = deliverable(f.db, f.service);
    f.dispatcher.relaunchReply = async () => {
      throw new ImageNotReadyError(imageStateView({ appId: "p:a", state: "not_ready" }));
    };

    const response = await handleHandoffHttp(
      f.deps,
      request("POST", `/api/handoffs/${handoffId}/reply/relaunch`, f.token, "note=retry"),
    );

    expect(response?.status).toBe(409);
    expect(JSON.parse(response?.body ?? "")).toEqual({
      error: "image_not_ready",
      code: "image_not_ready",
      message: "application image is not ready (not_ready)",
      appId: "p:a",
      state: "not_ready",
      imageStatus: "missing",
      buildConfigured: true,
    });
  });
});

describe("handoff grant HTTP actions", () => {
  it("lists, creates, replaces, and deletes grants as a human", async () => {
    const f = fixture([{ id: "p2" }]);
    const created = await handleHandoffHttp(
      f.deps,
      request(
        "POST",
        "/api/projects/p/handoff-grants",
        f.token,
        "from=a&target_project=p2&to=x&dispatch_mode=auto&reply_mode=auto",
      ),
    );
    expect(created?.status).toBe(200);
    const grant = (
      JSON.parse(created?.body ?? "{}") as {
        grant: {
          id: number;
          projectId: string;
          fromAppKey: string;
          targetProjectId: string;
          toAppKey: string;
          dispatchMode: string;
          replyMode: string;
          createdBy: string | null;
        };
      }
    ).grant;
    expect(grant).toMatchObject({
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "p2",
      toAppKey: "x",
      dispatchMode: "auto",
      replyMode: "auto",
    });
    expect(grant.createdBy).toBeTruthy();

    const listed = await handleHandoffHttp(
      f.deps,
      request("GET", "/api/projects/p/handoff-grants", f.token),
    );
    expect(listed?.status).toBe(200);
    expect((JSON.parse(listed?.body ?? "{}") as { grants: unknown[] }).grants).toHaveLength(1);

    const replaced = await handleHandoffHttp(
      f.deps,
      request(
        "POST",
        "/api/projects/p/handoff-grants",
        f.token,
        "from=a&target_project=p2&to=x&dispatch_mode=approve&reply_mode=approve",
      ),
    );
    expect(replaced?.status).toBe(200);
    expect(
      (JSON.parse(replaced?.body ?? "{}") as { grant: { id: number; dispatchMode: string } }).grant,
    ).toMatchObject({ id: grant.id, dispatchMode: "approve" });

    const deleted = await handleHandoffHttp(
      f.deps,
      request(
        "POST",
        "/api/projects/p/handoff-grants/delete",
        f.token,
        "from=a&target_project=p2&to=x",
      ),
    );
    expect(deleted?.status).toBe(200);
    expect(JSON.parse(deleted?.body ?? "{}")).toEqual({ ok: true });
    const after = await handleHandoffHttp(
      f.deps,
      request("GET", "/api/projects/p/handoff-grants", f.token),
    );
    expect((JSON.parse(after?.body ?? "{}") as { grants: unknown[] }).grants).toEqual([]);
  });

  it("rejects grant CRUD for anonymous and agent principals", async () => {
    const f = fixture([{ id: "p2" }]);
    const anonymous = await handleHandoffHttp(f.deps, {
      method: "POST",
      path: "/api/projects/p/handoff-grants",
      headers: { accept: "application/json" },
      body: "target_project=p2",
    });
    expect(anonymous?.status).toBe(401);
    const anonymousList = await handleHandoffHttp(f.deps, {
      method: "GET",
      path: "/api/projects/p/handoff-grants",
      headers: { accept: "application/json" },
    });
    expect(anonymousList?.status).toBe(401);

    const agentToken = createPrincipal(f.db, { kind: "agent", name: "agent" }).token;
    const agent = await handleHandoffHttp(
      f.deps,
      request("POST", "/api/projects/p/handoff-grants", agentToken, "target_project=p2"),
    );
    expect(agent?.status).toBe(403);
    const agentDelete = await handleHandoffHttp(
      f.deps,
      request("POST", "/api/projects/p/handoff-grants/delete", agentToken, "target_project=p2"),
    );
    expect(agentDelete?.status).toBe(403);
  });

  it("returns the grant-CRUD validation codes and HTML notices", async () => {
    const f = fixture([{ id: "p2" }]);
    const missing = await handleHandoffHttp(
      f.deps,
      request("GET", "/api/projects/nope/handoff-grants", f.token),
    );
    expect(missing?.status).toBe(404);

    const cases: ReadonlyArray<[string, string]> = [
      ["target_project=nope", "unknown_target_project"],
      ["target_project=p", "same_project_grant"],
      ["target_project=p2&from=zzz", "unknown_source_app"],
      ["target_project=p2&to=zzz", "unknown_target_app"],
      ["target_project=p2&from=bad key", "invalid_app_key"],
      ["target_project=p2&dispatch_mode=deny", "invalid_mode"],
      ["from=a", "invalid_grant"],
    ];
    for (const [body, code] of cases) {
      const response = await handleHandoffHttp(
        f.deps,
        request("POST", "/api/projects/p/handoff-grants", f.token, body),
      );
      expect(response?.status).toBe(400);
      expect((JSON.parse(response?.body ?? "{}") as { code: string }).code).toBe(code);
    }

    const html = await handleHandoffHttp(f.deps, {
      method: "POST",
      path: "/api/projects/p/handoff-grants",
      headers: { accept: "text/html", authorization: `Bearer ${f.token}` },
      body: "target_project=nope",
    });
    expect(html?.status).toBe(303);
    expect(html?.headers?.location).toContain("notice=");
    expect(html?.headers?.location).toContain("tone=error");
  });

  it("refuses a master source project, a deleting source project, and a master/deleting target", async () => {
    const f = fixture([
      { id: "p2" },
      { id: MASTER_PROJECT_ID, appKeys: ["master"] },
      { id: "pdel", deleting: true },
    ]);

    const masterSource = await handleHandoffHttp(
      f.deps,
      request(
        "POST",
        `/api/projects/${MASTER_PROJECT_ID}/handoff-grants`,
        f.token,
        "target_project=p2",
      ),
    );
    expect(masterSource?.status).toBe(400);
    expect((JSON.parse(masterSource?.body ?? "{}") as { code: string }).code).toBe(
      "builtin_target_forbidden",
    );

    const deletingSource = await handleHandoffHttp(
      f.deps,
      request("GET", "/api/projects/pdel/handoff-grants", f.token),
    );
    expect(deletingSource?.status).toBe(409);

    const masterTarget = await handleHandoffHttp(
      f.deps,
      request(
        "POST",
        "/api/projects/p/handoff-grants",
        f.token,
        `target_project=${MASTER_PROJECT_ID}`,
      ),
    );
    expect(masterTarget?.status).toBe(400);
    expect((JSON.parse(masterTarget?.body ?? "{}") as { code: string }).code).toBe(
      "builtin_target_forbidden",
    );

    const deletingTarget = await handleHandoffHttp(
      f.deps,
      request("POST", "/api/projects/p/handoff-grants", f.token, "target_project=pdel"),
    );
    expect(deletingTarget?.status).toBe(400);
    expect((JSON.parse(deletingTarget?.body ?? "{}") as { code: string }).code).toBe(
      "deleting_target_forbidden",
    );
  });

  it("returns 404 { ok: false } when deleting a missing grant (m7)", async () => {
    const f = fixture([{ id: "p2" }]);
    const response = await handleHandoffHttp(
      f.deps,
      request(
        "POST",
        "/api/projects/p/handoff-grants/delete",
        f.token,
        "from=a&target_project=p2&to=x",
      ),
    );
    expect(response?.status).toBe(404);
    expect(JSON.parse(response?.body ?? "{}")).toEqual({ ok: false });

    const html = await handleHandoffHttp(f.deps, {
      method: "POST",
      path: "/api/projects/p/handoff-grants/delete",
      headers: { accept: "text/html", authorization: `Bearer ${f.token}` },
      body: "from=a&target_project=p2&to=x",
    });
    expect(html?.status).toBe(303);
    expect(html?.headers?.location).toContain("notice=Handoff%20grant%20not%20found.");
    expect(html?.headers?.location).toContain("tone=error");
  });
});
