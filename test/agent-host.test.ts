import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpencodeEnv, readHostStatus, runAgentHost } from "../src/agent/host.js";
import type { AppRuntimeSpec } from "../src/agent/spec.js";
import { validateAppRuntimeSpec } from "../src/agent/spec.js";

const dirs: string[] = [];
const fixturePath = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface HostFixture {
  base: string;
  workspace: string;
  agents: string;
  appDir: string;
  appRoot: string;
  stateDir: string;
  home: string;
  dataDir: string;
  specPath: string;
  recordPath: string;
}

function fixture(): HostFixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-agent-host-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const agents = path.join(base, "agents");
  const appDir = path.join(workspace, "p", "app");
  const appRoot = path.join(agents, "p", "app");
  const stateDir = path.join(appRoot, "state");
  const home = path.join(appRoot, "home");
  const dataDir = path.join(appRoot, "data");
  for (const dir of [appDir, stateDir, home, dataDir]) {
    mkdirSync(dir, { recursive: true });
  }
  chmodSync(fixturePath, 0o755);
  return {
    base,
    workspace,
    agents,
    appDir,
    appRoot,
    stateDir,
    home,
    dataDir,
    specPath: path.join(base, "spec.json"),
    recordPath: path.join(base, "opencode-record.json"),
  };
}

function rawSpec(f: HostFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: "p:app",
    image: "hanse-agent-default:test",
    pathMode: "container",
    appDir: f.appDir,
    stateDir: f.stateDir,
    networkName: "agents",
    port: 4477,
    env: {
      HOME: f.home,
      XDG_DATA_HOME: f.dataDir,
      XDG_STATE_HOME: f.stateDir,
      XDG_CONFIG_HOME: path.join(f.appRoot, "config"),
      XDG_CACHE_HOME: path.join(f.appRoot, "cache"),
      OPENCODE_DB: path.join(f.stateDir, "opencode.db"),
      TMPDIR: path.join(f.appRoot, "tmp"),
      MISE_DATA_DIR: path.join(f.appRoot, "mise"),
      OPENCODE_CONFIG_CONTENT: '{"model":"deepseek/deepseek-flash"}',
      GIT_CEILING_DIRECTORIES: f.workspace,
      FAKE_OPENCODE_RECORD: f.recordPath,
      FAKE_OPENCODE_SIGNALS: path.join(f.base, "opencode-signals"),
    },
    resources: { memoryBytes: 2048, nanoCpus: 2, pidsLimit: 512 },
    labels: { "hanse.managed": "true" },
    ...overrides,
  };
}

function writeSpec(f: HostFixture, overrides: Record<string, unknown> = {}): AppRuntimeSpec {
  const spec = validateAppRuntimeSpec(rawSpec(f, overrides), {
    workspaceRoot: f.workspace,
    agentsRoot: f.agents,
  });
  writeFileSync(f.specPath, JSON.stringify(spec));
  return spec;
}

function options(f: HostFixture): {
  workspaceRoot: string;
  agentsRoot: string;
  opencodeBin: string;
} {
  return { workspaceRoot: f.workspace, agentsRoot: f.agents, opencodeBin: fixturePath };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("agent host environment", () => {
  it("passes only the spec env plus PATH and injects the opencode password", () => {
    const f = fixture();
    const authFile = path.join(f.dataDir, "opencode", "auth.json");
    mkdirSync(path.dirname(authFile), { recursive: true });
    writeFileSync(authFile, "{}");
    const passwordFile = path.join(f.appRoot, "opencode-password");
    writeFileSync(passwordFile, "hunter2\n");
    const profileFile = path.join(f.home, ".omo", "omo.jsonc");
    mkdirSync(path.dirname(profileFile), { recursive: true });
    writeFileSync(profileFile, "{}");
    const spec = validateAppRuntimeSpec(
      rawSpec(f, {
        env: {
          ...(rawSpec(f).env as Record<string, string>),
          HANSE_OPENCODE_AUTH_FILE: authFile,
          HANSE_OPENCODE_PASSWORD_FILE: passwordFile,
          OMO_PROFILE: "default",
        },
      }),
      { workspaceRoot: f.workspace, agentsRoot: f.agents },
    );

    const env = buildOpencodeEnv(
      spec,
      {
        PATH: "/usr/bin:/bin",
        HANSE_RUNTIME_TOKEN: "runtime-secret",
        HANSE_OPERATOR_TOKEN: "operator-secret",
        HANSE_DB: "/data/state/coordinator.db",
      },
      f.agents,
    );

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("hunter2");
    expect(env.HANSE_OPENCODE_AUTH_FILE).toBe(authFile);
    expect(env.HANSE_OPENCODE_PASSWORD_FILE).toBeUndefined();
    expect(env.OMO_PROFILE).toBe("default");
    expect(env.HANSE_RUNTIME_TOKEN).toBeUndefined();
    expect(env.HANSE_OPERATOR_TOKEN).toBeUndefined();
    expect(env.HANSE_DB).toBeUndefined();
    expect(Object.keys(env).sort()).not.toContain("HANSE_STATE_HOME");
  });

  it("fails clearly for missing or empty auth/OMO/password paths", () => {
    const f = fixture();
    const base = rawSpec(f).env as Record<string, string>;
    const specFor = (env: Record<string, string>): AppRuntimeSpec =>
      validateAppRuntimeSpec(rawSpec(f, { env }), {
        workspaceRoot: f.workspace,
        agentsRoot: f.agents,
      });

    expect(() =>
      buildOpencodeEnv(
        specFor({
          ...base,
          HANSE_OPENCODE_AUTH_FILE: path.join(f.appRoot, "missing-auth.json"),
        }),
        {},
        f.agents,
      ),
    ).toThrow(/auth.*does not exist/i);

    const emptyPassword = path.join(f.appRoot, "empty-password");
    writeFileSync(emptyPassword, "\n");
    expect(() =>
      buildOpencodeEnv(
        specFor({ ...base, HANSE_OPENCODE_PASSWORD_FILE: emptyPassword }),
        {},
        f.agents,
      ),
    ).toThrow(/empty/i);

    expect(() =>
      buildOpencodeEnv(specFor({ ...base, OMO_PROFILE: "default" }), {}, f.agents),
    ).toThrow(/OMO profile file does not exist/);
  });
});

describe("runAgentHost", () => {
  it("starts opencode with cwd/appDir, reports versions, and stops on abort", async () => {
    const f = fixture();
    const spec = writeSpec(f);
    const out: string[] = [];
    const err: string[] = [];
    const controller = new AbortController();

    const running = runAgentHost(f.specPath, {
      ...options(f),
      signal: controller.signal,
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => err.push(chunk),
      versionTimeoutMs: 2000,
      stopTimeoutMs: 1000,
    });

    const record = await waitFor(() => {
      if (!existsSync(f.recordPath)) return undefined;
      return JSON.parse(readFileSync(f.recordPath, "utf8")) as {
        argv: string[];
        cwd: string;
        env: Record<string, string>;
      };
    });
    expect(record.argv).toEqual(["serve", "--hostname", "0.0.0.0", "--port", String(spec.port)]);
    expect(record.cwd).toBe(f.appDir);
    expect(record.env.HOME).toBe(f.home);
    expect(record.env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"deepseek/deepseek-flash"}');
    expect(record.env.GIT_CEILING_DIRECTORIES).toBe(f.workspace);
    expect(record.env.HANSE_RUNTIME_TOKEN).toBeUndefined();
    expect(record.env.HANSE_OPERATOR_TOKEN).toBeUndefined();
    expect(record.env.HANSE_DB).toBeUndefined();
    expect(record.env.HANSE_STATE_HOME).toBeUndefined();

    const runningStatus = await waitFor(() => {
      const status = readHostStatus(f.stateDir);
      return status?.state === "running" ? status : undefined;
    });
    expect(runningStatus.specHash).toBe(spec.specHash);
    expect(runningStatus.hanseVersion.length).toBeGreaterThan(0);
    expect(runningStatus.opencodeVersion).toBe("fake-opencode 1.2.3");
    expect(runningStatus.port).toBe(spec.port);

    // Wait for opencode to finish starting before aborting: a SIGTERM sent earlier kills the
    // process before it installs its handler, so it never reports the graceful stop.
    await waitFor(() => (out.join("").includes("fake-opencode listening") ? true : undefined));

    controller.abort();
    await expect(running).resolves.toBe(0);
    expect(readHostStatus(f.stateDir)?.state).toBe("stopped");
    // Child stdio is a pipe: its last lines may arrive after the child exits.
    await waitFor(() => (out.join("").includes("fake-opencode stopping") ? true : undefined));
    expect(readFileSync(path.join(f.base, "opencode-signals"), "utf8")).toContain("SIGTERM");
    expect(out.join("")).toContain(`agent-host: starting ${spec.appId}`);
    expect(out.join("")).toContain("fake-opencode listening");
    expect(err.join("")).toBe("");
  });

  it("exits with a non-zero code when opencode cannot start", async () => {
    const f = fixture();
    writeSpec(f);
    const code = await runAgentHost(f.specPath, {
      ...options(f),
      opencodeBin: path.join(f.base, "missing-opencode"),
      stdout: () => undefined,
      stderr: () => undefined,
      versionTimeoutMs: 1000,
    });
    expect(code).toBe(1);
    expect(readHostStatus(f.stateDir)?.state).toBe("error");
  });

  it("rejects a spec without an assigned port and invalid paths", async () => {
    const f = fixture();
    writeSpec(f, { port: undefined });
    await expect(runAgentHost(f.specPath, options(f))).rejects.toThrow(/assigned port/);

    writeFileSync(
      f.specPath,
      JSON.stringify(rawSpec(f, { appDir: `${path.join(f.workspace, "p")}/../etc` })),
    );
    await expect(runAgentHost(f.specPath, options(f))).rejects.toThrow(/\.\./);
  });
});
