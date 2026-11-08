import { describe, expect, it } from "vitest";
import { HttpAgentRuntimeClient } from "../src/agent/client.js";
import { isRunnerCompatible, RUNNER_API_VERSION } from "../src/shared/runner-api.js";

function client(health: Record<string, unknown>): HttpAgentRuntimeClient {
  return new HttpAgentRuntimeClient({
    baseUrl: "http://runner:8790",
    token: "runtime-token",
    fetchImpl: (async () =>
      new Response(JSON.stringify(health), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
}

describe("runner API handshake", () => {
  it("reads the compatibility window from /healthz", async () => {
    const handshake = await client({
      ok: true,
      hanseVersion: "0.1.0",
      apiVersion: RUNNER_API_VERSION,
      minApiVersion: 1,
      maxApiVersion: 1,
    }).handshake();
    expect(handshake).toEqual({
      apiVersion: 1,
      minApiVersion: 1,
      maxApiVersion: 1,
      hanseVersion: "0.1.0",
    });
    expect(isRunnerCompatible(handshake)).toBe(true);
  });

  it("degrades a legacy runner without a version field instead of failing", async () => {
    const handshake = await client({ ok: true, hanseVersion: "0.1.0" }).handshake();
    expect(handshake).toMatchObject({ apiVersion: 0, minApiVersion: 0, maxApiVersion: 0 });
    expect(isRunnerCompatible(handshake)).toBe(false);
  });

  it("rejects a runner that is outside the coordinator API window", async () => {
    const handshake = await client({
      ok: true,
      apiVersion: 2,
      minApiVersion: 2,
      maxApiVersion: 2,
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
});
