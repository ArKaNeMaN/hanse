import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCRIPTED_FRAMES,
  type OpencodeUpstream,
  startOpencodeUpstream,
} from "../e2e/support/opencode-upstream.js";
import { E2E_CHAT_MESSAGES, E2E_CHAT_SESSION_ID, E2E_CHAT_SESSIONS } from "../e2e/support/seed.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { requestUpgrade, WsClient } from "./ws-client.js";

const servers: Server[] = [];
const databases: SqliteDatabase[] = [];
const dirs: string[] = [];
const upstreams: OpencodeUpstream[] = [];
const clients: WsClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const upstream of upstreams.splice(0)) await upstream.stop();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
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

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
  agentToken: string;
  port: number;
  upstream: OpencodeUpstream;
}

function addProject(db: SqliteDatabase, id: string, appKey: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?,?,'main',?,?,?)",
  ).run(id, "Fixture", `/tmp/${id}`, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?,?,?,?, 'AGENTS.md', ?)",
  ).run(`${id}:${appKey}`, id, appKey, `apps/${appKey}`, now);
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-e2e-upstream-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  addProject(db, "p", "a");
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "fixture-agent" }).token;
  const upstream = await startOpencodeUpstream({
    appId: "p:a",
    sessions: E2E_CHAT_SESSIONS,
    messages: E2E_CHAT_MESSAGES,
  });
  upstreams.push(upstream);
  const deps: HttpDeps = {
    db,
    workspaceRoot: dir,
    git: new GitService({ workspaceRoot: dir }),
    getProjects: () => [
      {
        id: "p",
        name: "Fixture",
        rootPath: path.join(dir, "p"),
        workspaceRoot: dir,
        service: new CoordinatorService(db, "p"),
      },
    ],
    manager: {
      ensure: async () => upstream.url,
      endpointFor: () => upstream.url,
      policyWarnings: () => [],
    } as unknown as InstanceManager,
    runner: { url: upstream.runnerUrl, token: upstream.token },
  };
  const server = createHttpServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { db, deps, token, agentToken, port: address.port, upstream };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
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
          timer = setTimeout(() => reject(new Error("timed out reading stream")), remaining);
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("deterministic opencode upstream", () => {
  it("ships a scripted frame for every Stage 0 event family", () => {
    const types = new Set(DEFAULT_SCRIPTED_FRAMES.map((frame) => frame.type));
    for (const type of [
      "stream.ready",
      "message.part.delta",
      "message.part.updated",
      "session.status",
      "question.asked",
      "permission.asked",
      "stream.warning",
      "notice.created",
      "context.updated",
      "message.part.omitted",
    ]) {
      expect(types.has(type)).toBe(true);
    }
  });

  it("drives the real coordinator SSE stream with ready, sequenced deltas, warnings, heartbeats, and close", async () => {
    const f = await fixture();
    const previousHeartbeat = process.env.HANSE_EVENT_HEARTBEAT_MS;
    process.env.HANSE_EVENT_HEARTBEAT_MS = "15";
    const response = await fetch(`http://127.0.0.1:${f.port}/api/apps/a/events?project=p`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const stream = probe(response);
    try {
      await f.upstream.waitForStream();
      const readyText = await stream.waitFor('"type":"stream.ready"');
      const ready = frames(readyText).find((event) => event.type === "stream.ready");
      expect(ready?.seq).toBe(0);
      expect(typeof ready?.streamID).toBe("string");
      expect(String(ready?.streamID ?? "").length).toBeGreaterThan(0);

      f.upstream.send([
        {
          type: "message.part.delta",
          properties: {
            sessionID: E2E_CHAT_SESSION_ID,
            messageID: "msg_e2e_assistant",
            partID: "prt_e2e_assistant_text",
            field: "text",
            delta: "Synthetic delta.",
          },
        },
      ]);
      const deltaText = await stream.waitFor('"type":"message.part.delta"');
      const delta = frames(deltaText).find((event) => event.type === "message.part.delta");
      expect(delta).toMatchObject({
        sessionID: E2E_CHAT_SESSION_ID,
        partID: "prt_e2e_assistant_text",
        delta: "Synthetic delta.",
        seq: 1,
        streamID: ready?.streamID,
      });

      f.upstream.send([
        {
          type: "session.status",
          properties: {
            sessionID: E2E_CHAT_SESSION_ID,
            status: { type: "busy" },
          },
        },
      ]);
      const statusText = await stream.waitFor('"type":"session.status"');
      expect(frames(statusText).find((event) => event.type === "session.status")).toMatchObject({
        sessionID: E2E_CHAT_SESSION_ID,
        status: { type: "busy" },
      });

      f.upstream.sendRaw("data: not-json\n\n");
      const warningText = await stream.waitFor('"type":"stream.warning"');
      expect(frames(warningText).find((event) => event.type === "stream.warning")).toMatchObject({
        code: "invalid_json",
      });

      const heartbeatText = await stream.waitFor(": ping");
      expect(heartbeatText).toContain(": ping");

      const sequence = frames(stream.text())
        .map((event) => event.seq)
        .filter((seq): seq is number => typeof seq === "number");
      expect(sequence).toEqual([...sequence].sort((left, right) => left - right));
      expect(new Set(sequence).size).toBe(sequence.length);

      f.upstream.closeStreams();
      await stream.close();
    } finally {
      if (previousHeartbeat === undefined) delete process.env.HANSE_EVENT_HEARTBEAT_MS;
      else process.env.HANSE_EVENT_HEARTBEAT_MS = previousHeartbeat;
    }
  });

  it("proxies the real terminal WebSocket with cookie auth, binary echo, resize, and exit codes", async () => {
    const f = await fixture();
    const wsPath = "/api/apps/a/terminal?project=p";
    const anonymous = await requestUpgrade({ port: f.port, path: wsPath });
    expect(anonymous.status).toBe(401);

    const invalid = await requestUpgrade({
      port: f.port,
      path: wsPath,
      headers: { cookie: "hanse_token=not-a-fixture-token" },
    });
    expect(invalid.status).toBe(403);

    const client = await WsClient.connect({
      port: f.port,
      path: wsPath,
      headers: { cookie: `hanse_token=${f.token}` },
    });
    clients.push(client);
    await f.upstream.waitForRunner();
    expect(f.upstream.runner.authorizations).toContain(`Bearer ${f.upstream.token}`);

    client.send(Buffer.from([0, 1, 2, 255]), "binary");
    const binary = await client.nextMessage();
    expect(binary.opcode).toBe(0x2);
    expect([...binary.payload]).toEqual([0, 1, 2, 255]);

    client.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await waitUntil(() => f.upstream.runner.resizes.length === 1);
    expect(f.upstream.runner.resizes[0]).toEqual({ cols: 120, rows: 40 });

    f.upstream.closeRunner(1000);
    const normal = await client.nextMessage();
    expect(normal.opcode).toBe(0x8);
    expect(normal.payload.readUInt16BE(0)).toBe(1000);

    const failureClient = await WsClient.connect({
      port: f.port,
      path: wsPath,
      headers: { cookie: `hanse_token=${f.token}` },
    });
    clients.push(failureClient);
    await waitUntil(() => f.upstream.runner.connections >= 2);
    f.upstream.closeRunner(1011);
    const failure = await failureClient.nextMessage();
    expect(failure.opcode).toBe(0x8);
    expect(failure.payload.readUInt16BE(0)).toBe(1011);

    const goingAwayClient = await WsClient.connect({
      port: f.port,
      path: wsPath,
      headers: { cookie: `hanse_token=${f.token}` },
    });
    clients.push(goingAwayClient);
    await waitUntil(() => f.upstream.runner.connections >= 3);
    f.upstream.closeRunner(1001);
    const goingAway = await goingAwayClient.nextMessage();
    expect(goingAway.opcode).toBe(0x8);
    expect(goingAway.payload.readUInt16BE(0)).toBe(1001);
  }, 15_000);
});
