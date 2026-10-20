import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAgentRuntimeClient, RuntimeClientError } from "../src/agent/client.js";
import type { AppRuntimeSpec } from "../src/agent/spec.js";

const TOKEN = "runtime-token-for-tests";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

interface Recorded {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

interface Fixture {
  client: HttpAgentRuntimeClient;
  records: Recorded[];
  calls: IncomingMessage[];
}

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<Fixture> {
  const records: Recorded[] = [];
  const calls: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url ?? "/", "http://localhost");
      records.push({
        method: request.method ?? "",
        path: decodeURIComponent(url.pathname),
        authorization: request.headers.authorization,
        body,
      });
      calls.push(request);
      handler(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    client: new HttpAgentRuntimeClient({
      baseUrl: `http://127.0.0.1:${address.port}/`,
      token: TOKEN,
      timeoutMs: 2_000,
    }),
    records,
    calls,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const spec = {
  appId: "p:web",
  image: "agent-default",
  pathMode: "container",
  appDir: "/data/workspace/p/web",
  stateDir: "/data/agents/p/web/state",
  networkName: "agents",
  env: {},
  resources: { memoryBytes: 1024, nanoCpus: 1, pidsLimit: 10 },
  labels: { "hanse.managed": "true" },
  specHash: "a".repeat(64),
} satisfies AppRuntimeSpec;

const status = {
  appId: "p:web",
  endpoint: "http://agents:4100",
  state: "running" as const,
  specHash: spec.specHash,
  version: { hanseVersion: "0.1.0", opencodeVersion: "1.0.0", specHash: spec.specHash },
};

describe("HttpAgentRuntimeClient", () => {
  it("maps ensure, status, logs, delete, and reconcile to the supervisor API", async () => {
    const f = await fixture((request, response, body) => {
      if (request.method === "POST" && request.url === "/v1/apps/p%3Aweb/ensure") {
        expect(JSON.parse(body)).toEqual(spec);
        json(response, 200, status);
        return;
      }
      if (request.method === "GET" && request.url === "/v1/apps/p%3Aweb") {
        json(response, 200, status);
        return;
      }
      if (request.method === "GET" && request.url === "/v1/apps/p%3Aweb/logs") {
        json(response, 200, { appId: "p:web", logs: "hello", truncated: false });
        return;
      }
      if (request.method === "DELETE" && request.url === "/v1/apps/p%3Aweb") {
        json(response, 200, { ...status, state: "stopped", endpoint: null });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/reconcile") {
        expect(JSON.parse(body)).toEqual({ appIds: ["p:web"] });
        json(response, 200, { stopped: [], apps: [status] });
        return;
      }
      json(response, 404, { error: "not found" });
    });

    await expect(f.client.ensure(spec)).resolves.toEqual(status);
    await expect(f.client.status("p:web")).resolves.toEqual(status);
    await expect(f.client.logs("p:web")).resolves.toEqual({
      appId: "p:web",
      logs: "hello",
      truncated: false,
    });
    await expect(f.client.delete("p:web")).resolves.toMatchObject({ state: "stopped" });
    await expect(f.client.reconcile(["p:web"])).resolves.toEqual({
      stopped: [],
      apps: [status],
    });

    expect(f.records.map((record) => `${record.method} ${record.path}`)).toEqual([
      "POST /v1/apps/p:web/ensure",
      "GET /v1/apps/p:web",
      "GET /v1/apps/p:web/logs",
      "DELETE /v1/apps/p:web",
      "POST /v1/reconcile",
    ]);
    expect(f.records.every((record) => record.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("maps a 404 on status and logs to undefined", async () => {
    const f = await fixture((_request, response) => {
      json(response, 404, { error: "unknown app" });
    });

    await expect(f.client.status("missing")).resolves.toBeUndefined();
    await expect(f.client.logs("missing")).resolves.toBeUndefined();
  });

  it("throws a typed error for a JSON supervisor failure", async () => {
    const f = await fixture((_request, response) => {
      json(response, 401, { error: "unauthorized", code: "unauthorized" });
    });

    await expect(f.client.status("p:web")).rejects.toMatchObject({
      name: "RuntimeClientError",
      status: 401,
      code: "unauthorized",
    });
    await expect(f.client.ensure(spec)).rejects.toBeInstanceOf(RuntimeClientError);
  });

  it("maps a transport failure to status 0", async () => {
    const client = new HttpAgentRuntimeClient({
      baseUrl: "http://127.0.0.1:1",
      token: TOKEN,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    await expect(client.status("p:web")).rejects.toMatchObject({
      name: "RuntimeClientError",
      status: 0,
    });
  });

  it("requires a base URL and a runtime token", () => {
    expect(() => new HttpAgentRuntimeClient({ baseUrl: "  ", token: TOKEN })).toThrow(/base URL/);
    expect(
      () => new HttpAgentRuntimeClient({ baseUrl: "http://127.0.0.1:8789", token: "" }),
    ).toThrow(/HANSE_RUNTIME_TOKEN/);
  });
});
