import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideApproval, getPendingApproval } from "../src/coordinator/approval.js";
import { HandoffDispatcher } from "../src/coordinator/dispatcher.js";
import { getHandoff } from "../src/coordinator/handoff.js";
import { setHandoffPolicy } from "../src/coordinator/policy.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { OpencodeSession } from "../src/opencode/client.js";
import type { HanseEvent } from "../src/opencode/events.js";
import type { ManagedApp } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

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

const appA = { id: "p:a", projectId: "p", appKey: "a" };

interface Prompt {
  endpoint: string;
  sessionId: string;
  text: string;
  messageID: string;
  model?: string;
}

interface Fixture {
  db: SqliteDatabase;
  dir: string;
  service: CoordinatorService;
  dispatcher: HandoffDispatcher;
  sessions: Map<string, OpencodeSession[]>;
  prompts: Prompt[];
  ensured: string[];
  manager: {
    ensure: ReturnType<typeof vi.fn>;
    endpointFor: ReturnType<typeof vi.fn>;
  };
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-hd-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  for (const key of ["a", "b", "c"]) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
    ).run(`p:${key}`, key, `apps/${key}`, now);
  }
  const service = new CoordinatorService(db, "p");
  const sessions = new Map<string, OpencodeSession[]>([
    ["http://a.test", [{ id: "ses_source", title: "Source" }]],
    ["http://b.test", []],
    ["http://c.test", []],
  ]);
  const prompts: Prompt[] = [];
  const ensured: string[] = [];
  let sessionCounter = 0;
  const client = {
    createSession: vi.fn(async (endpoint: string, title?: string) => {
      const session: OpencodeSession = { id: `ses_${++sessionCounter}`, title };
      sessions.set(endpoint, [...(sessions.get(endpoint) ?? []), session]);
      return session;
    }),
    listSessions: vi.fn(async (endpoint: string) => sessions.get(endpoint) ?? []),
    sendPromptAsync: vi.fn(
      async (
        endpoint: string,
        sessionId: string,
        text: string,
        messageID: string,
        _options?: { timeoutMs?: number; maxBytes?: number },
        model?: string,
      ) => {
        prompts.push({ endpoint, sessionId, text, messageID, model });
      },
    ),
    listMessages: vi.fn(async () => []),
  };
  const manager = {
    ensure: vi.fn(async (app: ManagedApp) => {
      ensured.push(app.appKey);
      return `http://${app.appKey}.test`;
    }),
    endpointFor: vi.fn((appId: string) => `http://${appId.split(":").pop()}.test`),
  };
  const dispatcher = new HandoffDispatcher({
    db,
    manager,
    workspaceRoot: dir,
    settings: {
      resolve: () => ({ effective: { llm: { model: { value: "deepseek/deepseek-flash" } } } }),
    },
    client,
  });
  active.push({ dispatcher, db });
  return { db, dir, service, dispatcher, sessions, prompts, ensured, manager };
}

function eventFor(handoffId: string, sessionId = "ses_source"): HanseEvent {
  return {
    type: "message.part.updated",
    sessionID: sessionId,
    messageID: "msg_tool",
    partID: `part_${handoffId}`,
    partType: "tool",
    part: {
      tool: "hanse_request_sibling_change",
      state: { status: "completed", output: JSON.stringify({ handoffId }) },
    },
  } as HanseEvent;
}

async function createBound(
  f: Fixture,
  options: { origin?: "agent" | "operator"; sessionId?: string } = {},
): Promise<string> {
  const { handoffId } = f.service.requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary: "need X",
    spec: "do X",
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
  if (options.origin !== "operator") {
    f.dispatcher.observe(appA, eventFor(handoffId, options.sessionId));
  }
  await f.dispatcher.tickNow();
  return handoffId;
}

describe("handoff dispatcher", () => {
  it("binds the invoking session and dispatches a fresh target session", async () => {
    const f = fixture();
    const { handoffId } = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "need X",
      spec: "do X",
    });
    expect(getHandoff(f.db, handoffId)?.sourceSessionId).toBeNull();

    f.dispatcher.observe(appA, eventFor(handoffId));
    expect(getHandoff(f.db, handoffId)?.sourceSessionId).toBe("ses_source");
    await f.dispatcher.tickNow();

    const handoff = getHandoff(f.db, handoffId);
    expect(handoff?.state).toBe("in_progress");
    expect(handoff?.targetSessionId).toBe("ses_1");
    expect(handoff?.policyDispatchMode).toBe("auto");
    expect(handoff?.depth).toBe(0);
    expect(f.ensured).toEqual(["b"]);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]?.endpoint).toBe("http://b.test");
    expect(f.prompts[0]?.text).toContain(handoffId);
    expect(f.prompts[0]?.text).toContain("do X");
    expect(f.prompts[0]?.model).toBe("deepseek/deepseek-flash");
  });

  it("routes the target reply back into the source session", async () => {
    const f = fixture();
    const id = await createBound(f);
    const delivered = f.service.deliverHandoff(id, "implemented X", "completed", "b");
    expect(delivered.replyState).toBe("pending");

    await f.dispatcher.tickNow();
    const handoff = getHandoff(f.db, id);
    expect(handoff?.replyState).toBe("delivered");
    expect(handoff?.replyDeliveredSessionId).toBe("ses_source");
    expect(handoff?.replyDeliveredAt).not.toBeNull();
    expect(handoff?.deliveredVia).toBe("auto");
    const reply = f.prompts.at(-1);
    expect(reply?.endpoint).toBe("http://a.test");
    expect(reply?.sessionId).toBe("ses_source");
    expect(reply?.text).toContain("implemented X");
    expect(reply?.text).toContain("untrusted");
  });

  it("parks a reply when the source session was deleted and relaunches it with a note", async () => {
    const f = fixture();
    const id = await createBound(f);
    f.sessions.set("http://a.test", []);
    f.service.deliverHandoff(id, "done", "completed", "b");
    await f.dispatcher.tickNow();

    let handoff = getHandoff(f.db, id);
    expect(handoff?.replyState).toBe("waiting_operator");
    expect(handoff?.sourceSessionDeletedAt).not.toBeNull();
    expect(handoff?.replyError).toContain("no longer exists");

    const before = f.prompts.length;
    const result = await f.dispatcher.relaunchReply(id, "use the new schema");
    handoff = getHandoff(f.db, id);
    expect(handoff?.replyState).toBe("delivered");
    expect(handoff?.deliveredVia).toBe("operator_relaunch");
    expect(handoff?.operatorNote).toBe("use the new schema");
    expect(handoff?.replyDeliveredSessionId).toBe(result.sessionId);
    expect(f.prompts.length).toBe(before + 1);
    const relaunch = f.prompts.at(-1);
    expect(relaunch?.sessionId).toBe(result.sessionId);
    expect(relaunch?.text).toContain("use the new schema");
    expect(relaunch?.text).toContain("original source session");
  });

  it("holds a reply for approval when the reply policy requires it", async () => {
    const f = fixture();
    setHandoffPolicy(f.db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "auto",
      replyMode: "approve",
    });
    const id = await createBound(f);
    f.service.deliverHandoff(id, "done", "completed", "b");
    expect(getHandoff(f.db, id)?.replyState).toBe("awaiting_approval");
    const approval = getPendingApproval(f.db, id, "reply");
    expect(approval).toBeDefined();

    const human = createPrincipal(f.db, { kind: "human", name: "alice" }).principal;
    decideApproval(f.db, approval?.id ?? "", human, "approved");
    expect(getHandoff(f.db, id)?.replyState).toBe("pending");
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, id)?.replyState).toBe("delivered");
  });

  it("denies a pair by policy even when the agent does not ask for approval", async () => {
    const f = fixture();
    setHandoffPolicy(f.db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "deny",
      replyMode: "auto",
    });
    const result = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "need X",
      spec: "do X",
      requiresApproval: false,
    });
    expect(result.status).toBe("denied");
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("rejected");
    f.dispatcher.observe(appA, eventFor(result.handoffId));
    await f.dispatcher.tickNow();
    expect(f.prompts).toHaveLength(0);
  });

  it("scopes delivery and status to the addressed applications", async () => {
    const f = fixture();
    const id = await createBound(f);
    expect(f.service.handoffStatus(id, "c")).toBeUndefined();
    expect(f.service.handoffStatus(id, "a")?.id).toBe(id);
    expect(() => f.service.deliverHandoff(id, "x", "completed", "a")).toThrow(/not addressed/);
    expect(f.service.deliverHandoff(id, "x", "completed", "b").state).toBe("delivered");
  });

  it("keeps one active handoff per target application", async () => {
    const f = fixture();
    const first = await createBound(f);
    const secondResult = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "second",
      spec: "do Y",
    });
    f.dispatcher.observe(appA, eventFor(secondResult.handoffId));
    await f.dispatcher.tickNow();

    expect(getHandoff(f.db, first)?.state).toBe("in_progress");
    expect(getHandoff(f.db, secondResult.handoffId)?.state).toBe("queued");

    f.service.deliverHandoff(first, "done", "completed", "b");
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, secondResult.handoffId)?.state).toBe("in_progress");
  });

  it("rejects a handoff above the chain depth limit", async () => {
    const f = fixture();
    const id = await createBound(f);
    f.db.prepare("UPDATE handoffs SET depth = 8 WHERE id = ?").run(id);
    const second = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "deep",
      spec: "do Z",
    });
    f.dispatcher.observe(appA, eventFor(second.handoffId));
    f.db.prepare("UPDATE handoffs SET depth = 8 WHERE id = ?").run(second.handoffId);
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, second.handoffId)?.state).toBe("rejected");
    expect(f.prompts).toHaveLength(1);
  });

  it("fails an agent handoff whose source session never binds", async () => {
    const f = fixture();
    const { handoffId } = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "unbound",
      spec: "do Q",
    });
    f.db
      .prepare("UPDATE handoffs SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), handoffId);
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, handoffId)?.state).toBe("failed");
    expect(getHandoff(f.db, handoffId)?.error).toContain("not bound");
    expect(f.prompts).toHaveLength(0);
  });

  it("dispatches an operator-created handoff and parks its reply for a relaunch", async () => {
    const f = fixture();
    const id = await createBound(f, { origin: "operator" });
    expect(getHandoff(f.db, id)?.sourceSessionId).toBeNull();
    expect(getHandoff(f.db, id)?.state).toBe("in_progress");

    f.service.deliverHandoff(id, "done", "completed", "b");
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, id)?.replyState).toBe("waiting_operator");

    const result = await f.dispatcher.relaunchReply(id, "operator note");
    expect(result.sessionId).toBeTruthy();
    expect(getHandoff(f.db, id)?.replyState).toBe("delivered");
  });
});
