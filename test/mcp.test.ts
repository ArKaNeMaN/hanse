import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHandoff, transitionHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { listHandoffMessages, transitionHandoffMessage } from "../src/coordinator/thread.js";
import { handleRpc } from "../src/mcp/protocol.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixtureWithDb(): { service: CoordinatorService; db: SqliteDatabase } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-mcp-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/x',?,?)",
  ).run(now, now);
  for (const key of ["a", "b", "c"]) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
    ).run(`p:${key}`, key, `apps/${key}`, now);
  }
  return { service: new CoordinatorService(db, "p"), db };
}

function fixture(): CoordinatorService {
  return fixtureWithDb().service;
}

function toolText(response: ReturnType<typeof handleRpc>): unknown {
  const result = (response as { result: { content: { text: string }[] } }).result;
  return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("mcp protocol", () => {
  it("initializes", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(
      (response as { result: { protocolVersion: string } }).result.protocolVersion,
    ).toBeTruthy();
  });

  it("lists tools", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (response as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toContain("request_sibling_change");
  });

  it("documents app keys, not full application ids, for request_sibling_change", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 5, method: "tools/list" });
    const tools = (
      response as {
        result: {
          tools: {
            name: string;
            description: string;
            inputSchema: { properties: Record<string, { description?: string }> };
          }[];
        };
      }
    ).result.tools;
    const tool = tools.find((candidate) => candidate.name === "request_sibling_change");
    expect(tool?.description).toContain("appKey");
    expect(tool?.inputSchema.properties.from?.description).toContain("appKey");
    expect(tool?.inputSchema.properties.to?.description).toContain("appKey");
  });

  it("tells agents not to poll for a handoff reply", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 6, method: "tools/list" });
    const tools = (response as { result: { tools: { name: string; description: string }[] } })
      .result.tools;
    const description = (name: string): string =>
      tools.find((candidate) => candidate.name === name)?.description ?? "";
    expect(description("request_sibling_change")).toMatch(/end your turn/i);
    expect(description("request_sibling_change")).toMatch(/do not poll/i);
    expect(description("handoff_status")).toMatch(/do not poll/i);
  });

  it("explains app keys when a full application id is passed as the target", () => {
    const service = fixture();
    expect(() =>
      service.requestSiblingChange({
        fromAppKey: "a",
        toAppKey: "p:b",
        summary: "s",
        spec: "x",
      }),
    ).toThrow(/appKey/);
  });

  it('rejects null, "" and non-string to_project as invalid_target_project (m1)', () => {
    const service = fixture();
    for (const toProject of [null, "", 42]) {
      const response = handleRpc(service, {
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: {
          name: "request_sibling_change",
          arguments: { from: "a", to: "b", summary: "s", spec: "x", to_project: toProject },
        },
      });
      const error = (response as { error?: { message?: string } }).error;
      expect(error?.message).toBe("invalid_target_project: to_project must be a project id");
    }
  });

  it("calls request_sibling_change and handoff_status", () => {
    const service = fixture();
    const request = handleRpc(service, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "request_sibling_change",
        arguments: { from: "a", to: "b", summary: "s", spec: "x" },
      },
    });
    const { handoffId } = toolText(request) as { handoffId: string };
    expect(handoffId).toBeTruthy();
    const status = handleRpc(service, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "handoff_status", arguments: { id: handoffId } },
    });
    expect((toolText(status) as { handoff: { id: string } }).handoff.id).toBe(handoffId);
  });

  it("ignores notifications", () => {
    const service = fixture();
    expect(
      handleRpc(service, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
  });

  it("returns an error for unknown methods", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 9, method: "nope" });
    expect((response as { error?: { code: number } }).error?.code).toBe(-32601);
  });

  it("advertises thread mode, send_handoff_message, and reply fields", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 10, method: "tools/list" });
    const tools = (
      response as {
        result: {
          tools: {
            name: string;
            inputSchema: { properties: Record<string, { enum?: string[]; type?: string }> };
          }[];
        };
      }
    ).result.tools;
    const byName = (name: string) => tools.find((tool) => tool.name === name);
    expect(byName("request_sibling_change")?.inputSchema.properties.mode).toMatchObject({
      type: "string",
      enum: ["one_shot", "thread"],
    });
    expect(byName("send_handoff_message")?.inputSchema.properties.body?.type).toBe("string");
    expect(byName("deliver_handoff")?.inputSchema.properties.reply_to?.type).toBe("integer");
    expect(byName("deliver_handoff")?.inputSchema.properties.client_message_id?.type).toBe(
      "string",
    );
  });

  it("calls the thread tools and returns the thread result shapes", () => {
    const { service, db } = fixtureWithDb();
    const started = handleRpc(
      service,
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "request_sibling_change",
          arguments: {
            from: "a",
            to: "b",
            summary: "thread",
            spec: "thread spec",
            mode: "thread",
            idempotency_key: "mcp-thread",
          },
        },
      },
      { fromAppKey: "a" },
    );
    const thread = toolText(started) as {
      handoffId: string;
      threadId: string;
      mode: string;
      initialMessage: { id: number; seq: number; clientMessageId: string; bindingNonce: string };
    };
    expect(thread).toMatchObject({ mode: "thread", threadId: thread.handoffId });
    expect(thread.initialMessage.seq).toBe(1);

    updateHandoff(db, thread.handoffId, {
      state: "in_progress",
      sourceSessionId: "ses-source",
      targetSessionId: "ses-target",
    });
    const sent = handleRpc(
      service,
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "send_handoff_message",
          arguments: { id: thread.handoffId, body: "follow up" },
        },
      },
      { fromAppKey: "a" },
    );
    const sentResult = toolText(sent) as {
      threadId: string;
      message: { id: number; seq: number; state: string; clientMessageId: string };
      handoff: { state: string; messageCount: number };
    };
    expect(sentResult).toMatchObject({
      threadId: thread.handoffId,
      handoff: { state: "in_progress", messageCount: 2 },
      message: { seq: 2, state: "binding" },
    });

    const initial = listHandoffMessages(db, thread.handoffId)[0];
    expect(initial).toBeDefined();
    transitionHandoffMessage(db, initial?.id ?? 0, "queued");
    transitionHandoffMessage(db, initial?.id ?? 0, "dispatching", {
      deliverySessionId: "ses-target",
    });
    const delivered = handleRpc(
      service,
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "deliver_handoff",
          arguments: {
            id: thread.handoffId,
            result: "done",
            outcome: "completed",
            reply_to: initial?.id,
          },
        },
      },
      { fromAppKey: "b" },
    );
    const deliveredResult = toolText(delivered) as {
      handoff: { id: string; state: string; messageCount: number };
      message: { seq: number; state: string };
      replyTo: { id: number; seq: number };
    };
    expect(deliveredResult).toMatchObject({
      handoff: { id: thread.handoffId, state: "in_progress", messageCount: 3 },
      message: { seq: 3, state: "binding" },
      replyTo: { id: initial?.id, seq: 1 },
    });

    const status = handleRpc(
      service,
      {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "handoff_status", arguments: { id: thread.handoffId } },
      },
      { fromAppKey: "a" },
    );
    const statusResult = toolText(status) as { handoff: Record<string, unknown> };
    expect(Object.keys(statusResult.handoff).sort()).toEqual(
      [
        "createdAt",
        "id",
        "lastMessageAt",
        "messageCount",
        "mode",
        "state",
        "threadIdleExpiresAt",
        "updatedAt",
      ].sort(),
    );
    expect(statusResult.handoff).not.toHaveProperty("spec");
  });

  it("keeps one-shot MCP results unchanged", () => {
    const { service, db } = fixtureWithDb();
    const request = handleRpc(service, {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "request_sibling_change",
        arguments: { from: "a", to: "b", summary: "one shot", spec: "spec" },
      },
    });
    const requested = toolText(request) as { handoffId: string };
    expect(Object.keys(requested).sort()).toEqual(["handoffId", "state", "status"]);
    expect(getHandoff(db, requested.handoffId)?.mode).toBe("one_shot");

    transitionHandoff(db, requested.handoffId, "dispatching");
    transitionHandoff(db, requested.handoffId, "in_progress");
    const delivered = handleRpc(
      service,
      {
        jsonrpc: "2.0",
        id: 16,
        method: "tools/call",
        params: {
          name: "deliver_handoff",
          arguments: { id: requested.handoffId, result: "done", outcome: "completed" },
        },
      },
      { fromAppKey: "b" },
    );
    const deliveredResult = toolText(delivered) as {
      handoff: { id: string; state: string };
    };
    expect(Object.keys(deliveredResult)).toEqual(["handoff"]);
    expect(deliveredResult.handoff.state).toBe("delivered");
  });
});
