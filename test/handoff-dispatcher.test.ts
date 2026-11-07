import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideApproval, getPendingApproval } from "../src/coordinator/approval.js";
import { HandoffDispatcher } from "../src/coordinator/dispatcher.js";
import { getHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import { setHandoffPolicy } from "../src/coordinator/policy.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import type { ThreadLimits } from "../src/coordinator/thread.js";
import { getHandoffMessage, listHandoffMessages } from "../src/coordinator/thread.js";
import { createPrincipal } from "../src/identity/principals.js";
import { ImageNotReadyError } from "../src/images/service.js";
import {
  OpencodeHttpError,
  type OpencodeSession,
  type OpencodeSessionStatusMap,
} from "../src/opencode/client.js";
import type { HanseEvent } from "../src/opencode/events.js";
import type { ManagedApp } from "../src/opencode/manager.js";
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

const appA = { id: "p:a", projectId: "p", appKey: "a" };
const appB = { id: "p:b", projectId: "p", appKey: "b" };

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
  statuses: Map<string, OpencodeSessionStatusMap>;
  client: {
    createSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    sendPromptAsync: ReturnType<typeof vi.fn>;
    listMessages: ReturnType<typeof vi.fn>;
    listSessionStatuses: ReturnType<typeof vi.fn>;
    rejectQuestion: ReturnType<typeof vi.fn>;
    rejectQuestionV2: ReturnType<typeof vi.fn>;
  };
  prompts: Prompt[];
  ensured: string[];
  manager: {
    ensure: ReturnType<typeof vi.fn>;
    endpointFor: ReturnType<typeof vi.fn>;
  };
}

function fixture(
  options: {
    threadLimits?: Partial<ThreadLimits>;
    now?: () => number;
    logger?: (message: string) => void;
  } = {},
): Fixture {
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
  const statuses = new Map<string, OpencodeSessionStatusMap>();
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
    listSessionStatuses: vi.fn(async (endpoint: string) => statuses.get(endpoint) ?? {}),
    rejectQuestion: vi.fn(async () => true),
    rejectQuestionV2: vi.fn(async () => undefined),
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
    ...(options.threadLimits === undefined ? {} : { threadLimits: options.threadLimits }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  active.push({ dispatcher, db });
  return { db, dir, service, dispatcher, sessions, statuses, client, prompts, ensured, manager };
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

let threadKeyCounter = 0;
function nextThreadKey(prefix = "thread"): string {
  threadKeyCounter += 1;
  return `${prefix}-${threadKeyCounter}`;
}

function startThread(
  f: Fixture,
  overrides: Record<string, unknown> = {},
): ReturnType<CoordinatorService["requestSiblingChange"]> {
  return f.service.requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary: "thread summary",
    spec: "initial spec",
    mode: "thread",
    idempotencyKey: nextThreadKey(),
    ...overrides,
  });
}

function rawToolEvent(
  tool: string,
  status: string,
  output: unknown,
  sessionId: string,
  suffix: string,
): HanseEvent {
  return {
    type: "message.part.updated",
    sessionID: sessionId,
    messageID: `msg_${suffix}`,
    partID: `part_${suffix}`,
    partType: "tool",
    part: {
      tool,
      state: { status, output: JSON.stringify(output) },
    },
  } as HanseEvent;
}

function threadEvent(
  tool: "request_sibling_change" | "send_handoff_message" | "deliver_handoff",
  output: unknown,
  sessionId: string,
  suffix: string,
): HanseEvent {
  return rawToolEvent(`hanse_${tool}`, "completed", output, sessionId, suffix);
}

function initialEvent(
  result: ReturnType<CoordinatorService["requestSiblingChange"]>,
  sessionId = "ses_source",
): HanseEvent {
  return threadEvent(
    "request_sibling_change",
    {
      handoffId: result.handoffId,
      threadId: result.threadId,
      status: result.status,
      state: result.state,
      mode: result.mode,
      initialMessage: result.initialMessage,
    },
    sessionId,
    `initial_${result.handoffId}`,
  );
}

function sendEvent(
  threadId: string,
  message: {
    id: number;
    seq: number;
    state: string;
    clientMessageId: string;
    bindingNonce: string;
  },
  sessionId = "ses_source",
): HanseEvent {
  return threadEvent(
    "send_handoff_message",
    {
      threadId,
      message,
      handoff: { id: threadId, state: "in_progress", messageCount: message.seq },
    },
    sessionId,
    `send_${message.id}`,
  );
}

function replyEvent(
  delivered: {
    message: {
      id: number;
      seq: number;
      state: string;
      clientMessageId: string;
      bindingNonce: string;
    };
    handoff: { id: string; state: string; messageCount: number };
    replyTo: { id: number; seq: number };
  },
  sessionId = "ses_1",
): HanseEvent {
  return threadEvent("deliver_handoff", delivered, sessionId, `reply_${delivered.message.id}`);
}

const QUESTION_BAN_LINE =
  'Do not use the interactive question tool in this thread. If you are blocked, reply with deliver_handoff using outcome "blocked" and put your question in result.';

function questionEvent(
  sessionId: string,
  options: { source?: "v1" | "v2"; id?: string; key?: string; text?: string } = {},
): HanseEvent {
  const source = options.source ?? "v1";
  const id = options.id ?? "q1";
  return {
    type: "question.asked",
    request: {
      key: options.key ?? `${source}:${id}`,
      id,
      sessionID: sessionId,
      questions: [
        {
          header: "Question",
          question: options.text ?? "Which option?",
          options: [],
          multiple: false,
          custom: false,
        },
      ],
      source,
      tooLarge: false,
    },
  } as HanseEvent;
}

async function boundThread(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = startThread(f, overrides);
  f.dispatcher.observe(appA, initialEvent(result));
  await f.dispatcher.tickNow();
  return result.handoffId;
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

  it("keeps the one-shot dispatch and reply envelopes unchanged", async () => {
    const f = fixture();
    const id = await createBound(f);
    const dispatch = f.prompts[0]?.text ?? "";
    expect(dispatch.startsWith("[Hanse handoff request]\n")).toBe(true);
    expect(dispatch).toContain(`Handoff ID: ${id}`);
    expect(dispatch).toContain("From application: a");
    expect(dispatch).toContain("To application: b");
    expect(dispatch).toContain("Specification:\ndo X");
    expect(dispatch).toContain(
      'When the work is finished, call the "deliver_handoff" tool exactly once with:',
    );
    expect(dispatch).not.toContain("[Hanse handoff thread");
    expect(dispatch).not.toContain(QUESTION_BAN_LINE);

    f.service.deliverHandoff(id, "done", "completed", "b");
    await f.dispatcher.tickNow();
    const reply = f.prompts.at(-1)?.text ?? "";
    expect(reply.startsWith("[Hanse handoff reply]\n")).toBe(true);
    expect(reply).toContain(`Handoff ID: ${id}`);
    expect(reply).toContain("From application: b");
    expect(reply).toContain("To application: a");
    expect(reply).toContain("Outcome: completed");
    expect(reply).toContain("Result:\ndone");
    expect(reply).not.toContain("[Hanse handoff thread");
    expect(reply).not.toContain(QUESTION_BAN_LINE);
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
    expect(f.sessions.get("http://a.test")?.at(-1)?.title).toBe("[HO] a->b reply: need X");
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

describe("handoff dispatcher image failures", () => {
  it("stores a bounded handoff failure when dispatch cannot start the target", async () => {
    const f = fixture();
    f.manager.ensure.mockImplementation(async () => {
      throw new ImageNotReadyError(imageStateView({ appId: "p:b", state: "not_ready" }));
    });
    const id = await createBound(f);

    const handoff = getHandoff(f.db, id);
    expect(handoff?.state).toBe("failed");
    expect(handoff?.error).toContain("image_not_ready");
    expect(f.prompts).toHaveLength(0);
  });

  it("parks a reply with a bounded operator-visible error when the source cannot start", async () => {
    const f = fixture();
    const id = await createBound(f);
    f.service.deliverHandoff(id, "done", "completed", "b");
    f.manager.ensure.mockImplementation(async () => {
      throw new ImageNotReadyError(imageStateView({ appId: "p:a", state: "not_ready" }));
    });

    await f.dispatcher.tickNow();

    const handoff = getHandoff(f.db, id);
    expect(handoff?.replyState).toBe("waiting_operator");
    expect(handoff?.replyError).toContain("image_not_ready");
  });
});

describe("handoff thread dispatcher", () => {
  it("binds only the exact managed completed tool part and resolves the durable root", async () => {
    const f = fixture();
    f.sessions.set("http://a.test", [
      { id: "ses_source", title: "Source" },
      { id: "ses_child", parentID: "ses_source", title: "Child" },
    ]);
    const result = startThread(f, { idempotencyKey: "exact-observation" });
    const output = {
      handoffId: result.handoffId,
      threadId: result.threadId,
      status: result.status,
      state: result.state,
      mode: result.mode,
      initialMessage: result.initialMessage,
    };

    f.dispatcher.observe(
      appA,
      rawToolEvent("prefix_request_sibling_change", "completed", output, "ses_child", "wrong-name"),
    );
    f.dispatcher.observe(
      appA,
      rawToolEvent("hanse_request_sibling_change", "running", output, "ses_child", "wrong-status"),
    );
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, result.handoffId)?.sourceSessionId).toBeNull();

    f.dispatcher.observe(
      appA,
      rawToolEvent("hanse_request_sibling_change", "completed", output, "ses_child", "exact-part"),
    );
    await f.dispatcher.tickNow();

    const handoff = getHandoff(f.db, result.handoffId);
    expect(handoff?.sourceSessionId).toBe("ses_source");
    expect(handoff?.sourceInvokingSessionId).toBe("ses_child");
    expect(handoff?.sourceSessionTitle).toBe("Source");
    expect(handoff?.state).toBe("in_progress");
    expect(handoff?.targetSessionId).toBe("ses_1");
    expect(handoff?.dispatchMessageId).toBeNull();
    const initial = listHandoffMessages(f.db, result.handoffId)[0];
    expect(initial?.boundSessionId).toBe("ses_source");
    expect(initial?.invokingSessionId).toBe("ses_child");
    expect(initial?.deliverySessionId).toBe("ses_1");
    expect(initial?.state).toBe("delivered");
    expect(initial?.deliveredAt).not.toBeNull();
    expect(initial?.claimedAt).toBeNull();
    expect(handoff?.lastMessageAt).not.toBeNull();
    expect(Date.parse(handoff?.threadIdleExpiresAt ?? "")).toBeGreaterThan(
      Date.parse(handoff?.createdAt ?? ""),
    );
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]?.text).toContain("[Hanse handoff thread start]");
    expect(f.prompts[0]?.text).toContain(`Thread ID: ${result.handoffId}`);
    expect(f.prompts[0]?.text).toContain("UNTRUSTED CONTENT BEGIN");
  });

  it("fails closed on a depth-8 root walk and never revives the start", async () => {
    const f = fixture();
    const chain: OpencodeSession[] = [{ id: "ses_0", title: "Root" }];
    for (let index = 1; index <= 9; index += 1) {
      chain.push({ id: `ses_${index}`, parentID: `ses_${index - 1}`, title: `Level ${index}` });
    }
    f.sessions.set("http://a.test", chain);
    const result = startThread(f, { idempotencyKey: "deep-root" });
    f.dispatcher.observe(appA, initialEvent(result, "ses_9"));
    await f.dispatcher.tickNow();

    const handoff = getHandoff(f.db, result.handoffId);
    expect(handoff?.state).toBe("failed");
    expect(handoff?.sourceSessionId).toBeNull();
    const initial = listHandoffMessages(f.db, result.handoffId)[0];
    expect(initial).toMatchObject({ state: "cancelled", errorCode: "start_failed" });
    expect(f.prompts).toHaveLength(0);

    f.dispatcher.observe(
      appA,
      rawToolEvent(
        "hanse_request_sibling_change",
        "completed",
        {
          handoffId: result.handoffId,
          threadId: result.threadId,
          initialMessage: result.initialMessage,
        },
        "ses_source",
        "late-binder",
      ),
    );
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("failed");
    expect(listHandoffMessages(f.db, result.handoffId)[0]?.state).toBe("cancelled");
  });

  it("fails closed on a cyclic root chain", async () => {
    const f = fixture();
    f.sessions.set("http://a.test", [
      { id: "ses_a", parentID: "ses_b", title: "A" },
      { id: "ses_b", parentID: "ses_a", title: "B" },
    ]);
    const result = startThread(f, { idempotencyKey: "cycle-root" });
    f.dispatcher.observe(appA, initialEvent(result, "ses_a"));
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("failed");
    expect(f.prompts).toHaveLength(0);
  });

  it("fails closed when the observed parent session is absent", async () => {
    const f = fixture();
    f.sessions.set("http://a.test", [{ id: "ses_child", parentID: "ses_missing", title: "Child" }]);
    const result = startThread(f, { idempotencyKey: "missing-parent" });
    f.dispatcher.observe(appA, initialEvent(result, "ses_child"));
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("failed");
    expect(f.prompts).toHaveLength(0);
  });

  it("cancels only a follow-up whose nonce does not match", async () => {
    const f = fixture();
    const handoffId = await boundThread(f, { idempotencyKey: "follow-up-nonce" });
    const followUp = f.service.sendThreadMessage(handoffId, "follow up", undefined, "a");
    f.dispatcher.observe(
      appA,
      sendEvent(handoffId, {
        ...followUp.message,
        bindingNonce: "wrong-nonce",
      }),
    );
    await f.dispatcher.tickNow();
    expect(getHandoffMessage(f.db, followUp.message.id)).toMatchObject({
      state: "cancelled",
      errorCode: "nonce_mismatch",
    });
    expect(getHandoff(f.db, handoffId)?.state).toBe("in_progress");
  });

  it("waits for approval before creating the target and sends after approval", async () => {
    const f = fixture();
    const result = startThread(f, {
      idempotencyKey: "approved-thread",
      requiresApproval: true,
    });
    f.dispatcher.observe(appA, initialEvent(result));
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("awaiting_approval");
    expect(getHandoff(f.db, result.handoffId)?.targetSessionId).toBeNull();
    expect(f.prompts).toHaveLength(0);
    expect(listHandoffMessages(f.db, result.handoffId)[0]?.state).toBe("queued");

    const approval = getPendingApproval(f.db, result.handoffId, "dispatch");
    const human = createPrincipal(f.db, { kind: "human", name: "alice" }).principal;
    decideApproval(f.db, approval?.id ?? "", human, "approved");
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("dispatching");
    expect(getHandoff(f.db, result.handoffId)?.targetSessionId).toBeNull();

    await f.dispatcher.tickNow();
    const handoff = getHandoff(f.db, result.handoffId);
    expect(handoff?.state).toBe("in_progress");
    expect(handoff?.targetSessionId).toBe("ses_1");
    expect(handoff?.deadlineAt).toBeNull();
    expect(listHandoffMessages(f.db, result.handoffId)[0]?.deliverySessionId).toBe("ses_1");
    expect(f.prompts).toHaveLength(1);
    expect(f.sessions.get("http://b.test")?.[0]?.title).toBe("[HO] a->b: thread summary");
  });

  it("fails a thread start when approval was granted but the initial binding fails", async () => {
    const f = fixture();
    const result = startThread(f, {
      idempotencyKey: "post-approval-binding-failure",
      requiresApproval: true,
    });
    const approval = getPendingApproval(f.db, result.handoffId, "dispatch");
    const human = createPrincipal(f.db, { kind: "human", name: "alice" }).principal;
    decideApproval(f.db, approval?.id ?? "", human, "approved");
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("dispatching");

    f.dispatcher.observe(
      appA,
      rawToolEvent(
        "hanse_request_sibling_change",
        "completed",
        {
          handoffId: result.handoffId,
          threadId: result.threadId,
          initialMessage: {
            ...result.initialMessage,
            bindingNonce: "wrong-nonce",
          },
        },
        "ses_source",
        "post-approval-wrong-nonce",
      ),
    );
    await f.dispatcher.tickNow();

    expect(getHandoff(f.db, result.handoffId)?.state).toBe("failed");
    expect(listHandoffMessages(f.db, result.handoffId)[0]).toMatchObject({
      state: "cancelled",
      errorCode: "start_failed",
    });
    expect(getPendingApproval(f.db, result.handoffId, "dispatch")).toBeUndefined();
    expect(f.prompts).toHaveLength(0);
  });

  it("fails a thread start that exceeds the start deadline", async () => {
    const f = fixture();
    const result = startThread(f, { idempotencyKey: "start-timeout" });
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    f.db
      .prepare(
        "UPDATE handoffs SET state = 'dispatching', deadline_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(past, past, result.handoffId);
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("failed");
    expect(getHandoff(f.db, result.handoffId)?.error).toBe("start_failed");
    expect(listHandoffMessages(f.db, result.handoffId)[0]).toMatchObject({
      state: "cancelled",
      errorCode: "start_failed",
    });
    expect(f.prompts).toHaveLength(0);
  });

  it("does not dispatch a denied thread", async () => {
    const f = fixture();
    setHandoffPolicy(f.db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "deny",
      replyMode: "auto",
    });
    const result = startThread(f, { idempotencyKey: "denied-thread" });
    expect(result.status).toBe("denied");
    f.dispatcher.observe(appA, initialEvent(result));
    await f.dispatcher.tickNow();
    expect(getHandoff(f.db, result.handoffId)?.state).toBe("rejected");
    expect(getHandoff(f.db, result.handoffId)?.targetSessionId).toBeNull();
    expect(f.prompts).toHaveLength(0);
  });

  it("creates the target and initial delivery session without sending while busy", async () => {
    const f = fixture();
    const result = startThread(f, { idempotencyKey: "busy-start" });
    f.dispatcher.observe(appA, initialEvent(result));
    f.statuses.set("http://b.test", { ses_1: { type: "busy" } });
    await f.dispatcher.tickNow();

    const handoff = getHandoff(f.db, result.handoffId);
    expect(handoff?.state).toBe("in_progress");
    expect(handoff?.targetSessionId).toBe("ses_1");
    expect(listHandoffMessages(f.db, result.handoffId)[0]?.deliverySessionId).toBe("ses_1");
    expect(f.prompts).toHaveLength(0);

    f.statuses.set("http://b.test", { ses_1: { type: "idle" } });
    await f.dispatcher.tickNow();
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]?.sessionId).toBe("ses_1");
    expect(f.prompts[0]?.text).toContain("[Hanse handoff thread start]");
  });

  it("orders follow-ups and keeps retry/busy destinations queued", async () => {
    const f = fixture();
    const handoffId = await boundThread(f);
    expect(f.prompts).toHaveLength(1);
    const first = f.service.sendThreadMessage(handoffId, "follow one", undefined, "a");
    const second = f.service.sendThreadMessage(handoffId, "follow two", undefined, "a");
    f.dispatcher.observe(appA, sendEvent(handoffId, first.message));
    f.dispatcher.observe(appA, sendEvent(handoffId, second.message));

    f.statuses.set("http://b.test", { ses_1: { type: "retry" } });
    await f.dispatcher.tickNow();
    expect(
      listHandoffMessages(f.db, handoffId)
        .slice(1)
        .every((row) => row.state === "queued"),
    ).toBe(true);
    expect(f.prompts).toHaveLength(1);

    f.statuses.set("http://b.test", { ses_1: { type: "busy" } });
    await f.dispatcher.tickNow();
    expect(f.prompts).toHaveLength(1);

    f.statuses.set("http://b.test", { ses_1: { type: "idle" } });
    await f.dispatcher.tickNow();
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]?.text).toContain("(seq 2)");
    await f.dispatcher.tickNow();
    expect(f.prompts).toHaveLength(3);
    expect(f.prompts[2]?.text).toContain("(seq 3)");
  });

  it("parks a 404 send as waiting_operator without retry", async () => {
    const f = fixture();
    f.client.sendPromptAsync.mockRejectedValueOnce(
      new OpencodeHttpError("/session/ses_1/message", 404, "missing"),
    );
    const handoffId = await boundThread(f);
    const initial = listHandoffMessages(f.db, handoffId)[0];
    expect(initial).toMatchObject({
      state: "waiting_operator",
      errorCode: "session_missing",
    });
    expect(getHandoff(f.db, handoffId)?.state).toBe("in_progress");
    expect(f.prompts).toHaveLength(0);

    await f.dispatcher.tickNow();
    expect(listHandoffMessages(f.db, handoffId)[0]?.state).toBe("waiting_operator");
    expect(f.prompts).toHaveLength(0);
  });

  it("parks a transport failure and stale dispatch as waiting_operator", async () => {
    const f = fixture();
    f.client.sendPromptAsync.mockRejectedValueOnce(new Error("transport down"));
    const handoffId = await boundThread(f);
    const initial = listHandoffMessages(f.db, handoffId)[0];
    expect(initial).toMatchObject({ state: "waiting_operator", errorCode: "transport_error" });

    const second = f.service.sendThreadMessage(handoffId, "follow up", undefined, "a");
    f.dispatcher.observe(appA, sendEvent(handoffId, second.message));
    await f.dispatcher.tickNow();
    expect(getHandoffMessage(f.db, second.message.id)?.state).toBe("queued");

    f.db
      .prepare(
        "UPDATE handoff_messages SET state = 'dispatching', claimed_at = ?, delivered_at = NULL WHERE id = ?",
      )
      .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), second.message.id);
    await f.dispatcher.tickNow();
    expect(getHandoffMessage(f.db, second.message.id)).toMatchObject({
      state: "waiting_operator",
      errorCode: "dispatch_timeout",
    });
    expect(f.prompts).toHaveLength(0);
  });

  it("serializes replies from two threads onto the same source session", async () => {
    const f = fixture();
    const first = await boundThread(f, { idempotencyKey: "serialize-first" });
    const second = await boundThread(f, { idempotencyKey: "serialize-second" });
    expect(getHandoff(f.db, first)?.targetSessionId).toBe("ses_1");
    expect(getHandoff(f.db, second)?.targetSessionId).toBe("ses_2");

    const firstInitial = listHandoffMessages(f.db, first)[0];
    const secondInitial = listHandoffMessages(f.db, second)[0];
    const firstReply = f.service.deliverHandoff(first, "reply one", "completed", "b", {
      replyTo: firstInitial?.id,
    });
    const secondReply = f.service.deliverHandoff(second, "reply two", "completed", "b", {
      replyTo: secondInitial?.id,
    });
    if (!("message" in firstReply) || !("message" in secondReply)) {
      throw new Error("expected thread replies");
    }
    f.dispatcher.observe(appB, replyEvent(firstReply, "ses_1"));
    f.dispatcher.observe(appB, replyEvent(secondReply, "ses_2"));
    const before = f.prompts.length;

    await f.dispatcher.tickNow();
    expect(f.prompts.length).toBe(before + 1);
    await f.dispatcher.tickNow();
    expect(f.prompts.length).toBe(before + 2);
    const replyPrompts = f.prompts.slice(before);
    expect(replyPrompts[0]?.sessionId).toBe("ses_source");
    expect(replyPrompts[1]?.sessionId).toBe("ses_source");
  });

  it("reconciles a binding from the opencode history after a restart", async () => {
    const f = fixture();
    const result = startThread(f, { idempotencyKey: "reconcile-binding" });
    f.sessions.set("http://a.test", [{ id: "ses_source", title: "Source" }]);
    f.client.listMessages.mockImplementation(async (endpoint: string, sessionId: string) => {
      if (endpoint !== "http://a.test" || sessionId !== "ses_source") return [];
      return [
        {
          info: { id: "msg_reconcile", role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "hanse_request_sibling_change",
              state: {
                status: "completed",
                output: JSON.stringify({
                  handoffId: result.handoffId,
                  threadId: result.threadId,
                  initialMessage: result.initialMessage,
                }),
              },
            },
          ],
        },
      ];
    });

    await f.dispatcher.tickNow();
    const handoff = getHandoff(f.db, result.handoffId);
    expect(handoff?.sourceSessionId).toBe("ses_source");
    expect(handoff?.state).toBe("in_progress");
    expect(f.prompts).toHaveLength(1);
  });

  it("uses [HO] titles and keeps a thread from holding the one-shot lane", async () => {
    const f = fixture();
    const threadId = await boundThread(f, { idempotencyKey: "lane-thread" });
    const oneShot = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "one shot",
      spec: "spec",
    });
    f.dispatcher.observe(appA, eventFor(oneShot.handoffId));
    await f.dispatcher.tickNow();

    expect(getHandoff(f.db, threadId)?.state).toBe("in_progress");
    expect(getHandoff(f.db, oneShot.handoffId)?.state).toBe("in_progress");
    expect(f.sessions.get("http://b.test")?.[0]?.title).toBe("[HO] a->b: thread summary");
    const oneShotSession = f.sessions
      .get("http://b.test")
      ?.find((session) => session.id === getHandoff(f.db, oneShot.handoffId)?.targetSessionId);
    expect(oneShotSession?.title).toBe("[HO] a->b: one shot");
    expect(getHandoff(f.db, oneShot.handoffId)?.sourceSessionTitle).toBeNull();
  });

  it("cancels a reply from the wrong target root and still accepts a legitimate reply", async () => {
    const f = fixture();
    const handoffId = await boundThread(f, { idempotencyKey: "wrong-root-reply" });
    const targetSessionId = getHandoff(f.db, handoffId)?.targetSessionId;
    f.sessions.set("http://b.test", [
      ...(f.sessions.get("http://b.test") ?? []),
      { id: "ses_rogue", title: "Rogue" },
    ]);
    const initial = listHandoffMessages(f.db, handoffId)[0];
    const badReply = f.service.deliverHandoff(handoffId, "bad", "completed", "b", {
      replyTo: initial?.id,
    });
    if (!("message" in badReply)) throw new Error("expected thread reply");
    f.dispatcher.observe(appB, replyEvent(badReply, "ses_rogue"));
    await f.dispatcher.tickNow();
    expect(getHandoffMessage(f.db, badReply.message.id)).toMatchObject({
      state: "cancelled",
      errorCode: "wrong_session",
    });
    expect(getHandoff(f.db, handoffId)?.state).toBe("in_progress");

    const goodReply = f.service.deliverHandoff(handoffId, "good", "completed", "b", {
      replyTo: initial?.id,
      clientMessageId: "good-reply-client",
    });
    if (!("message" in goodReply)) throw new Error("expected thread reply");
    f.dispatcher.observe(appB, replyEvent(goodReply, targetSessionId ?? "ses_1"));
    await f.dispatcher.tickNow();
    expect(getHandoffMessage(f.db, goodReply.message.id)?.state).toBe("delivered");
  });
});

describe("handoff thread lifecycle", () => {
  it("expires an idle thread even with a waiting_operator head", async () => {
    const f = fixture();
    const handoffId = startThread(f, { idempotencyKey: "idle-expiry" }).handoffId;
    const past = new Date(Date.now() - 1000).toISOString();
    updateHandoff(f.db, handoffId, {
      state: "in_progress",
      sourceSessionId: "ses_source",
      targetSessionId: "ses_1",
      threadIdleExpiresAt: past,
    });
    const initial = listHandoffMessages(f.db, handoffId)[0];
    f.db
      .prepare(
        "UPDATE handoff_messages SET state = 'waiting_operator', updated_at = ? WHERE id = ?",
      )
      .run(past, initial?.id ?? 0);
    const insertExtra = f.db.prepare(
      `INSERT INTO handoff_messages
         (handoff_id, seq, kind, body, author_side, state, created_at, updated_at)
       VALUES (?, ?, 'message', 'body', 'source', ?, ?, ?)`,
    );
    insertExtra.run(handoffId, 2, "queued", past, past);
    insertExtra.run(handoffId, 3, "binding", past, past);

    await f.dispatcher.tickNow();

    expect(getHandoff(f.db, handoffId)?.state).toBe("expired");
    expect(
      listHandoffMessages(f.db, handoffId).map((message) => [message.state, message.errorCode]),
    ).toEqual([
      ["cancelled", "thread_expired"],
      ["cancelled", "thread_expired"],
      ["cancelled", "thread_expired"],
    ]);
    expect(f.prompts).toHaveLength(0);
  });

  it("does not expire a thread while a message is dispatching", async () => {
    const f = fixture();
    const handoffId = startThread(f, { idempotencyKey: "idle-dispatching" }).handoffId;
    const past = new Date(Date.now() - 1000).toISOString();
    updateHandoff(f.db, handoffId, {
      state: "in_progress",
      sourceSessionId: "ses_source",
      targetSessionId: "ses_1",
      threadIdleExpiresAt: past,
    });
    const initial = listHandoffMessages(f.db, handoffId)[0];
    f.db
      .prepare(
        `UPDATE handoff_messages
         SET state = 'dispatching', delivery_session_id = 'ses_1', claimed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), initial?.id ?? 0);

    await f.dispatcher.tickNow();

    expect(getHandoff(f.db, handoffId)?.state).toBe("in_progress");
    expect(getHandoffMessage(f.db, initial?.id ?? 0)?.state).toBe("dispatching");
  });

  it("garbage-collects terminal threads in bounded batches and leaves one-shot rows", async () => {
    const f = fixture({ threadLimits: { terminalRetentionMs: 1000, gcBatch: 1 } });
    const old = new Date(Date.now() - 60_000).toISOString();
    const older = new Date(Date.now() - 61_000).toISOString();
    const first = startThread(f, { idempotencyKey: "gc-first" }).handoffId;
    const second = startThread(f, { idempotencyKey: "gc-second" }).handoffId;
    f.db
      .prepare("UPDATE handoffs SET state = 'cancelled', updated_at = ? WHERE id = ?")
      .run(older, first);
    f.db
      .prepare("UPDATE handoffs SET state = 'failed', updated_at = ? WHERE id = ?")
      .run(old, second);
    const oneShot = f.service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "one shot",
      spec: "spec",
    }).handoffId;
    f.db
      .prepare("UPDATE handoffs SET state = 'cancelled', updated_at = ? WHERE id = ?")
      .run(old, oneShot);
    const firstMessages = f.db
      .prepare("SELECT COUNT(*) AS count FROM handoff_messages WHERE handoff_id = ?")
      .get(first) as { count: number };

    await f.dispatcher.tickNow();

    const threadRows = f.db
      .prepare("SELECT COUNT(*) AS count FROM handoffs WHERE mode = 'thread'")
      .get() as { count: number };
    expect(threadRows.count).toBe(1);
    expect(getHandoff(f.db, oneShot)?.state).toBe("cancelled");
    expect(firstMessages.count).toBeGreaterThan(0);
    const remainingMessage = f.db
      .prepare("SELECT COUNT(*) AS count FROM handoff_messages WHERE handoff_id = ?")
      .get(first) as { count: number };
    expect(remainingMessage.count).toBe(0);
    expect(f.dispatcher.threadLimits.gcBatch).toBe(1);
    expect(f.dispatcher.threadLimits.terminalRetentionMs).toBe(1000);
  });

  it("records a prompt rejection as a fixed error code", async () => {
    const f = fixture();
    f.client.sendPromptAsync.mockRejectedValueOnce(
      new OpencodeHttpError("/session/ses_1/message", 400, "prompt rejected"),
    );
    const handoffId = await boundThread(f, { idempotencyKey: "prompt-rejected" });
    expect(listHandoffMessages(f.db, handoffId)[0]).toMatchObject({
      state: "waiting_operator",
      errorCode: "prompt_rejected",
    });
  });

  it("redacts raw send errors from logs and stores a fixed error code", async () => {
    const logs: string[] = [];
    const f = fixture({ logger: (message) => logs.push(message) });
    f.client.sendPromptAsync.mockRejectedValueOnce(
      new Error("http://secret-token/prompt body do-not-log"),
    );
    const handoffId = await boundThread(f, { idempotencyKey: "redaction" });
    const initial = listHandoffMessages(f.db, handoffId)[0];
    expect(initial).toMatchObject({
      state: "waiting_operator",
      errorCode: "transport_error",
    });
    const joined = logs.join("\n");
    expect(joined).not.toContain("secret-token");
    expect(joined).not.toContain("do-not-log");
    expect(getHandoff(f.db, handoffId)?.state).toBe("in_progress");
  });
});

describe("handoff thread question guard", () => {
  it("rejects a v2 target-root question once with the observed session", async () => {
    const f = fixture();
    await boundThread(f);

    f.dispatcher.observe(appB, questionEvent("ses_1", { source: "v2" }));

    await vi.waitFor(() => expect(f.client.rejectQuestionV2).toHaveBeenCalledTimes(1));
    expect(f.client.rejectQuestionV2).toHaveBeenCalledWith("http://b.test", "ses_1", "q1");
    expect(f.client.rejectQuestion).not.toHaveBeenCalled();
  });

  it("rejects a v1 target-root question once with the request id", async () => {
    const f = fixture();
    await boundThread(f);

    f.dispatcher.observe(appB, questionEvent("ses_1", { source: "v1" }));

    await vi.waitFor(() => expect(f.client.rejectQuestion).toHaveBeenCalledTimes(1));
    expect(f.client.rejectQuestion).toHaveBeenCalledWith("http://b.test", "q1");
    expect(f.client.rejectQuestionV2).not.toHaveBeenCalled();
  });

  it("resolves a target subagent to its root and keeps the observed session for v2", async () => {
    const f = fixture();
    await boundThread(f);
    f.sessions.set("http://b.test", [
      ...(f.sessions.get("http://b.test") ?? []),
      { id: "ses_child", parentID: "ses_1", title: "Child" },
    ]);

    f.dispatcher.observe(appB, questionEvent("ses_child", { source: "v2", id: "q_child" }));

    await vi.waitFor(() => expect(f.client.rejectQuestionV2).toHaveBeenCalledTimes(1));
    expect(f.client.rejectQuestionV2).toHaveBeenCalledWith("http://b.test", "ses_child", "q_child");
    expect(f.client.rejectQuestion).not.toHaveBeenCalled();
  });

  it("never rejects a source root and prefers source over target on overlap", async () => {
    const logs: string[] = [];
    const f = fixture({ logger: (message) => logs.push(message) });
    const handoffId = await boundThread(f);

    f.dispatcher.observe(appA, questionEvent("ses_source", { source: "v2" }));
    await vi.waitFor(() =>
      expect(logs).toContain("thread question app=p:a session=ses_sour source=v2 status=source"),
    );

    updateHandoff(f.db, handoffId, { sourceSessionId: "ses_1" });
    f.dispatcher.observe(appB, questionEvent("ses_1", { source: "v2" }));
    await vi.waitFor(() =>
      expect(logs).toContain("thread question app=p:b session=ses_1 source=v2 status=source"),
    );

    expect(f.client.rejectQuestion).not.toHaveBeenCalled();
    expect(f.client.rejectQuestionV2).not.toHaveBeenCalled();
  });

  it("does not reject operator, unrelated, terminal, one-shot, or permission events", async () => {
    const f = fixture();
    const threadId = await boundThread(f);
    f.sessions.set("http://b.test", [
      ...(f.sessions.get("http://b.test") ?? []),
      { id: "ses_other", title: "Other" },
    ]);

    let before = f.client.listSessions.mock.calls.length;
    f.dispatcher.observe(appB, questionEvent("ses_other", { id: "q_other" }));
    await vi.waitFor(() => expect(f.client.listSessions.mock.calls.length).toBeGreaterThan(before));

    updateHandoff(f.db, threadId, { state: "delivered" });
    before = f.client.listSessions.mock.calls.length;
    f.dispatcher.observe(appB, questionEvent("ses_1", { id: "q_terminal" }));
    await vi.waitFor(() => expect(f.client.listSessions.mock.calls.length).toBeGreaterThan(before));

    const oneShot = await createBound(f);
    const oneShotTarget = getHandoff(f.db, oneShot)?.targetSessionId ?? "ses_1";
    before = f.client.listSessions.mock.calls.length;
    f.dispatcher.observe(appB, questionEvent(oneShotTarget, { id: "q_oneshot" }));
    await vi.waitFor(() => expect(f.client.listSessions.mock.calls.length).toBeGreaterThan(before));

    const permissionEvent = {
      type: "permission.asked",
      request: {
        key: "v1:p1",
        id: "p1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["ls*"],
        metadata: {},
        always: ["ls*"],
        source: "v1",
      },
    } as HanseEvent;
    f.dispatcher.observe(appB, permissionEvent);
    await Promise.resolve();

    expect(f.client.rejectQuestion).not.toHaveBeenCalled();
    expect(f.client.rejectQuestionV2).not.toHaveBeenCalled();
  });

  it("deduplicates one question key", async () => {
    const f = fixture();
    await boundThread(f);
    const event = questionEvent("ses_1", { source: "v2" });

    f.dispatcher.observe(appB, event);
    f.dispatcher.observe(appB, event);

    await vi.waitFor(() => expect(f.client.rejectQuestionV2).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(f.client.rejectQuestionV2).toHaveBeenCalledTimes(1);
  });

  it("swallows 404 and 409 reject responses without retrying", async () => {
    const logs: string[] = [];
    const f = fixture({ logger: (message) => logs.push(message) });
    f.client.rejectQuestion.mockRejectedValueOnce(
      new OpencodeHttpError("/question/q1/reject", 404, "gone"),
    );
    await boundThread(f);

    f.dispatcher.observe(appB, questionEvent("ses_1", { source: "v1" }));
    await vi.waitFor(() =>
      expect(logs).toContain("thread question app=p:b session=ses_1 source=v1 status=404"),
    );

    f.client.rejectQuestionV2.mockRejectedValueOnce(
      new OpencodeHttpError("/question/q1/reject", 409, "answered"),
    );
    f.dispatcher.observe(appB, questionEvent("ses_1", { source: "v2", id: "q2" }));
    await vi.waitFor(() =>
      expect(logs).toContain("thread question app=p:b session=ses_1 source=v2 status=409"),
    );

    expect(f.client.rejectQuestion).toHaveBeenCalledTimes(1);
    expect(f.client.rejectQuestionV2).toHaveBeenCalledTimes(1);
  });

  it("fails open on an unresolved endpoint or root with one bounded warning", async () => {
    const logs: string[] = [];
    const f = fixture({ logger: (message) => logs.push(message) });
    await boundThread(f);

    f.manager.endpointFor.mockReturnValue(undefined);
    f.dispatcher.observe(appB, questionEvent("ses_1", { source: "v2" }));
    await vi.waitFor(() =>
      expect(logs).toContain("thread question app=p:b session=ses_1 source=v2 status=no_endpoint"),
    );

    f.manager.endpointFor.mockImplementation(
      (appId: string) => `http://${appId.split(":").pop()}.test`,
    );
    f.dispatcher.observe(appB, questionEvent("ses_missing", { source: "v2", id: "q3" }));
    await vi.waitFor(() =>
      expect(logs).toContain(
        "thread question app=p:b session=ses_miss source=v2 status=unresolved",
      ),
    );

    expect(f.client.rejectQuestion).not.toHaveBeenCalled();
    expect(f.client.rejectQuestionV2).not.toHaveBeenCalled();
    const questionLogs = logs.filter((message) => message.startsWith("thread question"));
    expect(questionLogs).toHaveLength(2);
  });

  it("logs only fixed metadata and never question or request details", async () => {
    const logs: string[] = [];
    const f = fixture({ logger: (message) => logs.push(message) });
    const secret = "never-log-this-question";
    const sessionId = "ses_target_long_value";
    const handoffId = await boundThread(f);
    updateHandoff(f.db, handoffId, { targetSessionId: sessionId });
    f.sessions.set("http://b.test", [{ id: sessionId, title: "Target" }]);

    f.dispatcher.observe(
      appB,
      questionEvent(sessionId, { source: "v2", id: "secret_request_id", text: secret }),
    );

    await vi.waitFor(() => expect(f.client.rejectQuestionV2).toHaveBeenCalledTimes(1));
    const joined = logs.join("\n");
    expect(joined).toContain("thread question app=p:b");
    expect(joined).toContain("session=ses_targ");
    expect(joined).toContain("source=v2");
    expect(joined).toContain("status=rejected");
    expect(joined).not.toContain(sessionId);
    expect(joined).not.toContain("secret_request_id");
    expect(joined).not.toContain(secret);
  });

  it("suppresses only in-progress thread target roots", async () => {
    const f = fixture();
    const handoffId = await boundThread(f);

    await expect(f.dispatcher.shouldSuppressQuestion("p:b", "ses_1")).resolves.toBe(true);
    await expect(f.dispatcher.shouldSuppressQuestion("p:a", "ses_source")).resolves.toBe(false);
    await expect(f.dispatcher.shouldSuppressQuestion("p:b", "ses_missing")).resolves.toBe(false);

    updateHandoff(f.db, handoffId, { state: "delivered" });
    await expect(f.dispatcher.shouldSuppressQuestion("p:b", "ses_1")).resolves.toBe(false);
  });

  it("adds the question ban to start and follow-up prompts only", async () => {
    const f = fixture();
    const handoffId = await boundThread(f);
    const start = f.prompts[0]?.text ?? "";
    expect(start).toContain("[Hanse handoff thread start]");
    expect(start).toContain(QUESTION_BAN_LINE);

    const followUp = f.service.sendThreadMessage(handoffId, "follow up", undefined, "a");
    f.dispatcher.observe(appA, sendEvent(handoffId, followUp.message));
    await f.dispatcher.tickNow();
    const followUpPrompt = f.prompts.at(-1)?.text ?? "";
    expect(followUpPrompt).toContain("[Hanse handoff thread message]");
    expect(followUpPrompt).toContain(QUESTION_BAN_LINE);

    const initial = listHandoffMessages(f.db, handoffId)[0];
    const reply = f.service.deliverHandoff(handoffId, "done", "completed", "b", {
      replyTo: initial?.id,
    });
    if (!("message" in reply)) throw new Error("expected thread reply");
    f.dispatcher.observe(appB, replyEvent(reply, "ses_1"));
    await f.dispatcher.tickNow();
    const replyPrompt = f.prompts.at(-1)?.text ?? "";
    expect(replyPrompt).toContain("[Hanse handoff thread reply]");
    expect(replyPrompt).not.toContain(QUESTION_BAN_LINE);
  });
});
