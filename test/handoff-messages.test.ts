import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transitionHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import {
  createHandoffEventResolver,
  type HandoffProjectableMessage,
  projectHandoffMessages,
} from "../src/coordinator/handoff-messages.js";
import { CoordinatorService } from "../src/coordinator/service.js";
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
