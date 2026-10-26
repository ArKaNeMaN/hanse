import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stoppedStatus } from "../src/agent/protocol.js";
import {
  computeSpecHash,
  isValidAppId,
  parseAppRuntimeSpecJson,
  parseGitSshCommand,
  type SpecHashInput,
  validateAppRuntimeSpec,
} from "../src/agent/spec.js";
import { shellQuote } from "../src/git/materialize.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Roots {
  base: string;
  workspace: string;
  agents: string;
}

function fixture(): Roots {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-agent-spec-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const agents = path.join(base, "agents");
  mkdirSync(path.join(workspace, "p", "app"), { recursive: true });
  mkdirSync(path.join(agents, "p", "app"), { recursive: true });
  return { base, workspace, agents };
}

function rawSpec(roots: Roots, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const appRoot = path.join(roots.agents, "p", "app");
  return {
    appId: "p:app",
    image: "hanse-agent-default:test",
    pathMode: "container",
    appDir: path.join(roots.workspace, "p", "app"),
    stateDir: path.join(appRoot, "state"),
    networkName: "agents",
    env: {
      HOME: path.join(appRoot, "home"),
      XDG_DATA_HOME: path.join(appRoot, "data"),
      XDG_STATE_HOME: path.join(appRoot, "state"),
      XDG_CONFIG_HOME: path.join(appRoot, "config"),
      XDG_CACHE_HOME: path.join(appRoot, "cache"),
      OPENCODE_DB: path.join(appRoot, "state", "opencode.db"),
      TMPDIR: path.join(appRoot, "tmp"),
      MISE_DATA_DIR: path.join(appRoot, "mise"),
      OPENCODE_CONFIG_CONTENT: '{"model":"deepseek/deepseek-flash"}',
      OMO_PROFILE: "default",
    },
    resources: { memoryBytes: 2048, nanoCpus: 2, pidsLimit: 512 },
    labels: { "hanse.managed": "true", "hanse.app.id": "p:app" },
    ...overrides,
  };
}

function options(roots: Roots): { workspaceRoot: string; agentsRoot: string } {
  return { workspaceRoot: roots.workspace, agentsRoot: roots.agents };
}

describe("AppRuntimeSpec validation", () => {
  it("accepts a valid spec and computes a stable specHash", () => {
    const roots = fixture();
    const spec = validateAppRuntimeSpec(rawSpec(roots), options(roots));
    expect(spec.appId).toBe("p:app");
    expect(spec.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.port).toBeUndefined();
    const { specHash, ...hashable } = spec;
    expect(computeSpecHash(hashable)).toBe(specHash);
  });

  it("accepts a matching supplied specHash and rejects a mismatch", () => {
    const roots = fixture();
    const valid = validateAppRuntimeSpec(rawSpec(roots), options(roots));
    expect(
      validateAppRuntimeSpec({ ...rawSpec(roots), specHash: valid.specHash }, options(roots))
        .specHash,
    ).toBe(valid.specHash);
    expect(() =>
      validateAppRuntimeSpec({ ...rawSpec(roots), specHash: "0".repeat(64) }, options(roots)),
    ).toThrow(/specHash/);
  });

  it("keeps specHash stable across environment order and excludes ports and credentials", () => {
    const roots = fixture();
    const base = validateAppRuntimeSpec(rawSpec(roots), options(roots));
    const reordered = rawSpec(roots, {
      port: 4999,
      env: {
        OMO_PROFILE: "default",
        OPENCODE_CONFIG_CONTENT: '{"model":"deepseek/deepseek-flash"}',
        HANSE_OPENCODE_PASSWORD_FILE: path.join(roots.agents, "p", "app", "password"),
        MISE_DATA_DIR: path.join(roots.agents, "p", "app", "mise"),
        TMPDIR: path.join(roots.agents, "p", "app", "tmp"),
        OPENCODE_DB: path.join(roots.agents, "p", "app", "state", "opencode.db"),
        XDG_CACHE_HOME: path.join(roots.agents, "p", "app", "cache"),
        XDG_CONFIG_HOME: path.join(roots.agents, "p", "app", "config"),
        XDG_STATE_HOME: path.join(roots.agents, "p", "app", "state"),
        XDG_DATA_HOME: path.join(roots.agents, "p", "app", "data"),
        HOME: path.join(roots.agents, "p", "app", "home"),
      },
    });
    expect(validateAppRuntimeSpec(reordered, options(roots)).specHash).toBe(base.specHash);
  });

  it("changes specHash for configuration that must recreate the host", () => {
    const roots = fixture();
    const base = validateAppRuntimeSpec(rawSpec(roots), options(roots));
    const config = rawSpec(roots, {
      env: {
        ...(rawSpec(roots).env as Record<string, string>),
        OPENCODE_CONFIG_CONTENT: '{"model":"other/model"}',
      },
    });
    const labels = rawSpec(roots, {
      labels: { "hanse.managed": "true", "hanse.app.id": "p:other" },
    });
    expect(validateAppRuntimeSpec(config, options(roots)).specHash).not.toBe(base.specHash);
    expect(validateAppRuntimeSpec(labels, options(roots)).specHash).not.toBe(base.specHash);
  });

  it("rejects traversal, outside roots, the forbidden state root, and symlink escapes", () => {
    const roots = fixture();
    const outside = path.join(roots.base, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(roots.workspace, "escape"));

    expect(() =>
      validateAppRuntimeSpec(
        rawSpec(roots, { appDir: `${path.join(roots.workspace, "p")}/../etc` }),
        options(roots),
      ),
    ).toThrow(/\.\./);
    expect(() =>
      validateAppRuntimeSpec(rawSpec(roots, { appDir: "/etc" }), options(roots)),
    ).toThrow(/escapes/);
    expect(() =>
      validateAppRuntimeSpec(rawSpec(roots, { appDir: roots.workspace }), options(roots)),
    ).toThrow(/escapes/);
    expect(() =>
      validateAppRuntimeSpec(
        rawSpec(roots, {
          appDir: path.join(roots.workspace, "escape", "app"),
        }),
        options(roots),
      ),
    ).toThrow(/escapes/);
    expect(() =>
      validateAppRuntimeSpec(
        rawSpec(roots, {
          appDir: "/data/workspace/p/app",
          stateDir: "/data/state/app",
        }),
        { workspaceRoot: "/data/workspace", agentsRoot: "/data" },
      ),
    ).toThrow(/\/data\/state/);
  });

  it("rejects coordinator secrets, provider keys, and non-absolute env paths", () => {
    const roots = fixture();
    const env = (key: string, value: string) => ({
      ...(rawSpec(roots).env as Record<string, string>),
      [key]: value,
    });
    for (const key of [
      "HANSE_OPERATOR_TOKEN",
      "HANSE_RUNTIME_TOKEN",
      "HANSE_DB",
      "HANSE_STATE_HOME",
      "OPENCODE_AUTH_CONTENT",
      "HANSE_AUTH_FILE",
      "OPENCODE_SERVER_PASSWORD",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
    ]) {
      expect(() =>
        validateAppRuntimeSpec(rawSpec(roots, { env: env(key, "x") }), options(roots)),
      ).toThrow(new RegExp(key));
    }
    expect(() =>
      validateAppRuntimeSpec(rawSpec(roots, { env: env("HOME", "relative/home") }), options(roots)),
    ).toThrow(/absolute/);
    expect(() =>
      validateAppRuntimeSpec(
        rawSpec(roots, { env: env("XDG_STATE_HOME", "/data/state/app") }),
        options(roots),
      ),
    ).toThrow(/\/data\/state/);
  });

  it("accepts the managed git path keys and the quoted SSH command", () => {
    const roots = fixture();
    const appRoot = path.join(roots.agents, "p", "app");
    const managed = path.join(appRoot, "home", ".config", "hanse", "git");
    const env = {
      ...(rawSpec(roots).env as Record<string, string>),
      GIT_CONFIG_GLOBAL: path.join(managed, "config"),
      GIT_ASKPASS: path.join(managed, "askpass"),
      HANSE_CREDENTIALS_DIR: managed,
      GIT_SSH_COMMAND: shellQuote(path.join(managed, "ssh")),
    };
    const spec = validateAppRuntimeSpec(rawSpec(roots, { env }), options(roots));
    expect(spec.env.GIT_CONFIG_GLOBAL).toBe(path.join(managed, "config"));
    expect(spec.env.GIT_SSH_COMMAND).toBe(shellQuote(path.join(managed, "ssh")));
    expect(parseGitSshCommand(spec.env.GIT_SSH_COMMAND ?? "")).toBe(path.join(managed, "ssh"));
  });

  it("rejects malformed or out-of-root GIT_SSH_COMMAND values", () => {
    const roots = fixture();
    const appRoot = path.join(roots.agents, "p", "app");
    const env = (value: string) => ({
      ...(rawSpec(roots).env as Record<string, string>),
      GIT_SSH_COMMAND: value,
    });
    const ssh = path.join(appRoot, "home", ".config", "hanse", "git", "ssh");
    expect(() => validateAppRuntimeSpec(rawSpec(roots, { env: env(ssh) }), options(roots))).toThrow(
      /single-quoted/,
    );
    expect(() =>
      validateAppRuntimeSpec(rawSpec(roots, { env: env("'relative/ssh'") }), options(roots)),
    ).toThrow(/absolute/);
    expect(() =>
      validateAppRuntimeSpec(rawSpec(roots, { env: env("'/data/state/app/ssh'") }), options(roots)),
    ).toThrow(/\/data\/state/);
    expect(() =>
      validateAppRuntimeSpec(rawSpec(roots, { env: env(`'/tmp/evil'`) }), options(roots)),
    ).toThrow(/inside/);
    expect(parseGitSshCommand(shellQuote("/tmp/a'b/ssh"))).toBe("/tmp/a'b/ssh");
  });

  it("rejects non-absolute and state-root managed git path keys", () => {
    const roots = fixture();
    const env = (key: string, value: string) => ({
      ...(rawSpec(roots).env as Record<string, string>),
      [key]: value,
    });
    for (const key of ["GIT_CONFIG_GLOBAL", "GIT_ASKPASS", "HANSE_CREDENTIALS_DIR"]) {
      expect(() =>
        validateAppRuntimeSpec(rawSpec(roots, { env: env(key, "relative/path") }), options(roots)),
      ).toThrow(/absolute/);
      expect(() =>
        validateAppRuntimeSpec(
          rawSpec(roots, { env: env(key, "/data/state/credentials") }),
          options(roots),
        ),
      ).toThrow(/\/data\/state/);
      expect(() =>
        validateAppRuntimeSpec(rawSpec(roots, { env: env(key, "/tmp/outside") }), options(roots)),
      ).toThrow(/inside/);
    }
  });

  it("rejects unsafe app ids, ports, resources, and malformed JSON", () => {
    const roots = fixture();
    for (const appId of ["", ".", "..", "../app", "a/b", "a b"]) {
      expect(isValidAppId(appId)).toBe(false);
      expect(() => validateAppRuntimeSpec(rawSpec(roots, { appId }), options(roots))).toThrow(
        /appId/,
      );
    }
    expect(isValidAppId("p:web-1")).toBe(true);
    expect(() => validateAppRuntimeSpec(rawSpec(roots, { port: 70000 }), options(roots))).toThrow(
      /port/,
    );
    expect(() =>
      validateAppRuntimeSpec(
        rawSpec(roots, { resources: { memoryBytes: 0, nanoCpus: 1, pidsLimit: 1 } }),
        options(roots),
      ),
    ).toThrow(/memoryBytes/);
    expect(() => parseAppRuntimeSpecJson("{", options(roots))).toThrow(/valid JSON/);
  });
});

describe("runtime protocol", () => {
  it("describes a never-started app as stopped", () => {
    expect(stoppedStatus("p:app")).toEqual({
      appId: "p:app",
      endpoint: null,
      state: "stopped",
      specHash: null,
      version: null,
      imageId: null,
    });
  });

  it("exposes a hash input without specHash", () => {
    const roots = fixture();
    const spec = validateAppRuntimeSpec(rawSpec(roots), options(roots));
    const input: SpecHashInput = spec;
    expect(computeSpecHash(input)).toBe(spec.specHash);
  });
});
