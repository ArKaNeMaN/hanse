import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpAgentRuntimeClient } from "../src/agent/client.js";
import { DockerClient, type DockerResponse, type DockerTransport } from "../src/runner/docker.js";
import { RunnerService } from "../src/runner/server.js";
import { loadRunnerConfig } from "../src/runner/validate.js";
import { isRunnerCompatible, RUNNER_API_VERSION } from "../src/shared/runner-api.js";
import { VERSION } from "../src/version.js";

function client(meta: Record<string, unknown>): HttpAgentRuntimeClient {
  return new HttpAgentRuntimeClient({
    baseUrl: "http://runner:8790",
    token: "runtime-token",
    fetchImpl: (async () =>
      new Response(JSON.stringify(meta), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
}

describe("runner API handshake", () => {
  it("reads the compatibility window from /v1/meta", async () => {
    const handshake = await client({
      apiVersion: RUNNER_API_VERSION,
      minApiVersion: 3,
      nameVersion: 2,
      recordVersion: 1,
      runnerVersion: "0.1.0",
    }).handshake();
    expect(handshake).toEqual({
      apiVersion: 3,
      minApiVersion: 3,
      maxApiVersion: 3,
      hanseVersion: "0.1.0",
    });
    expect(isRunnerCompatible(handshake)).toBe(true);
  });

  it("degrades a runner without a version field instead of failing", async () => {
    const handshake = await client({ status: "ok" }).handshake();
    expect(handshake).toMatchObject({ apiVersion: 0, minApiVersion: 0, maxApiVersion: 0 });
    expect(isRunnerCompatible(handshake)).toBe(false);
  });

  it("refuses a runner whose /v1/meta endpoint is missing", async () => {
    const legacy = new HttpAgentRuntimeClient({
      baseUrl: "http://runner:8790",
      token: "runtime-token",
      fetchImpl: (async () => new Response("not found", { status: 404 })) as typeof fetch,
    });
    const handshake = await legacy.handshake();
    expect(handshake).toMatchObject({ apiVersion: 0, minApiVersion: 0, maxApiVersion: 0 });
    expect(isRunnerCompatible(handshake)).toBe(false);
  });

  it("rejects a runner that is outside the coordinator API window", async () => {
    const handshake = await client({
      apiVersion: 4,
      minApiVersion: 4,
      nameVersion: 2,
      recordVersion: 1,
      runnerVersion: "0.3.0",
    }).handshake();
    expect(isRunnerCompatible(handshake)).toBe(false);
  });

  it("returns undefined when the runner is unreachable", async () => {
    const unreachable = new HttpAgentRuntimeClient({
      baseUrl: "http://runner:8790",
      token: "runtime-token",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    });
    await expect(unreachable.handshake()).resolves.toBeUndefined();
  });

  it("serves authenticated /v1/meta and a constant /healthz", async () => {
    const transport: DockerTransport = {
      async request(method: "GET" | "POST" | "DELETE", requestPath: string) {
        if (method === "GET" && requestPath.startsWith("/containers/json?")) {
          return json(200, []);
        }
        if (method === "GET" && requestPath === "/_ping") {
          return { status: 200, body: Buffer.from("OK", "utf8") };
        }
        return json(404, { message: "unexpected" });
      },
    };
    const config = loadRunnerConfig({
      HANSE_RUNTIME_TOKEN: "runtime-token",
      HANSE_HOST_WORKSPACE: path.join(tmpdir(), "hanse-meta-workspace"),
      HANSE_HOST_AGENTS: path.join(tmpdir(), "hanse-meta-agents"),
      HANSE_AGENT_IMAGE: "agent-default:test",
    });
    const service = new RunnerService({ config, docker: new DockerClient(transport) });
    const server = service.createServer();
    try {
      const base = await listen(server);
      const unauthorized = await fetch(`${base}/v1/meta`);
      expect(unauthorized.status).toBe(401);

      const meta = await fetch(`${base}/v1/meta`, {
        headers: { authorization: "Bearer runtime-token" },
      });
      expect(meta.status).toBe(200);
      expect(await meta.json()).toEqual({
        apiVersion: 3,
        minApiVersion: 3,
        nameVersion: 2,
        recordVersion: 1,
        runnerVersion: VERSION,
      });

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const unauthorizedReady = await fetch(`${base}/readyz`);
      expect(unauthorizedReady.status).toBe(401);

      const ready = await fetch(`${base}/readyz`, {
        headers: { authorization: "Bearer runtime-token" },
      });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ok" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function json(status: number, body: unknown): DockerResponse {
  return { status, body: Buffer.from(JSON.stringify(body), "utf8") };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}
