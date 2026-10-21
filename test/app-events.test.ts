import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { setEndpointAuthorization } from "../src/opencode/endpoint-auth.js";
import { MAX_TYPED_EVENT_BYTES } from "../src/opencode/events.js";
import type { InstanceManager } from "../src/opencode/manager.js";
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
  agentToken: string;
  base: string;
}

function addProject(db: SqliteDatabase, id: string, name: string, appKey: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?,?,'main',?,?,?)",
  ).run(id, name, `/tmp/${id}`, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?,?,?,?, 'AGENTS.md', ?)",
  ).run(`${id}:${appKey}`, id, appKey, `apps/${appKey}`, now);
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-events-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  addProject(db, "p1", "Alpha", "storefront");
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "bot" }).token;
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
  const server = createHttpServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { db, deps, token, agentToken, base: `http://127.0.0.1:${address.port}` };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface EventUpstream {
  endpoint: string;
  requests: string[];
  authorizations: Array<string | undefined>;
  send(chunk: string): void;
  close(): void;
  closed(): boolean;
}

async function fakeEventUpstream(status = 200): Promise<EventUpstream> {
  const requests: string[] = [];
  const authorizations: Array<string | undefined> = [];
  let respond: ServerResponse | undefined;
  let closedFlag = false;
  const server = createServer((incoming, outgoing) => {
    requests.push(incoming.url ?? "");
    authorizations.push(incoming.headers.authorization);
    if (incoming.url !== "/event") {
      outgoing.writeHead(404, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (status !== 200) {
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "boom" }));
      return;
    }
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.flushHeaders();
    respond = outgoing;
    incoming.on("close", () => {
      closedFlag = true;
    });
    outgoing.on("close", () => {
      closedFlag = true;
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    authorizations,
    send(chunk) {
      respond?.write(chunk);
    },
    close() {
      respond?.end();
    },
    closed() {
      return closedFlag;
    },
  };
}

function useUpstream(deps: HttpDeps, endpoint: string): void {
  deps.manager = {
    ensure: async () => endpoint,
    policyWarnings: () => [],
  } as unknown as InstanceManager;
}

interface Probe {
  waitFor(text: string, timeoutMs?: number): Promise<string>;
  text(): string;
  close(): Promise<void>;
}

function probe(response: Response): Probe {
  const body = response.body;
  if (body === null) throw new Error("stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async waitFor(text, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (!buffer.includes(text)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for ${text}; got ${buffer}`);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out reading stream`)), remaining);
        });
        try {
          const { done, value } = await Promise.race([reader.read(), timeout]);
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      if (!buffer.includes(text)) throw new Error(`missing ${text}; got ${buffer}`);
      return buffer;
    },
    text() {
      return buffer;
    },
    async close() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

function frames(buffer: string): Array<Record<string, unknown>> {
  return buffer
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data.length > 0)
    .flatMap((data) => {
      try {
        return [JSON.parse(data) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function readyOf(buffer: string): Record<string, unknown> {
  const ready = frames(buffer).find((event) => event.type === "stream.ready");
  if (ready === undefined) throw new Error(`missing stream.ready; got ${buffer}`);
  return ready;
}

function jsonFrame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("app event stream", () => {
  it("requires a human principal before starting the runtime", async () => {
    const f = await fixture();
    let ensured = 0;
    f.deps.manager = {
      ensure: async () => {
        ensured += 1;
        return "http://127.0.0.1:1";
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const missing = await fetch(`${f.base}/api/apps/storefront/events`);
    expect(missing.status).toBe(401);

    const agent = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.agentToken),
    });
    expect(agent.status).toBe(403);
    expect(ensured).toBe(0);
  });

  it("returns 503 without a runtime and 404 for an unknown app", async () => {
    const f = await fixture();
    const noRuntime = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    expect(noRuntime.status).toBe(503);

    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const unknown = await fetch(`${f.base}/api/apps/nope/events`, {
      headers: auth(f.token),
    });
    expect(unknown.status).toBe(404);
  });

  it("writes SSE headers and a sequenced stream.ready once the reader is attached", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);

    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const stream = probe(response);
    try {
      const text = await stream.waitFor('"type":"stream.ready"');
      const ready = readyOf(text);
      expect(ready.type).toBe("stream.ready");
      expect(ready.seq).toBe(0);
      expect(typeof ready.streamID).toBe("string");
      expect((ready.streamID as string).length).toBeGreaterThan(0);
      expect(frames(text)).toEqual([ready]);
    } finally {
      await stream.close();
    }
  });

  it("uses a different streamID for each connection", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);

    const first = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const firstProbe = probe(first);
    const second = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const secondProbe = probe(second);
    try {
      const firstReady = readyOf(await firstProbe.waitFor('"type":"stream.ready"'));
      const secondReady = readyOf(await secondProbe.waitFor('"type":"stream.ready"'));
      expect(firstReady.streamID).not.toBe(secondReady.streamID);
    } finally {
      await firstProbe.close();
      await secondProbe.close();
    }
  });

  it("projects v1 and v2 frames and forwards warnings", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);

    try {
      await stream.waitFor('"type":"stream.ready"');
      upstream.send(
        [
          "data: not-json\n\n",
          jsonFrame({
            id: "evt_v1_q",
            type: "question.asked",
            properties: {
              id: "q1",
              sessionID: "ses_1",
              questions: [
                {
                  header: "H",
                  question: "Q?",
                  options: [{ label: "A", description: "" }],
                },
              ],
            },
          }),
          jsonFrame({
            id: "evt_v2_q",
            type: "question.v2.asked",
            properties: {
              id: "q2",
              sessionID: "ses_2",
              questions: [
                { header: "H", question: "Q?", options: [], multiple: true, custom: true },
              ],
            },
          }),
          jsonFrame({
            id: "evt_v2_perm",
            type: "permission.v2.asked",
            properties: {
              id: "p2",
              sessionID: "ses_2",
              action: "bash",
              resources: ["ls*"],
              save: ["ls*"],
            },
          }),
          jsonFrame({
            id: "evt_todo",
            type: "todo.updated",
            properties: {
              sessionID: "ses_2",
              todos: [{ content: "step", status: "blocked", priority: "urgent" }],
            },
          }),
          jsonFrame({
            id: "evt_activity",
            type: "session.status",
            properties: { sessionID: "ses_3" },
          }),
        ].join(""),
      );

      const text = await stream.waitFor('"type":"session.activity"');
      const projected = frames(text);
      const ready = readyOf(text);
      expect(projected[0]).toEqual(ready);
      expect(projected).toContainEqual(
        expect.objectContaining({
          type: "stream.warning",
          code: "invalid_json",
          message: "dropped an SSE frame with invalid JSON",
        }),
      );

      const asked = projected.filter((event) => event.type === "question.asked");
      expect(asked).toHaveLength(2);
      expect(asked.map((event) => (event.request as { key: string; source: string }).key)).toEqual([
        "v1:q1",
        "v2:q2",
      ]);
      expect(asked.map((event) => (event.request as { source: string }).source)).toEqual([
        "v1",
        "v2",
      ]);

      const permission = projected.find((event) => event.type === "permission.asked");
      if (permission === undefined) throw new Error("missing permission event");
      const permissionRequest = permission.request as { source: string; permission: string };
      expect(permissionRequest.source).toBe("v2");
      expect(permissionRequest.permission).toBe("bash");

      expect(projected).toContainEqual(
        expect.objectContaining({
          type: "todo.updated",
          sessionID: "ses_2",
          todos: [{ content: "step", status: "unknown", priority: "unknown" }],
          truncated: false,
        }),
      );
      expect(projected).toContainEqual(
        expect.objectContaining({
          type: "session.activity",
          sessionID: "ses_3",
          cause: "unknown",
        }),
      );
    } finally {
      await stream.close();
    }
  });

  it("sequences every event on one streamID and emits compatibility activities", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);

    try {
      const ready = readyOf(await stream.waitFor('"type":"stream.ready"'));
      upstream.send(
        [
          jsonFrame({
            id: "evt_msg",
            type: "message.updated",
            properties: {
              sessionID: "ses_1",
              info: {
                id: "msg_1",
                role: "assistant",
                sessionID: "ses_1",
                parentID: "msg_0",
                finish: "tool-calls",
                time: { created: 1 },
              },
            },
          }),
          jsonFrame({
            id: "evt_part",
            type: "message.part.updated",
            properties: {
              sessionID: "ses_1",
              part: {
                id: "part_1",
                type: "text",
                sessionID: "ses_1",
                messageID: "msg_1",
                text: "hello",
                time: { start: 1 },
              },
            },
          }),
          jsonFrame({
            id: "evt_delta",
            type: "message.part.delta",
            properties: {
              sessionID: "ses_1",
              messageID: "msg_1",
              partID: "part_1",
              field: "text",
              delta: " world",
            },
          }),
          jsonFrame({
            id: "evt_status",
            type: "session.status",
            properties: { sessionID: "ses_1", status: { type: "busy" } },
          }),
        ].join(""),
      );
      await stream.waitFor('"cause":"status"');
      const projected = frames(stream.text());
      const events = projected.filter((event) => event.type !== "stream.ready");
      expect(events.map((event) => event.streamID)).toEqual(events.map(() => ready.streamID));
      expect(events.map((event) => event.seq)).toEqual(
        Array.from({ length: events.length }, (_, index) => index + 1),
      );
      expect(projected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message.updated",
            sessionID: "ses_1",
            messageID: "msg_1",
            role: "assistant",
            parentID: "msg_0",
            finish: "tool-calls",
          }),
          expect.objectContaining({
            type: "session.activity",
            sessionID: "ses_1",
            cause: "message",
          }),
          expect.objectContaining({
            type: "message.part.updated",
            partID: "part_1",
            partType: "text",
          }),
          expect.objectContaining({
            type: "message.part.delta",
            partID: "part_1",
            field: "text",
            delta: " world",
            partType: "text",
          }),
          expect.objectContaining({
            type: "session.status",
            sessionID: "ses_1",
            status: { type: "busy" },
          }),
          expect.objectContaining({
            type: "session.activity",
            sessionID: "ses_1",
            cause: "status",
          }),
        ]),
      );
    } finally {
      await stream.close();
    }
  });

  it("caps a >1 MiB running bash snapshot instead of dropping it", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);

    try {
      await stream.waitFor('"type":"stream.ready"');
      const output = `HEAD${"x".repeat(1_500_000)}TAIL`;
      upstream.send(
        jsonFrame({
          id: "evt_big_bash",
          type: "message.part.updated",
          properties: {
            sessionID: "ses_1",
            part: {
              id: "part_bash",
              type: "tool",
              sessionID: "ses_1",
              messageID: "msg_1",
              callID: "call_1",
              tool: "bash",
              state: {
                status: "running",
                input: { command: "bash long" },
                time: { start: 1 },
                metadata: { output },
              },
            },
          },
        }) +
          jsonFrame({
            id: "evt_after_bash",
            type: "session.status",
            properties: { sessionID: "ses_after_bash" },
          }),
      );

      await stream.waitFor('"ses_after_bash"', 10_000);
      const event = frames(stream.text()).find((frame) => frame.type === "message.part.updated");
      if (event === undefined) throw new Error("missing part event");
      const part = event.part as Record<string, unknown>;
      const state = part.state as Record<string, unknown>;
      const metadata = state.metadata as Record<string, unknown>;
      const kept = metadata.output as string;
      expect(Buffer.byteLength(kept, "utf8")).toBe(64 * 1024);
      expect(kept.endsWith("TAIL")).toBe(true);
      expect((event.truncated as { fields: string[] }).fields).toContain("state.metadata.output");
    } finally {
      await stream.close();
    }
  });

  it("salvages identity from a >8 MiB frame and emits message.part.omitted", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);

    try {
      await stream.waitFor('"type":"stream.ready"');
      upstream.send(
        jsonFrame({
          id: "evt_huge",
          type: "message.part.updated",
          properties: {
            sessionID: "ses_big",
            part: {
              id: "part_big",
              type: "tool",
              sessionID: "ses_big",
              messageID: "msg_big",
              tool: "bash",
              state: {
                status: "running",
                metadata: { output: "x".repeat(9 * 1024 * 1024) },
              },
            },
          },
        }),
      );

      await stream.waitFor('"type":"message.part.omitted"', 10_000);
      const projected = frames(stream.text());
      expect(projected).toContainEqual(
        expect.objectContaining({
          type: "message.part.omitted",
          sessionID: "ses_big",
          messageID: "msg_big",
          partID: "part_big",
          reason: "too_large",
        }),
      );
      expect(
        projected.some(
          (event) => event.type === "stream.warning" && event.code === "frame_too_large",
        ),
      ).toBe(false);
    } finally {
      await stream.close();
    }
  });

  it("warns with the salvaged session id when a >8 MiB frame is not a part", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);

    try {
      await stream.waitFor('"type":"stream.ready"');
      upstream.send(
        jsonFrame({
          type: "unknown",
          properties: { sessionID: "ses_only", padding: "x".repeat(9 * 1024 * 1024) },
        }),
      );

      await stream.waitFor('"code":"frame_too_large"', 10_000);
      const warnings = frames(stream.text()).filter((event) => event.type === "stream.warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual(
        expect.objectContaining({
          type: "stream.warning",
          code: "frame_too_large",
          sessionID: "ses_only",
        }),
      );
    } finally {
      await stream.close();
    }
  });

  it("applies prompt and todo budgets to typed frames", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);

    try {
      await stream.waitFor('"type":"stream.ready"');
      upstream.send(
        [
          jsonFrame({
            id: "evt_big_question",
            type: "question.asked",
            properties: {
              id: "que_big",
              sessionID: "ses_1",
              tool: { messageID: "msg_1", callID: "call_1" },
              questions: [{ header: "HUGE", question: "q".repeat(270 * 1024), options: [] }],
            },
          }),
          jsonFrame({
            id: "evt_big_permission",
            type: "permission.asked",
            properties: {
              id: "per_big",
              sessionID: "ses_1",
              permission: "bash",
              patterns: ["p".repeat(270 * 1024)],
              always: [],
              metadata: {},
            },
          }),
          jsonFrame({
            id: "evt_big_todos",
            type: "todo.updated",
            properties: {
              sessionID: "ses_1",
              todos: Array.from({ length: 200 }, (_, index) => ({
                content: `${index}:${"x".repeat(7_000)}`,
                status: "pending",
                priority: "low",
              })),
            },
          }),
          jsonFrame({
            id: "evt_after_budget",
            type: "session.status",
            properties: { sessionID: "ses_after_budget" },
          }),
        ].join(""),
      );

      await stream.waitFor('"ses_after_budget"', 10_000);
      const projected = frames(stream.text());
      const question = projected.find((event) => event.type === "question.asked");
      if (question === undefined) throw new Error("missing question event");
      const questionRequest = question.request as {
        tooLarge: boolean;
        questions: unknown[];
        summary?: string;
        tooLargeReason?: string;
      };
      expect(questionRequest.tooLarge).toBe(true);
      expect(questionRequest.questions).toEqual([]);
      expect(questionRequest.summary?.startsWith("HUGE")).toBe(true);
      expect((questionRequest.summary ?? "").length).toBeLessThanOrEqual(500);
      expect((questionRequest.tooLargeReason ?? "").length).toBeLessThanOrEqual(200);

      const permission = projected.find((event) => event.type === "permission.asked");
      if (permission === undefined) throw new Error("missing permission event");
      const permissionRequest = permission.request as {
        tooLarge: boolean;
        patterns: string[];
        always: string[];
        metadata: Record<string, unknown>;
        summary?: string;
      };
      expect(permissionRequest.tooLarge).toBe(true);
      expect(permissionRequest.patterns).toEqual([]);
      expect(permissionRequest.always).toEqual([]);
      expect(permissionRequest.metadata).toEqual({});
      expect(permissionRequest.summary?.startsWith("bash")).toBe(true);

      const todo = projected.find((event) => event.type === "todo.updated");
      if (todo === undefined) throw new Error("missing todo event");
      expect(todo.truncated).toBe(true);
      expect((todo.todos as unknown[]).length).toBeLessThan(200);

      for (const event of [question, permission, todo]) {
        expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(
          MAX_TYPED_EVENT_BYTES,
        );
      }
    } finally {
      await stream.close();
    }
  });

  it("emits heartbeats while the upstream is idle", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const previous = process.env.HANSE_EVENT_HEARTBEAT_MS;
    process.env.HANSE_EVENT_HEARTBEAT_MS = "20";
    try {
      const response = await fetch(`${f.base}/api/apps/storefront/events`, {
        headers: auth(f.token),
      });
      const stream = probe(response);
      try {
        const text = await stream.waitFor(": ping\n\n");
        expect(text).toContain(": ping\n\n");
        // Heartbeats are comments, so they never enter a parsed data frame.
        expect(frames(text).every((event) => typeof event.seq === "number")).toBe(true);
      } finally {
        await stream.close();
      }
    } finally {
      if (previous === undefined) delete process.env.HANSE_EVENT_HEARTBEAT_MS;
      else process.env.HANSE_EVENT_HEARTBEAT_MS = previous;
    }
  });

  it("sends the registered Basic authorization to the /event stream", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    setEndpointAuthorization(upstream.endpoint, "opencode", "hunter2");
    useUpstream(f.deps, upstream.endpoint);

    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);
    try {
      await stream.waitFor('"stream.ready"');
      expect(upstream.authorizations[0]).toBe(
        `Basic ${Buffer.from("opencode:hunter2", "utf8").toString("base64")}`,
      );
    } finally {
      await stream.close();
    }
  });

  it("aborts the upstream when the response closes", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const controller = new AbortController();
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
      signal: controller.signal,
    });
    const stream = probe(response);
    await stream.waitFor('"stream.ready"');
    controller.abort();
    await waitUntil(() => upstream.closed());
    expect(upstream.requests).toEqual(["/event"]);
  });

  it("returns 502 when the upstream fails before headers", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream(500);
    useUpstream(f.deps, upstream.endpoint);

    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("500");
  });

  it("returns 502 when the runtime fails to start", async () => {
    const f = await fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new Error("did not start");
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("did not start");
  });

  it("forwards session.compacted without changing existing frames", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);

    try {
      const ready = readyOf(await stream.waitFor('"type":"stream.ready"'));
      upstream.send(
        jsonFrame({
          id: "evt_compacted",
          type: "session.compacted",
          properties: { sessionID: "ses_1" },
        }),
      );
      await stream.waitFor('"type":"session.compacted"');
      const projected = frames(stream.text());
      expect(projected).toEqual([
        ready,
        {
          type: "session.compacted",
          sessionID: "ses_1",
          streamID: ready.streamID,
          seq: 1,
        },
        {
          type: "session.activity",
          sessionID: "ses_1",
          cause: "status",
          streamID: ready.streamID,
          seq: 2,
        },
      ]);
    } finally {
      await stream.close();
    }
  });
});
