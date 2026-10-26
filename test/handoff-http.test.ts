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

function fixture(): {
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
    getProjects: () => [{ id: "p", name: "P", rootPath: dir, workspaceRoot: dir, service }],
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
