import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHandoff, transitionHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import {
  createHandoffEventResolver,
  type HandoffProjectableMessage,
  projectHandoffMessages,
} from "../src/coordinator/handoff-messages.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { insertHandoffMessage } from "../src/coordinator/thread.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): { db: SqliteDatabase; service: CoordinatorService } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-hm-"));
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
  return { db, service: new CoordinatorService(db, "p") };
}

function message(id: string, role: "user" | "assistant" = "user"): HandoffProjectableMessage {
  return { info: { id, role } };
}

function handoffMeta(messageValue: HandoffProjectableMessage): Record<string, unknown> | undefined {
  const hanse = messageValue.info.hanse;
  if (typeof hanse !== "object" || hanse === null) return undefined;
  const value = (hanse as Record<string, unknown>).handoff;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function deliveredHandoff(db: SqliteDatabase, service: CoordinatorService): string {
  const { handoffId } = service.requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary: "need X",
    spec: "do **X**",
  });
  transitionHandoff(db, handoffId, "dispatching");
  transitionHandoff(db, handoffId, "in_progress");
  transitionHandoff(db, handoffId, "delivered", { result: "done **Y**", outcome: "completed" });
  updateHandoff(db, handoffId, {
    sourceSessionId: "ses_source",
    targetSessionId: "ses_target",
    dispatchMessageId: "msg_dispatch",
    replyMessageId: "msg_reply",
    replyDeliveredSessionId: "ses_source",
    replyState: "delivered",
  });
  return handoffId;
}

interface ThreadFixture {
  handoffId: string;
  requestId: number;
  messageId: number;
  replyId: number;
}

function threadFixture(db: SqliteDatabase, service: CoordinatorService): ThreadFixture {
  const { handoffId, initialMessage } = service.requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary: "Reconcile invoice totals",
    spec: "initial thread spec",
    mode: "thread",
    idempotencyKey: "thread-projection",
  });
  updateHandoff(db, handoffId, {
    state: "in_progress",
    sourceSessionId: "ses_source",
    targetSessionId: "ses_target",
  });
  const requestId = initialMessage?.id ?? 0;
  db.prepare(
    `UPDATE handoff_messages
     SET delivery_session_id = 'ses_target', delivery_message_id = 'msg_thread_request'
     WHERE id = ?`,
  ).run(requestId);
  const message = insertHandoffMessage(db, {
    handoffId,
    seq: 5,
    kind: "message",
    body: "The March totals still disagree by 0.02.",
    authorSide: "source",
    authorAppId: "p:a",
    state: "delivered",
    deliverySessionId: "ses_target",
    deliveryMessageId: "msg_thread_message",
  });
  const reply = insertHandoffMessage(db, {
    handoffId,
    seq: 6,
    kind: "reply",
    body: "Reconciled; the mismatch was a rounding row.",
    authorSide: "target",
    authorAppId: "p:b",
    state: "delivered",
    outcome: "completed",
    deliverySessionId: "ses_source",
    deliveryMessageId: "msg_thread_reply",
  });
  return { handoffId, requestId, messageId: message.id, replyId: reply.id };
}

describe("handoff chat message projection", () => {
  it("annotates the dispatch message with the source agent and request body", () => {
    const { db, service } = fixture();
    const handoffId = deliveredHandoff(db, service);
    const dispatch = message("msg_dispatch");
    const unrelated = message("msg_unrelated");
    const assistant = message("msg_dispatch", "assistant");

    projectHandoffMessages(db, "ses_target", [dispatch, unrelated, assistant]);

    expect(handoffMeta(dispatch)).toMatchObject({
      id: handoffId,
      direction: "request",
      agent: "a",
      from: "a",
      to: "b",
      summary: "need X",
      body: "do **X**",
      outcome: null,
    });
    expect(handoffMeta(unrelated)).toBeUndefined();
    expect(handoffMeta(assistant)).toBeUndefined();
    db.close();
  });

  it("annotates the reply message with the target agent and reply body", () => {
    const { db, service } = fixture();
    const handoffId = deliveredHandoff(db, service);
    const reply = message("msg_reply");

    projectHandoffMessages(db, "ses_source", [reply]);

    expect(handoffMeta(reply)).toMatchObject({
      id: handoffId,
      direction: "reply",
      agent: "b",
      from: "a",
      to: "b",
      body: "done **Y**",
      outcome: "completed",
      replyState: "delivered",
    });
    db.close();
  });

  it("keeps the one-shot HandoffCard metadata byte shape", () => {
    const { db, service } = fixture();
    const handoffId = deliveredHandoff(db, service);
    const dispatch = message("msg_dispatch");
    const reply = message("msg_reply");

    projectHandoffMessages(db, "ses_target", [dispatch]);
    projectHandoffMessages(db, "ses_source", [reply]);

    expect(handoffMeta(dispatch)).toEqual({
      id: handoffId,
      direction: "request",
      agent: "a",
      from: "a",
      to: "b",
      state: "delivered",
      summary: "need X",
      outcome: null,
      replyState: "delivered",
      origin: "agent",
      body: "do **X**",
    });
    expect(handoffMeta(reply)).toEqual({
      id: handoffId,
      direction: "reply",
      agent: "b",
      from: "a",
      to: "b",
      state: "delivered",
      summary: "need X",
      outcome: "completed",
      replyState: "delivered",
      origin: "agent",
      body: "done **Y**",
    });
    db.close();
  });

  it("keeps existing info.hanse fields and skips unrelated sessions", () => {
    const { db, service } = fixture();
    deliveredHandoff(db, service);
    const dispatch = message("msg_dispatch");
    dispatch.info.hanse = { attachments: [{ id: "att_1" }] };

    projectHandoffMessages(db, "ses_target", [dispatch]);
    expect(dispatch.info.hanse).toMatchObject({
      attachments: [{ id: "att_1" }],
      handoff: expect.objectContaining({ direction: "request" }),
    });

    const otherSession = message("msg_reply");
    projectHandoffMessages(db, "ses_other", [otherSession]);
    expect(handoffMeta(otherSession)).toBeUndefined();
    db.close();
  });

  it("annotates a relaunched reply session by its message id", () => {
    const { db, service } = fixture();
    deliveredHandoff(db, service);
    const handoff = db.prepare("SELECT id FROM handoffs").get() as { id: string };
    updateHandoff(db, handoff.id, {
      replyMessageId: "msg_relaunch",
      replyDeliveredSessionId: "ses_relaunch",
    });
    const reply = message("msg_relaunch");

    projectHandoffMessages(db, "ses_relaunch", [reply]);

    expect(handoffMeta(reply)).toMatchObject({
      id: handoff.id,
      direction: "reply",
      agent: "b",
    });
    db.close();
  });

  it("annotates thread source rows in target history with the thread meta shape", () => {
    const { db, service } = fixture();
    const { handoffId, requestId, messageId } = threadFixture(db, service);
    const request = message("msg_thread_request");
    const followUp = message("msg_thread_message");

    projectHandoffMessages(db, "ses_target", [request, followUp]);

    expect(handoffMeta(request)).toEqual({
      id: handoffId,
      direction: "request",
      agent: "a",
      from: "a",
      to: "b",
      state: "in_progress",
      summary: "Reconcile invoice totals",
      outcome: null,
      replyState: "none",
      origin: "agent",
      mode: "thread",
      kind: "request",
      authorSide: "source",
      messageId: requestId,
      seq: 1,
      body: "initial thread spec",
    });
    expect(handoffMeta(followUp)).toEqual({
      id: handoffId,
      direction: "request",
      agent: "a",
      from: "a",
      to: "b",
      state: "in_progress",
      summary: "Reconcile invoice totals",
      outcome: null,
      replyState: "none",
      origin: "agent",
      mode: "thread",
      kind: "message",
      authorSide: "source",
      messageId,
      seq: 5,
      body: "The March totals still disagree by 0.02.",
    });
    expect(handoffMeta(request)).not.toHaveProperty("operatorNote");
    expect(handoffMeta(followUp)).not.toHaveProperty("operatorNote");
    db.close();
  });

  it("annotates a thread target reply in source history", () => {
    const { db, service } = fixture();
    const { handoffId, replyId } = threadFixture(db, service);
    const reply = message("msg_thread_reply");

    projectHandoffMessages(db, "ses_source", [reply]);

    expect(handoffMeta(reply)).toEqual({
      id: handoffId,
      direction: "reply",
      agent: "b",
      from: "a",
      to: "b",
      state: "in_progress",
      summary: "Reconcile invoice totals",
      outcome: "completed",
      replyState: "none",
      origin: "agent",
      mode: "thread",
      kind: "reply",
      authorSide: "target",
      messageId: replyId,
      seq: 6,
      body: "Reconciled; the mismatch was a rounding row.",
    });
    expect(handoffMeta(reply)).not.toHaveProperty("operatorNote");
    db.close();
  });

  it("keeps one-shot routing columns null for thread rows", () => {
    const { db, service } = fixture();
    const { handoffId } = threadFixture(db, service);

    expect(getHandoff(db, handoffId)).toMatchObject({
      dispatchMessageId: null,
      replyMessageId: null,
      replyState: "none",
      replyDeliveredSessionId: null,
    });
    db.close();
  });

  it("returns body-less thread metadata from the live resolver", () => {
    const { db, service } = fixture();
    const { handoffId, messageId } = threadFixture(db, service);
    const resolver = createHandoffEventResolver(db);

    const meta = resolver.handoffForMessage("msg_thread_message");

    expect(meta).toEqual({
      id: handoffId,
      direction: "request",
      agent: "a",
      from: "a",
      to: "b",
      state: "in_progress",
      summary: "Reconcile invoice totals",
      outcome: null,
      replyState: "none",
      origin: "agent",
      mode: "thread",
      kind: "message",
      authorSide: "source",
      messageId,
      seq: 5,
    });
    expect(meta?.body).toBeUndefined();
    expect(resolver.handoffForMessage("msg_unknown")).toBeUndefined();
    db.close();
  });

  it("prefers thread metadata over a one-shot id collision", () => {
    const { db, service } = fixture();
    deliveredHandoff(db, service);
    const { handoffId, messageId } = threadFixture(db, service);
    db.prepare("UPDATE handoff_messages SET delivery_message_id = 'msg_dispatch' WHERE id = ?").run(
      messageId,
    );
    const collided = message("msg_dispatch");

    projectHandoffMessages(db, "ses_target", [collided]);

    expect(handoffMeta(collided)).toMatchObject({
      id: handoffId,
      mode: "thread",
      messageId,
    });
    expect(handoffMeta(collided)).not.toHaveProperty("operatorNote");

    const resolver = createHandoffEventResolver(db);
    expect(resolver.handoffForMessage("msg_dispatch")).toMatchObject({
      id: handoffId,
      mode: "thread",
      messageId,
    });
    db.close();
  });

  it("annotates only matching page ids in the thread delivery session", () => {
    const { db, service } = fixture();
    threadFixture(db, service);

    const otherPageMessage = message("msg_thread_unrelated");
    const assistant = message("msg_thread_message", "assistant");
    projectHandoffMessages(db, "ses_target", [otherPageMessage, assistant]);
    expect(handoffMeta(otherPageMessage)).toBeUndefined();
    expect(handoffMeta(assistant)).toBeUndefined();

    const otherSession = message("msg_thread_message");
    projectHandoffMessages(db, "ses_other", [otherSession]);
    expect(handoffMeta(otherSession)).toBeUndefined();

    const nullDelivery = insertHandoffMessage(db, {
      handoffId: (db.prepare("SELECT id FROM handoffs LIMIT 1").get() as { id: string }).id,
      seq: 7,
      kind: "message",
      body: "no delivery id",
      authorSide: "source",
      authorAppId: "p:a",
      state: "binding",
      deliverySessionId: "ses_target",
    });
    const nullDeliveryMessage = message(`msg_null_${nullDelivery.id}`);
    projectHandoffMessages(db, "ses_target", [nullDeliveryMessage]);
    expect(handoffMeta(nullDeliveryMessage)).toBeUndefined();
    db.close();
  });

  it("falls back to the participant key when the author app is gone", () => {
    const { db, service } = fixture();
    const { handoffId } = threadFixture(db, service);
    insertHandoffMessage(db, {
      handoffId,
      seq: 8,
      kind: "message",
      body: "deleted source author",
      authorSide: "source",
      authorAppId: null,
      state: "delivered",
      deliverySessionId: "ses_target",
      deliveryMessageId: "msg_deleted_source",
    });
    insertHandoffMessage(db, {
      handoffId,
      seq: 9,
      kind: "reply",
      body: "deleted target author",
      authorSide: "target",
      authorAppId: null,
      state: "delivered",
      outcome: "blocked",
      deliverySessionId: "ses_source",
      deliveryMessageId: "msg_deleted_target",
    });
    const sourceMessage = message("msg_deleted_source");
    const targetReply = message("msg_deleted_target");

    projectHandoffMessages(db, "ses_target", [sourceMessage]);
    projectHandoffMessages(db, "ses_source", [targetReply]);

    expect(handoffMeta(sourceMessage)).toMatchObject({
      agent: "a",
      from: "a",
      to: "b",
      authorSide: "source",
      kind: "message",
      outcome: null,
    });
    expect(handoffMeta(targetReply)).toMatchObject({
      agent: "b",
      from: "a",
      to: "b",
      authorSide: "target",
      kind: "reply",
      outcome: "blocked",
    });
    db.close();
  });

  it("returns lightweight live metadata without the body", () => {
    const { db, service } = fixture();
    deliveredHandoff(db, service);
    const resolver = createHandoffEventResolver(db);

    const meta = resolver.handoffForMessage("msg_dispatch");

    expect(meta).toMatchObject({
      direction: "request",
      agent: "a",
      summary: "need X",
    });
    expect(meta?.body).toBeUndefined();
    expect(resolver.handoffForMessage("msg_unknown")).toBeUndefined();
    db.close();
  });
});
