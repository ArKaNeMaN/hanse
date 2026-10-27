import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateAppRuntimeSpec } from "../src/agent/spec.js";
import { AgentSupervisor, type AgentSupervisorOptions } from "../src/agent/supervisor.js";

const TOKEN = "runtime-token-for-tests";
const hostFixturePath = fileURLToPath(new URL("./fixtures/fake-agent-host.mjs", import.meta.url));
const dirs: string[] = [];
const supervisors: AgentSupervisor[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.close().catch(() => undefined);
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  base: string;
  workspace: string;
  agents: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-agent-supervisor-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const agents = path.join(base, "agents");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agents, { recursive: true });
  return { base, workspace, agents };
}

function specFor(
  f: Fixture,
  appKey: string,
  env: Record<string, string> = {},
): ReturnType<typeof validateAppRuntimeSpec> {
  const appDir = path.join(f.workspace, "p", appKey);
  const appRoot = path.join(f.agents, "p", appKey);
  const stateDir = path.join(appRoot, "state");
  const home = path.join(appRoot, "home");
  for (const dir of [appDir, stateDir, home]) {
    mkdirSync(dir, { recursive: true });
  }
  const raw = {
    appId: `p:${appKey}`,
    image: "hanse-agent-default:test",
    pathMode: "container",
    appDir,
    stateDir,
    networkName: "agents",
    env: {
      HOME: home,
      XDG_DATA_HOME: path.join(appRoot, "data"),
      XDG_STATE_HOME: stateDir,
      XDG_CONFIG_HOME: path.join(appRoot, "config"),
      XDG_CACHE_HOME: path.join(appRoot, "cache"),
      OPENCODE_DB: path.join(stateDir, "opencode.db"),
      TMPDIR: path.join(appRoot, "tmp"),
      MISE_DATA_DIR: path.join(appRoot, "mise"),
      OPENCODE_CONFIG_CONTENT: '{"model":"deepseek/deepseek-flash"}',
      GIT_CEILING_DIRECTORIES: f.workspace,
      FAKE_HOST_RECORD: path.join(f.base, `${appKey}-record.json`),
      FAKE_HOST_STARTS: path.join(f.base, `${appKey}-starts`),
      FAKE_HOST_SIGNALS: path.join(f.base, `${appKey}-signals`),
      ...env,
    },
    resources: { memoryBytes: 2048, nanoCpus: 2, pidsLimit: 512 },
    labels: { "hanse.managed": "true", "hanse.app.id": `p:${appKey}` },
  };
  return validateAppRuntimeSpec(raw, {
    workspaceRoot: f.workspace,
    agentsRoot: f.agents,
  });
}

interface Harness {
  fixture: Fixture;
  supervisor: AgentSupervisor;
  baseUrl: string;
  portBase: number;
}

async function harness(overrides: Partial<AgentSupervisorOptions> = {}): Promise<Harness> {
  const f = fixture();
  const portBase = 20000 + Math.floor(Math.random() * 20000);
  const supervisor = new AgentSupervisor({
    token: TOKEN,
    workspaceRoot: f.workspace,
    agentsRoot: f.agents,
    agentHostname: "127.0.0.1",
    hostCommand: [process.execPath, hostFixturePath],
    portBase,
    portCount: 50,
    startTimeoutMs: 5000,
    stopTimeoutMs: 1000,
    ...overrides,
  });
  supervisors.push(supervisor);
  const server = supervisor.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  return {
    fixture: f,
    supervisor,
    baseUrl: `http://127.0.0.1:${address.port}`,
    portBase,
  };
}

interface ApiResult {
  status: number;
  body: unknown;
  text: string;
}

async function api(
  harness: Harness,
  method: string,
  pathname: string,
  options: { token?: string | null; body?: unknown; rawBody?: string } = {},
): Promise<ApiResult> {
  const token = options.token === undefined ? TOKEN : options.token;
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    method,
    headers,
    body:
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

async function waitFor(read: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (read()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function lineCount(file: string): number {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe("agent supervisor HTTP contract", () => {
  it("serves unauthenticated health and rejects missing/invalid bearer tokens", async () => {
    const h = await harness();
    const health = await api(h, "GET", "/healthz", { token: null });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, apps: 0 });
    expect((health.body as { hanseVersion: string }).hanseVersion.length).toBeGreaterThan(0);

    for (const token of [null, "wrong-token"]) {
      const status = await api(h, "GET", "/v1/apps/p:a", { token });
      expect(status.status).toBe(401);
      const ensure = await api(h, "POST", "/v1/apps/p:a/ensure", {
        token,
        body: specFor(h.fixture, "a"),
      });
      expect(ensure.status).toBe(401);
    }
    expect(existsSync(path.join(h.fixture.base, "a-starts"))).toBe(false);
  });

  it("ensures a host, returns the effective status, exposes logs, and keeps secrets out", async () => {
    const h = await harness();
    const spec = specFor(h.fixture, "a");
    const ensured = await api(h, "POST", "/v1/apps/p:a/ensure", { body: spec });
    expect(ensured.status).toBe(200);
    const status = ensured.body as {
      appId: string;
      endpoint: string;
      state: string;
      specHash: string;
      imageId: string | null;
      startedAt: string | null;
      restartCount: number;
      exitCode: number | null;
      oomKilled: boolean;
      finishedAt: string | null;
      version: { hanseVersion: string; opencodeVersion: string | null; specHash: string };
    };
    expect(status.appId).toBe("p:a");
    expect(status.state).toBe("running");
    expect(status.specHash).toBe(spec.specHash);
    expect(status.imageId).toBeNull();
    expect(status.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(status.restartCount).toBe(0);
    expect(status.exitCode).toBeNull();
    expect(status.oomKilled).toBe(false);
    expect(status.finishedAt).toBeNull();
    expect(status.version.hanseVersion).toBe("fake-hanse");
    expect(status.version.opencodeVersion).toBe("fake-opencode");
    expect(status.version.specHash).toBe(spec.specHash);
    const port = Number(new URL(status.endpoint).port);
    expect(port).toBeGreaterThanOrEqual(h.portBase);
    expect(port).toBeLessThan(h.portBase + 50);
    expect(status.endpoint).toBe(`http://127.0.0.1:${port}`);
    expect(await (await fetch(status.endpoint)).text()).toBe("fake-host p:a");

    const got = await api(h, "GET", "/v1/apps/p:a");
    expect(got.status).toBe(200);
    expect(got.body).toEqual(ensured.body);

    const logs = await api(h, "GET", "/v1/apps/p:a/logs");
    expect(logs.status).toBe(200);
    const logBody = logs.body as { appId: string; logs: string; truncated: boolean };
    expect(logBody.appId).toBe("p:a");
    expect(logBody.truncated).toBe(false);
    expect(logBody.logs).toContain("fake-host p:a stdout");
    expect(logBody.logs).toContain("fake-host p:a stderr");
    expect(logBody.logs).toContain("supervisor: p:a running on port");
    expect(logBody.logs).not.toContain(TOKEN);

    const record = JSON.parse(readFileSync(path.join(h.fixture.base, "a-record.json"), "utf8")) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(record.argv).toEqual([
      "--spec",
      path.join(h.fixture.agents, "p", "a", "state", "runtime", "spec.json"),
    ]);
    expect(record.env.HANSE_RUNTIME_TOKEN).toBeUndefined();
    expect(record.env.HANSE_OPERATOR_TOKEN).toBeUndefined();
    expect(record.env.HANSE_DB).toBeUndefined();
    expect(record.env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"deepseek/deepseek-flash"}');
    expect(record.env.HOME).toBe(path.join(h.fixture.agents, "p", "a", "home"));

    const specFile = path.join(h.fixture.agents, "p", "a", "state", "runtime", "spec.json");
    const written = JSON.parse(readFileSync(specFile, "utf8")) as {
      port: number;
      specHash: string;
    };
    expect(written.port).toBe(port);
    expect(written.specHash).toBe(spec.specHash);
    expect(JSON.stringify(written)).not.toContain("/data/state");
  });

  it("is idempotent by specHash and recreates a host when the spec changes", async () => {
    const h = await harness();
    const spec = specFor(h.fixture, "a");
    const first = await api(h, "POST", "/v1/apps/p:a/ensure", { body: spec });
    const second = await api(h, "POST", "/v1/apps/p:a/ensure", { body: spec });
    expect(second.status).toBe(200);
    expect((second.body as { endpoint: string }).endpoint).toBe(
      (first.body as { endpoint: string }).endpoint,
    );
    const startsFile = path.join(h.fixture.base, "a-starts");
    expect(lineCount(startsFile)).toBe(1);
    const idempotentLogs = await api(h, "GET", "/v1/apps/p:a/logs");
    expect((idempotentLogs.body as { logs: string }).logs).toContain(
      "supervisor: ensure p:a is already running",
    );

    const changed = specFor(h.fixture, "a", {
      OPENCODE_CONFIG_CONTENT: '{"model":"other/model"}',
    });
    expect(changed.specHash).not.toBe(spec.specHash);
    const recreated = await api(h, "POST", "/v1/apps/p:a/ensure", { body: changed });
    expect(recreated.status).toBe(200);
    const recreatedBody = recreated.body as { endpoint: string; specHash: string };
    expect(recreatedBody.specHash).toBe(changed.specHash);
    expect(recreatedBody.endpoint).not.toBe((first.body as { endpoint: string }).endpoint);
    expect(lineCount(startsFile)).toBe(2);
    await waitFor(() => lineCount(path.join(h.fixture.base, "a-signals")) >= 1);
  });

  it("assigns a unique port per app when the spec omits one", async () => {
    const h = await harness();
    const a = await api(h, "POST", "/v1/apps/p:a/ensure", { body: specFor(h.fixture, "a") });
    const b = await api(h, "POST", "/v1/apps/p:b/ensure", { body: specFor(h.fixture, "b") });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const aPort = new URL((a.body as { endpoint: string }).endpoint).port;
    const bPort = new URL((b.body as { endpoint: string }).endpoint).port;
    expect(aPort).not.toBe(bPort);
  });

  it("deletes only one host and reconciles unknown hosts", async () => {
    const h = await harness();
    const a = await api(h, "POST", "/v1/apps/p:a/ensure", { body: specFor(h.fixture, "a") });
    const b = await api(h, "POST", "/v1/apps/p:b/ensure", { body: specFor(h.fixture, "b") });
    const aEndpoint = (a.body as { endpoint: string }).endpoint;
    const bEndpoint = (b.body as { endpoint: string }).endpoint;

    const deleted = await api(h, "DELETE", "/v1/apps/p:a");
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ appId: "p:a", state: "stopped", endpoint: null });
    expect((await api(h, "GET", "/v1/apps/p:a")).status).toBe(404);
    await expect(fetch(aEndpoint)).rejects.toThrow();
    expect((await api(h, "GET", "/v1/apps/p:b")).status).toBe(200);
    expect(await (await fetch(bEndpoint)).text()).toBe("fake-host p:b");
    expect(existsSync(path.join(h.fixture.agents, "p", "a", "state", "runtime", "spec.json"))).toBe(
      true,
    );

    await api(h, "POST", "/v1/apps/p:a/ensure", { body: specFor(h.fixture, "a") });
    const reconciled = await api(h, "POST", "/v1/reconcile", { body: { appIds: ["p:b"] } });
    expect(reconciled.status).toBe(200);
    expect((reconciled.body as { stopped: string[] }).stopped).toEqual(["p:a"]);
    expect((await api(h, "GET", "/v1/apps/p:a")).status).toBe(404);
    expect((await api(h, "GET", "/v1/apps/p:b")).status).toBe(200);
  });

  it("rejects invalid specs, appId overrides, oversized bodies, and wrong methods", async () => {
    const h = await harness();
    const mismatched = await api(h, "POST", "/v1/apps/p:a/ensure", {
      body: specFor(h.fixture, "b"),
    });
    expect(mismatched.status).toBe(400);

    const traversal = {
      ...specFor(h.fixture, "a"),
      appDir: path.join(h.fixture.workspace, "p", "..", "..", "etc"),
    };
    const badPath = await api(h, "POST", "/v1/apps/p:a/ensure", { body: traversal });
    expect(badPath.status).toBe(400);

    const forbiddenEnv = {
      ...specFor(h.fixture, "a"),
      env: {
        ...(specFor(h.fixture, "a").env as Record<string, string>),
        HANSE_RUNTIME_TOKEN: TOKEN,
      },
    };
    const badEnv = await api(h, "POST", "/v1/apps/p:a/ensure", { body: forbiddenEnv });
    expect(badEnv.status).toBe(400);

    const oversized = await api(h, "POST", "/v1/apps/p:a/ensure", {
      rawBody: "x".repeat(70 * 1024),
    });
    expect(oversized.status).toBe(413);

    const wrongMethod = await api(h, "GET", "/v1/apps/p:a/ensure");
    expect(wrongMethod.status).toBe(405);
    const unknown = await api(h, "GET", "/v1/unknown");
    expect(unknown.status).toBe(404);
    const badAppId = await api(h, "GET", "/v1/apps/a%2Fb");
    expect(badAppId.status).toBe(400);
    const badReconcile = await api(h, "POST", "/v1/reconcile", {
      body: { appIds: "p:a" },
    });
    expect(badReconcile.status).toBe(400);
  });

  it("does not let a query parameter override the path appId", async () => {
    const h = await harness();
    await api(h, "POST", "/v1/apps/p:a/ensure", { body: specFor(h.fixture, "a") });
    const got = await api(h, "GET", "/v1/apps/p:a?appId=p:b");
    expect(got.status).toBe(200);
    expect((got.body as { appId: string }).appId).toBe("p:a");
  });

  it("bounds per-app logs and reports truncation", async () => {
    const h = await harness({ maxLogBytes: 256 });
    const spec = specFor(h.fixture, "a", { FAKE_BIG_LOG: "1" });
    const ensured = await api(h, "POST", "/v1/apps/p:a/ensure", { body: spec });
    expect(ensured.status).toBe(200);
    const logs = await api(h, "GET", "/v1/apps/p:a/logs");
    const body = logs.body as { logs: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.logs.length).toBeLessThanOrEqual(256);
    expect(body.logs).toContain("fake-host p:a");
  });

  it("stops children on graceful shutdown", async () => {
    const h = await harness();
    const ensured = await api(h, "POST", "/v1/apps/p:a/ensure", {
      body: specFor(h.fixture, "a"),
    });
    const endpoint = (ensured.body as { endpoint: string }).endpoint;
    await h.supervisor.close();
    await expect(fetch(endpoint)).rejects.toThrow();
    expect(lineCount(path.join(h.fixture.base, "a-signals"))).toBe(1);
    expect((await api(h, "GET", "/v1/apps/p:a")).status).toBe(404);
  });
});
