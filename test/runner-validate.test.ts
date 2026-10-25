import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSpecHash } from "../src/agent/spec.js";
import { ConfigError } from "../src/config/load.js";
import { appContainerName, appNetworkName } from "../src/runner/names.js";
import {
  hostPathForSpecEnv,
  loadRunnerConfig,
  RUNNER_APP_PORT,
  validateRunnerSpec,
} from "../src/runner/validate.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  base: string;
  hostWorkspace: string;
  hostAgents: string;
  appDir: string;
  agentsRoot: string;
  stateDir: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-runner-"));
  dirs.push(base);
  const hostWorkspace = path.join(base, "workspace");
  const hostAgents = path.join(base, "agents");
  const appDir = path.join(hostWorkspace, "project", "app");
  const agentsRoot = path.join(hostAgents, "project", "app");
  const stateDir = path.join(agentsRoot, "state");
  for (const dir of [appDir, stateDir, path.join(agentsRoot, "home")]) {
    mkdirSync(dir, { recursive: true });
  }
  return { base, hostWorkspace, hostAgents, appDir, agentsRoot, stateDir };
}

function config(f: Fixture) {
  return {
    token: "runtime-token",
    hostWorkspace: f.hostWorkspace,
    hostAgents: f.hostAgents,
    allowedImages: new Set(["agent-default:test"]),
    coordinatorContainer: "hanse",
    dockerSocket: "/var/run/docker.sock",
    dockerApiVersion: "v1.41",
  };
}

function raw(f: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: "project:app",
    image: "agent-default:test",
    pathMode: "host",
    appDir: f.appDir,
    stateDir: f.stateDir,
    networkName: appNetworkName("project:app"),
    port: RUNNER_APP_PORT,
    env: {
      HOME: "/data/agents/project/app/home",
      XDG_DATA_HOME: "/data/agents/project/app/data",
      XDG_STATE_HOME: "/data/agents/project/app/state",
      XDG_CONFIG_HOME: "/data/agents/project/app/config",
      XDG_CACHE_HOME: "/data/agents/project/app/cache",
      OPENCODE_DB: "/data/agents/project/app/state/opencode.db",
      TMPDIR: "/data/agents/project/app/tmp",
      MISE_DATA_DIR: "/data/agents/project/app/mise",
      HANSE_OPENCODE_AUTH_FILE: "/data/agents/project/app/data/opencode/auth.json",
      HANSE_OPENCODE_PASSWORD_FILE: "/data/agents/project/app/state/opencode-password",
      GIT_CONFIG_GLOBAL: "/data/agents/project/app/home/.config/hanse/git/config",
      GIT_ASKPASS: "/data/agents/project/app/home/.config/hanse/git/askpass",
      GIT_SSH_COMMAND: "'/data/agents/project/app/home/.config/hanse/git/ssh'",
      HANSE_CREDENTIALS_DIR: "/data/agents/project/app/home/.config/hanse/git",
    },
    resources: { memoryBytes: 1024, nanoCpus: 1, pidsLimit: 128 },
    labels: { "hanse.managed": "true" },
    ...overrides,
  };
}

function expectConfigError(fn: () => unknown, code?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    if (code !== undefined) {
      expect((error as ConfigError).code).toBe(code);
    }
    return;
  }
  throw new Error("expected ConfigError");
}

describe("runner spec validation", () => {
  it("maps host paths to fixed container paths and names", () => {
    const f = fixture();
    const spec = validateRunnerSpec(raw(f), config(f));

    expect(spec.containerName).toBe(appContainerName("project:app"));
    expect(spec.networkName).toBe(appNetworkName("project:app"));
    expect(spec.hostAppDir).toBe(f.appDir);
    expect(spec.hostAgentsRoot).toBe(f.agentsRoot);
    expect(spec.containerAppDir).toBe("/data/workspace/project/app");
    expect(spec.containerAgentsRoot).toBe("/data/agents/project/app");
    expect(spec.port).toBe(4100);
  });

  it("includes the read-only attachments bind marker in the spec hash", () => {
    const f = fixture();
    const base = validateRunnerSpec(raw(f), config(f));
    const marked = validateRunnerSpec(raw(f, { attachmentsReadOnly: true }), config(f));
    expect(marked.attachmentsReadOnly).toBe(true);
    expect(marked.specHash).not.toBe(base.specHash);
    expect(
      computeSpecHash({ ...base, specHash: undefined as never, attachmentsReadOnly: true }),
    ).toBe(marked.specHash);
  });

  it("requires host paths and an image allowlist in the runner env", () => {
    const f = fixture();
    expectConfigError(() => loadRunnerConfig({}));
    expectConfigError(() =>
      loadRunnerConfig({
        HANSE_RUNTIME_TOKEN: "t",
        HANSE_HOST_WORKSPACE: "relative",
        HANSE_HOST_AGENTS: f.hostAgents,
        HANSE_AGENT_IMAGE: "agent-default:test",
      }),
    );
    const loaded = loadRunnerConfig({
      HANSE_RUNTIME_TOKEN: "t",
      HANSE_HOST_WORKSPACE: f.hostWorkspace,
      HANSE_HOST_AGENTS: f.hostAgents,
      HANSE_AGENT_IMAGE: "agent-default:test",
    });
    expect([...loaded.allowedImages]).toEqual(["agent-default:test"]);
  });

  it("ignores the removed legacy git credential env", () => {
    const f = fixture();
    const loaded = loadRunnerConfig({
      HANSE_RUNTIME_TOKEN: "t",
      HANSE_HOST_WORKSPACE: f.hostWorkspace,
      HANSE_HOST_AGENTS: f.hostAgents,
      HANSE_AGENT_IMAGE: "agent-default:test",
      HANSE_HOST_GIT_DIR: "relative/git",
      HANSE_GIT_TOKEN: "git-token",
      HANSE_OPERATOR_TOKEN: "must-not-cross",
    });
    expect(loaded).not.toHaveProperty("hostGitDir");
    expect(loaded).not.toHaveProperty("gitEnv");
    expect(loaded.hostRunnerTmp).toBe("/var/lib/hanse/tmp");
  });

  it("validates the runner temp root as absolute and non-overlapping", () => {
    const f = fixture();
    const base = {
      HANSE_RUNTIME_TOKEN: "t",
      HANSE_HOST_WORKSPACE: f.hostWorkspace,
      HANSE_HOST_AGENTS: f.hostAgents,
      HANSE_AGENT_IMAGE: "agent-default:test",
    };
    expect(loadRunnerConfig(base).hostRunnerTmp).toBe("/var/lib/hanse/tmp");
    expect(
      loadRunnerConfig({ ...base, HANSE_HOST_RUNNER_TMP: path.join(f.base, "runner-tmp") })
        .hostRunnerTmp,
    ).toBe(path.join(f.base, "runner-tmp"));

    expectConfigError(() => loadRunnerConfig({ ...base, HANSE_HOST_RUNNER_TMP: "relative" }));
    expectConfigError(() =>
      loadRunnerConfig({ ...base, HANSE_HOST_RUNNER_TMP: path.join(f.hostWorkspace, "tmp") }),
    );
    expectConfigError(() =>
      loadRunnerConfig({ ...base, HANSE_HOST_RUNNER_TMP: path.dirname(f.hostWorkspace) }),
    );
    expectConfigError(() =>
      loadRunnerConfig({ ...base, HANSE_HOST_RUNNER_TMP: path.join(f.hostAgents, "sys", "tmp") }),
    );
  });

  it("rejects arbitrary images, container path mode, network mismatch, and a non-fixed port", () => {
    const f = fixture();
    expectConfigError(() => validateRunnerSpec(raw(f, { image: "evil:latest" }), config(f)));
    expectConfigError(() => validateRunnerSpec(raw(f, { pathMode: "container" }), config(f)));
    expectConfigError(() => validateRunnerSpec(raw(f, { networkName: "agents" }), config(f)));
    expectConfigError(() => validateRunnerSpec(raw(f, { port: 4101 }), config(f)));
  });

  it("rejects traversal, outside roots, and a stateDir outside the app state slot", () => {
    const f = fixture();
    expectConfigError(() =>
      validateRunnerSpec(
        raw(f, { appDir: path.join(f.hostWorkspace, "..", "outside") }),
        config(f),
      ),
    );
    expectConfigError(() =>
      validateRunnerSpec(
        raw(f, { stateDir: path.join(f.hostAgents, "project", "app") }),
        config(f),
      ),
    );
    expectConfigError(() =>
      validateRunnerSpec(
        raw(f, {
          env: {
            HOME: "/etc",
          },
        }),
        config(f),
      ),
    );
  });

  it("maps password/auth env paths back to the host app state", () => {
    const f = fixture();
    const password = path.join(f.stateDir, "opencode-password");
    writeFileSync(password, "secret\n");
    const spec = validateRunnerSpec(raw(f), config(f));

    expect(hostPathForSpecEnv(spec, "HANSE_OPENCODE_PASSWORD_FILE")).toBe(password);
    expect(hostPathForSpecEnv(spec, "HOME")).toBe(path.join(f.agentsRoot, "home"));
    expect(hostPathForSpecEnv(spec, "GIT_CONFIG_GLOBAL")).toBe(
      path.join(f.agentsRoot, "home", ".config", "hanse", "git", "config"),
    );
    expect(hostPathForSpecEnv(spec, "MISSING")).toBeUndefined();
  });

  it("accepts only the quoted GIT_SSH_COMMAND inside the app mounts", () => {
    const f = fixture();
    const base = raw(f);
    const env = base.env as Record<string, string>;
    expect(() => validateRunnerSpec(raw(f), config(f))).not.toThrow();

    expectConfigError(() =>
      validateRunnerSpec(
        raw(f, {
          env: { ...env, GIT_SSH_COMMAND: "/data/agents/project/app/home/git/ssh" },
        }),
        config(f),
      ),
    );
    expectConfigError(() =>
      validateRunnerSpec(
        raw(f, { env: { ...env, GIT_SSH_COMMAND: "'/etc/evil-ssh'" } }),
        config(f),
      ),
    );
    expectConfigError(() =>
      validateRunnerSpec(
        raw(f, { env: { ...env, GIT_SSH_COMMAND: "'/data/agents/project/app/../other/ssh'" } }),
        config(f),
      ),
    );
  });

  it("rejects managed git path keys outside the app mounts", () => {
    const f = fixture();
    const env = raw(f).env as Record<string, string>;
    for (const key of ["GIT_CONFIG_GLOBAL", "GIT_ASKPASS", "HANSE_CREDENTIALS_DIR"]) {
      expectConfigError(() =>
        validateRunnerSpec(raw(f, { env: { ...env, [key]: "/etc/credentials" } }), config(f)),
      );
    }
  });
});
