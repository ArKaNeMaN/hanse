import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DockerClient } from "../src/runner/docker.js";
import { RunnerService } from "../src/runner/server.js";
import { loadRunnerConfig } from "../src/runner/validate.js";

const enabled = process.env.HANSE_TEST_DOCKER === "1";
const roots = enabled
  ? [
      mkdtempSync(path.join(tmpdir(), "hanse-docker-workspace-")),
      mkdtempSync(path.join(tmpdir(), "hanse-docker-agents-")),
      mkdtempSync(path.join(tmpdir(), "hanse-docker-tmp-")),
    ]
  : [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!enabled)("runner Docker integration", () => {
  it("pings the engine and serves liveness/readiness over HTTP", async () => {
    const socketPath = process.env.HANSE_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock";
    const docker = DockerClient.unixSocket(socketPath);
    await expect(docker.ping()).resolves.toBeUndefined();

    const config = loadRunnerConfig({
      HANSE_RUNTIME_TOKEN: "integration-token",
      HANSE_HOST_WORKSPACE: roots[0] as string,
      HANSE_HOST_AGENTS: roots[1] as string,
      HANSE_HOST_RUNNER_TMP: roots[2] as string,
      HANSE_AGENT_IMAGE: "agent-default:integration",
    });
    const service = new RunnerService({ config, docker });
    const server = service.createServer();
    try {
      const base = await listen(server);
      await expect(fetch(`${base}/healthz`).then((response) => response.json())).resolves.toEqual({
        status: "ok",
      });

      const unauthorized = await fetch(`${base}/readyz`);
      expect(unauthorized.status).toBe(401);

      const ready = await fetch(`${base}/readyz`, {
        headers: { authorization: "Bearer integration-token" },
      });
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toEqual({ status: "ok" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}
