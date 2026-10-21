import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSpecHash } from "../src/agent/spec.js";
import { verifyAgentToken } from "../src/mcp/agent-tokens.js";
import { authorizationFor, setEndpointAuthorization } from "../src/opencode/endpoint-auth.js";
import {
  InstanceManager,
  type ManagedApp,
  type OmoProfileSource,
  type SettingsSource,
  verifyAgentModels,
} from "../src/opencode/manager.js";
import type { OmoProfileInput, OmoProfileResult } from "../src/opencode/omo-profile.js";
import type { VerifyPolicyOptions } from "../src/opencode/policy.js";
import type {
  EffectiveSettings,
  EffectiveValue,
  LaunchSettingsSnapshot,
} from "../src/settings/types.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import type { WebToolConfig } from "../src/web/types.js";
import { FakeAgentRuntime } from "./fixtures/fake-runtime.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const APP: ManagedApp = {
  id: "p:web",
  projectId: "p",
  appKey: "web",
  appDir: "/srv/apps/web",
};

function value<T>(item: T): EffectiveValue<T> {
  return { value: item, state: "set", source: "global", sources: ["global"] };
}

interface FakeSettings extends SettingsSource {
  setModel(model: string): void;
  setSearch(search: WebToolConfig | null): void;
  setGitAuthHash(hash: string): void;
}

function fakeSettings(
  options: {
    model?: string;
    search?: WebToolConfig | null;
    gitAuth?: LaunchSettingsSnapshot["gitAuth"];
    gitAuthHash?: string;
    gitIdentity?: { name?: string | null; email?: string | null };
  } = {},
): FakeSettings {
  let model = options.model ?? "deepseek/deepseek-flash";
  let search: WebToolConfig | null = options.search ?? { driver: "builtin" };
  const gitAuth = options.gitAuth ?? {};
  let gitAuthHash = options.gitAuthHash ?? "git-auth-hash";
  return {
    setModel(next) {
      model = next;
    },
    setSearch(next) {
      search = next;
    },
    setGitAuthHash(next) {
      gitAuthHash = next;
    },
    snapshot: (_target): LaunchSettingsSnapshot => {
      const effective: EffectiveSettings = {
        llm: { model: value(model) },
        web: { search: value(search), fetch: value({ driver: "builtin" }) },
        git: {
          user: {
            name: value(options.gitIdentity?.name ?? null),
            email: value(options.gitIdentity?.email ?? null),
          },
        },
      };
      return {
        resolved: {
          effective,
          scoped: {},
          providerKeys: {},
          gitAuth: {
            ssh: { state: "missing", kind: "ssh" },
            https: { state: "missing", kind: "https" },
          },
          gitAuthScoped: {
            ssh: { global: "absent", project: "absent", app: "absent" },
            https: { global: "absent", project: "absent", app: "absent" },
          },
          warnings: [],
        },
        mergedAuth: { deepseek: { type: "api", key: "sk-test" } },
        authHash: "auth-hash",
        providerKeys: new Map(),
        gitAuth,
        gitAuthHash,
      };
    },
  };
}

interface FakeProfiles {
  source: OmoProfileSource;
  ensures: OmoProfileInput[];
  writePaths: (string | undefined)[];
  previews: OmoProfileInput[];
}

function fakeProfiles(
  options: { applied?: boolean; warning?: string; contentHash?: string } = {},
): FakeProfiles {
  const ensures: OmoProfileInput[] = [];
  const writePaths: (string | undefined)[] = [];
  const previews: OmoProfileInput[] = [];
  const applied = options.applied ?? true;
  const contentHash = options.contentHash ?? "profile-hash";
  const result = (): OmoProfileResult => ({
    name: "hanse-app-test",
    applied,
    contentHash,
    ...(options.warning === undefined ? {} : { warning: options.warning }),
  });
  return {
    ensures,
    writePaths,
    previews,
    source: {
      ensure: async (input, writePath) => {
        ensures.push(input);
        writePaths.push(writePath);
        return result();
      },
      preview: (input) => {
        previews.push(input);
        return result();
      },
    },
  };
}

interface Fixture {
  manager: InstanceManager;
  runtime: FakeAgentRuntime;
  db: SqliteDatabase;
  dir: string;
}

function fixture(
  runtime: FakeAgentRuntime = new FakeAgentRuntime(),
  settings?: SettingsSource,
  profiles?: OmoProfileSource,
  modelVerifier?: (endpoint: string, expected: string) => Promise<string[]>,
  verify: (options: VerifyPolicyOptions) => Promise<string[]> = async () => [],
  hostPaths?: { hostWorkspace: string; hostAgents: string; workspaceRoot: string },
): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-manager-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:web','p','web','apps/web','AGENTS.md',?)",
  ).run(now);
  const manager = new InstanceManager(db, dir, {
    runtime,
    verify,
    settings,
    omoProfiles: profiles,
    modelVerifier,
    workspaceRoot: hostPaths?.workspaceRoot ?? "/srv",
    ...(hostPaths === undefined
      ? {}
      : { hostWorkspace: hostPaths.hostWorkspace, hostAgents: hostPaths.hostAgents }),
  });
  return { manager, runtime, db, dir };
}

function instanceState(db: SqliteDatabase): string | undefined {
  const row = db
    .prepare("SELECT COALESCE(runtime_state, state) AS state FROM instances WHERE app_id = 'p:web'")
    .get() as { state: string } | undefined;
  return row?.state;
}

function overlayOf(spec: { env: Record<string, string> }): Record<string, unknown> {
  return JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("InstanceManager lifecycle", () => {
  it("single-flights concurrent ensure calls and builds the runtime spec", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4100");
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, dir } = fixture(runtime, settings, profiles.source);

    const [first, second] = await Promise.all([manager.ensure(APP), manager.ensure(APP)]);

    expect(runtime.ensured).toHaveLength(1);
    expect(first).toBe(second);
    expect(manager.isRunning(APP.id)).toBe(true);
    expect(authorizationFor(first)).toMatch(/^Basic /);

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    expect(spec).toMatchObject({
      appId: "p:web",
      image: process.env.HANSE_AGENT_IMAGE?.trim() || "agent-default",
      pathMode: "container",
      appDir: "/srv/apps/web",
      stateDir: path.join(dir, "p", "web", "state"),
      networkName: "agents",
    });
    expect(spec.port).toBeUndefined();
    expect(spec.resources).toEqual({
      memoryBytes: 2048 * 1024 * 1024,
      nanoCpus: 2_000_000_000,
      pidsLimit: 512,
    });
    expect(spec.labels).toMatchObject({
      "hanse.managed": "true",
      "hanse.app.id": "p:web",
    });
    const { specHash, ...hashable } = spec;
    expect(computeSpecHash(hashable)).toBe(specHash);

    const overlay = overlayOf(spec);
    expect(overlay.model).toBe("deepseek/deepseek-flash");
    expect(spec.env.OMO_PROFILE).toBe("hanse-app-test");
    expect(spec.env.HANSE_OPENCODE_AUTH_FILE).toBe(
      path.join(dir, "p", "web", "data", "opencode", "auth.json"),
    );
    expect(profiles.ensures).toHaveLength(1);
    expect(profiles.writePaths).toEqual([path.join(dir, "p", "web", "home", ".omo", "omo.jsonc")]);
    expect(readFileSync(path.join(dir, "p", "web", "data", "opencode", "auth.json"), "utf8")).toBe(
      JSON.stringify({ deepseek: { type: "api", key: "sk-test" } }),
    );
  });

  it("labels the runtime spec with the per-app host agents root", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "hanse-manager-host-"));
    dirs.push(base);
    const workspace = path.join(base, "workspace");
    const hostAgents = path.join(base, "agents");
    const appDir = path.join(workspace, "apps", "web");
    mkdirSync(appDir, { recursive: true });
    const runtime = new FakeAgentRuntime();
    const f = fixture(runtime, fakeSettings(), fakeProfiles().source, undefined, async () => [], {
      hostWorkspace: workspace,
      hostAgents,
      workspaceRoot: workspace,
    });

    await f.manager.ensure({ ...APP, appDir });

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    expect(spec.pathMode).toBe("host");
    expect(spec.labels["hanse.agents.root"]).toBe(path.join(hostAgents, "p", "web"));
  });

  it("keeps the MCP endpoint and token file inside the config overlay", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);

    await manager.ensure(APP);

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const overlay = overlayOf(spec) as {
      mcp?: { hanse?: { environment?: Record<string, string> } };
    };
    expect(overlay.mcp?.hanse?.environment).toEqual({
      HANSE_MCP_API_BASE: "http://127.0.0.1:8787",
      HANSE_AGENT_TOKEN_FILE: tokenFile,
    });
    for (const key of [
      "HANSE_DB",
      "HANSE_PROJECT_ID",
      "HANSE_APP_KEY",
      "HANSE_OPERATOR_TOKEN",
      "HANSE_RUNTIME_TOKEN",
      "HANSE_DB",
      "HANSE_STATE_HOME",
      "OPENCODE_AUTH_CONTENT",
      "HANSE_AUTH_FILE",
    ]) {
      expect(spec.env[key]).toBeUndefined();
    }
    expect(existsSync(tokenFile)).toBe(true);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenFile, "utf8");
    expect(verifyAgentToken(db, token)).toEqual({
      appId: "p:web",
      projectId: "p",
      appKey: "web",
    });
  });

  it("mints and reuses a 0600 opencode password file", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);

    await manager.ensure(APP);
    const passwordFile = path.join(dir, "p", "web", "state", "opencode-password");
    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    expect(spec.env.HANSE_OPENCODE_PASSWORD_FILE).toBe(passwordFile);
    expect(existsSync(passwordFile)).toBe(true);
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
    const password = readFileSync(passwordFile, "utf8").trim();
    expect(password.length).toBeGreaterThan(0);

    await manager.stopApp(APP.id);
    await manager.ensure(APP);

    expect(readFileSync(passwordFile, "utf8").trim()).toBe(password);
  });

  it("honors HANSE_AGENT_API_BASE for the MCP endpoint", async () => {
    const previous = process.env.HANSE_AGENT_API_BASE;
    process.env.HANSE_AGENT_API_BASE = "http://hanse:8787";
    try {
      const runtime = new FakeAgentRuntime();
      const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source);
      await manager.ensure(APP);
      const spec = runtime.ensured[0];
      if (spec === undefined) throw new Error("missing runtime spec");
      const overlay = overlayOf(spec) as {
        mcp?: { hanse?: { environment?: Record<string, string> } };
      };
      expect(overlay.mcp?.hanse?.environment?.HANSE_MCP_API_BASE).toBe("http://hanse:8787");
    } finally {
      if (previous === undefined) delete process.env.HANSE_AGENT_API_BASE;
      else process.env.HANSE_AGENT_API_BASE = previous;
    }
  });

  it("uses HANSE_APP_* resources from the environment", async () => {
    const previous = {
      memory: process.env.HANSE_APP_MEMORY_MB,
      cpus: process.env.HANSE_APP_CPUS,
      pids: process.env.HANSE_APP_PIDS,
    };
    process.env.HANSE_APP_MEMORY_MB = "1024";
    process.env.HANSE_APP_CPUS = "1.5";
    process.env.HANSE_APP_PIDS = "256";
    try {
      const runtime = new FakeAgentRuntime();
      const { manager } = fixture(runtime);
      await manager.ensure(APP);
      expect(runtime.ensured[0]?.resources).toEqual({
        memoryBytes: 1024 * 1024 * 1024,
        nanoCpus: 1_500_000_000,
        pidsLimit: 256,
      });
    } finally {
      if (previous.memory === undefined) delete process.env.HANSE_APP_MEMORY_MB;
      else process.env.HANSE_APP_MEMORY_MB = previous.memory;
      if (previous.cpus === undefined) delete process.env.HANSE_APP_CPUS;
      else process.env.HANSE_APP_CPUS = previous.cpus;
      if (previous.pids === undefined) delete process.env.HANSE_APP_PIDS;
      else process.env.HANSE_APP_PIDS = previous.pids;
    }
  });

  it("returns an existing running endpoint without re-ensuring", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager } = fixture(runtime, settings, profiles.source);

    const first = await manager.ensure(APP);
    const second = await manager.ensure(APP);

    expect(second).toBe(first);
    expect(runtime.ensured).toHaveLength(1);
    settings.setModel("deepseek/deepseek-pro");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
    await expect(manager.ensure(APP)).resolves.toBe(first);
    expect(runtime.ensured).toHaveLength(1);
  });

  it("reuses the token file when a new manager starts against the same state", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");
    const restarted = new InstanceManager(db, dir, {
      runtime,
      verify: async () => [],
      workspaceRoot: "/srv",
    });
    await expect(restarted.ensure(APP)).resolves.toBe(endpoint);

    expect(runtime.ensured).toHaveLength(1);
    expect(readFileSync(tokenFile, "utf8")).toBe(token);
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(authorizationFor(endpoint)).toMatch(/^Basic /);
  });

  it("persists applied settings across detach and reattach", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, db, dir } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);

    const recorded = db
      .prepare(
        "SELECT applied_settings_hash AS appliedSettingsHash, applied_profile AS appliedProfile FROM instances WHERE app_id = 'p:web'",
      )
      .get() as { appliedSettingsHash: string | null; appliedProfile: number | null };
    expect(recorded.appliedSettingsHash).toEqual(expect.any(String));
    expect(recorded.appliedProfile).toBe(1);

    settings.setModel("deepseek/deepseek-pro");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    manager.detach();
    const reattached = new InstanceManager(db, dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
    });
    expect(reattached.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    await reattached.ensure(APP);
    expect(reattached.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    await expect(reattached.restartIfRunning(APP)).resolves.toBe(true);
    expect(reattached.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("reports applied_state_unknown for legacy rows without an applied hash", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, db, dir } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);
    db.prepare(
      "UPDATE instances SET applied_settings_hash = NULL, applied_profile = NULL WHERE app_id = 'p:web'",
    ).run();
    manager.detach();

    const reattached = new InstanceManager(db, dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
    });
    expect(reattached.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["applied_state_unknown"],
    });

    await reattached.ensure(APP);
    expect(reattached.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["applied_state_unknown"],
    });
  });

  it("does not report pending for a row that is not running", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, db } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);
    const recorded = db
      .prepare(
        "SELECT applied_settings_hash AS appliedSettingsHash, applied_profile AS appliedProfile FROM instances WHERE app_id = 'p:web'",
      )
      .get() as { appliedSettingsHash: string | null; appliedProfile: number | null };
    await manager.stopApp(APP.id);
    expect(
      db
        .prepare(
          "SELECT applied_settings_hash AS appliedSettingsHash, applied_profile AS appliedProfile FROM instances WHERE app_id = 'p:web'",
        )
        .get(),
    ).toEqual(recorded);
    manager.detach();
    settings.setModel("deepseek/deepseek-pro");

    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("reconciles a stale running row after the container disappears", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles();
    const { manager, db } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);
    settings.setModel("deepseek/deepseek-pro");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    runtime.statuses.delete(APP.id);
    expect(instanceState(db)).toBe("running");

    await manager.reconcileStatuses();

    expect(instanceState(db)).toBe("stopped");
    expect(manager.isRunning(APP.id)).toBe(false);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("keeps the last known state when a status probe fails", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    runtime.status = async () => {
      throw new Error("runner unavailable");
    };

    await manager.reconcileStatuses();

    expect(instanceState(db)).toBe("running");
    expect(manager.isRunning(APP.id)).toBe(true);
  });

  it("persists stopped when restart finds a stopped agent", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const { manager, db } = fixture(runtime, settings, fakeProfiles().source);
    await manager.ensure(APP);
    settings.setModel("deepseek/deepseek-pro");
    manager.detach();
    runtime.statuses.delete(APP.id);

    expect(instanceState(db)).toBe("running");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    await expect(manager.restartIfRunning(APP)).resolves.toBe(false);

    expect(instanceState(db)).toBe("stopped");
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("starts a reconciler that clears a stale row", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    runtime.statuses.delete(APP.id);

    manager.startStatusReconciler(20);
    await waitFor(() => instanceState(db) === "stopped");
    manager.detach();

    expect(instanceState(db)).toBe("stopped");
  });

  it("revokes and deletes the token on stop", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");

    await expect(manager.stopApp(APP.id)).resolves.toBe(true);

    expect(runtime.deleted).toEqual([APP.id]);
    expect(authorizationFor(endpoint)).toBeUndefined();
    expect(manager.isRunning(APP.id)).toBe(false);
    expect(existsSync(tokenFile)).toBe(false);
    expect(verifyAgentToken(db, token)).toBeUndefined();
    const row = db.prepare("SELECT revoked_at FROM agent_tokens WHERE app_id = 'p:web'").get() as
      | { revoked_at: string | null }
      | undefined;
    expect(row?.revoked_at).not.toBeNull();
  });

  it("recreates a running instance when the token file no longer matches", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const firstEndpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const previousToken = readFileSync(tokenFile, "utf8");
    writeFileSync(tokenFile, "tampered-token", { mode: 0o600 });

    const endpoint = await manager.ensure(APP);

    expect(endpoint).toBe(firstEndpoint);
    expect(runtime.ensured).toHaveLength(2);
    expect(runtime.deleted).toEqual([APP.id]);
    const token = readFileSync(tokenFile, "utf8");
    expect(token).not.toBe(previousToken);
    expect(verifyAgentToken(db, previousToken)).toBeUndefined();
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(manager.isRunning(APP.id)).toBe(true);
  });

  it("relaunches when the runtime status is not running", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...status, state: "stopped", endpoint: null });

    await manager.ensure(APP);

    expect(runtime.ensured).toHaveLength(2);
    expect(runtime.deleted).toEqual([APP.id]);
  });

  it("revokes and clears everything on stopAll", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);

    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");
    await manager.stopAll();

    expect(runtime.reconcileCalls).toEqual([[]]);
    expect(authorizationFor(endpoint)).toBeUndefined();
    expect(existsSync(tokenFile)).toBe(false);
    expect(verifyAgentToken(db, token)).toBeUndefined();
    expect(manager.isRunning(APP.id)).toBe(false);
  });

  it("detach drops in-memory state without stopping hosts or revoking tokens", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);
    const tokenFile = path.join(dir, "p", "web", "mcp-token");
    const token = readFileSync(tokenFile, "utf8");

    manager.detach();

    expect(runtime.deleted).toEqual([]);
    expect(runtime.reconcileCalls).toEqual([]);
    expect(authorizationFor(endpoint)).toBeUndefined();
    expect(existsSync(tokenFile)).toBe(true);
    expect(verifyAgentToken(db, token)).toBeDefined();
    expect(manager.isRunning(APP.id)).toBe(false);

    await expect(manager.stopApp(APP.id)).resolves.toBe(true);
    expect(runtime.deleted).toEqual([APP.id]);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("waits for an in-flight ensure before restarting", async () => {
    const runtime = new FakeAgentRuntime();
    const gate = deferred<void>();
    let verifyStarted = false;
    const { manager } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => {
        verifyStarted = true;
        await gate.promise;
        return [];
      },
    );

    const ensured = manager.ensure(APP);
    await waitFor(() => verifyStarted);
    let stopped = false;
    const stopping = manager.stopApp(APP.id).then((result) => {
      stopped = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    gate.resolve(undefined);
    const endpoint = await ensured;
    expect(endpoint).toContain("127.0.0.1");
    await expect(stopping).resolves.toBe(true);
    expect(manager.isRunning(APP.id)).toBe(false);
    expect(runtime.deleted).toEqual([APP.id]);
  });

  it("reports settings_changed when the snapshot hash changes", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings({ model: "deepseek/deepseek-flash" });
    const profiles = fakeProfiles();
    const { manager } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    settings.setModel("deepseek/deepseek-pro");

    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
    expect(profiles.previews.length).toBeGreaterThan(0);

    await manager.stopApp(APP.id);
    await manager.ensure(APP);
    const overlay = overlayOf(runtime.ensured[1] ?? { env: {} });
    expect(overlay.model).toBe("deepseek/deepseek-pro");
  });

  it("materializes managed git credentials and exposes only paths in the app env", async () => {
    const runtime = new FakeAgentRuntime();
    const privateKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-material\n-----END OPENSSH PRIVATE KEY-----\n";
    const token = "https-token-material";
    const settings = fakeSettings({
      gitIdentity: { name: 'Ada "Lovelace"', email: "ada@example.com" },
      gitAuth: {
        ssh: {
          privateKey,
          knownHosts: "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA",
        },
        https: { hosts: ["github.com"], username: "x-access-token", token },
      },
    });
    const profiles = fakeProfiles();
    const { manager, runtime: fakeRuntime, dir } = fixture(runtime, settings, profiles.source);

    await manager.ensure(APP);

    const home = path.join(dir, "p", "web", "home");
    const managed = path.join(home, ".config", "hanse", "git");
    for (const file of [
      "config",
      "ssh",
      "askpass",
      "id",
      "known_hosts",
      "token",
      "username",
      "https_hosts",
    ]) {
      expect(existsSync(path.join(managed, file)), file).toBe(true);
    }
    expect(statSync(path.join(managed, "config")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(managed, "ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(managed, "askpass")).mode & 0o777).toBe(0o700);
    const config = readFileSync(path.join(managed, "config"), "utf8");
    expect(config).toContain('name = "Ada \\"Lovelace\\""');
    expect(config).toContain('email = "ada@example.com"');
    expect(config).toContain("helper =");

    const spec = fakeRuntime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    expect(spec.env.GIT_CONFIG_GLOBAL).toBe(path.join(managed, "config"));
    expect(spec.env.GIT_SSH_COMMAND).toBe(`'${path.join(managed, "ssh")}'`);
    expect(spec.env.GIT_ASKPASS).toBe(path.join(managed, "askpass"));
    expect(spec.env.GIT_ASKPASS_REQUIRE).toBe("force");
    expect(spec.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(spec.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(spec.env.HANSE_CREDENTIALS_DIR).toBe(managed);
    expect(spec.env.LC_ALL).toBe("C");
    expect(spec.env.LANG).toBe("C");
    expect(spec.env.GIT_CEILING_DIRECTORIES).toBe("/srv/apps");
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toContain("key-material");
    expect(serialized).not.toContain(token);
  });

  it("creates a fresh app root and home before materializing", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const appRoot = path.join(dir, "p", "web");

    expect(existsSync(appRoot)).toBe(false);
    await manager.ensure(APP);

    expect(existsSync(path.join(appRoot, "home", ".config", "hanse", "git", "config"))).toBe(true);
  });

  it("treats a git credential hash change as a pending restart", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const { manager } = fixture(runtime, settings, fakeProfiles().source);
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    settings.setGitAuthHash("changed-git-auth-hash");

    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
  });

  it("fails the start when the app HOME is a symlink", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const appRoot = path.join(dir, "p", "web");
    const otherHome = path.join(dir, "other-home");
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(otherHome, { recursive: true });
    symlinkSync(otherHome, path.join(appRoot, "home"));

    await expect(manager.ensure(APP)).rejects.toThrow(/git_credentials_materialize_failed/);
    expect(runtime.ensured).toHaveLength(0);
  });
  it("reports profile_not_applied when the profile write failed", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const profiles = fakeProfiles({
      applied: false,
      warning: "omo_profile_unavailable: parse failure",
    });
    const { manager } = fixture(runtime, settings, profiles.source);

    await manager.ensure(APP);

    const spec = runtime.ensured[0];
    expect(spec?.env.OMO_PROFILE).toBeUndefined();
    expect(manager.profileWarnings(APP.id)).toEqual(["omo_profile_unavailable: parse failure"]);
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["profile_not_applied"],
    });
  });

  it("has no pending state when stopped or unknown", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source);

    expect(manager.pendingRestart("unknown")).toEqual({ pending: false, reasons: [] });
    await manager.ensure(APP);
    await manager.stopApp(APP.id);

    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("registers hanse_web and disables OMO websearch for managed search", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings({
      search: { driver: "deepseek", options: { provider: "deepseek" } },
    });
    const profiles = fakeProfiles();
    const { manager, dir } = fixture(runtime, settings, profiles.source);

    await manager.ensure(APP);

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    const overlay = overlayOf(spec) as {
      mcp?: Record<string, { command?: string[]; environment?: Record<string, string> }>;
    };
    expect(overlay.mcp?.hanse_web?.command).toEqual([
      process.execPath,
      process.argv[1] ?? "",
      "web-mcp",
    ]);
    expect(overlay.mcp?.hanse_web?.environment).toEqual({
      HANSE_WEB_CONFIG: JSON.stringify({ search: { provider: "deepseek" } }),
      HANSE_OPENCODE_AUTH_FILE: path.join(dir, "p", "web", "data", "opencode", "auth.json"),
    });
    expect(profiles.ensures[0]?.disableWebsearch).toBe(true);
  });

  it("keeps the existing behavior when settings and profiles are absent", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(runtime);

    await manager.ensure(APP);

    const spec = runtime.ensured[0];
    if (spec === undefined) throw new Error("missing runtime spec");
    const overlay = overlayOf(spec);
    expect(overlay.model).toBeUndefined();
    expect(spec.env.OMO_PROFILE).toBeUndefined();
    expect(spec.env.HANSE_OPENCODE_AUTH_FILE).toBeUndefined();
    expect(existsSync(path.join(dir, "p", "web", "data", "opencode", "auth.json"))).toBe(false);
    expect(
      existsSync(path.join(dir, "p", "web", "home", ".config", "hanse", "git", "config")),
    ).toBe(false);
    expect(spec.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(spec.env.GIT_ASKPASS).toBeUndefined();
    expect(spec.env.HANSE_CREDENTIALS_DIR).toBeUndefined();
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("records model mismatch warnings from the model verifier", async () => {
    const runtime = new FakeAgentRuntime();
    const warning =
      'model_mismatch: agent "oracle" uses deepseek/other, expected deepseek/deepseek-flash';
    const { manager } = fixture(runtime, fakeSettings(), fakeProfiles().source, async () => [
      warning,
    ]);

    await manager.ensure(APP);

    expect(manager.profileWarnings(APP.id)).toEqual([warning]);
  });

  it("parses /agent model mismatches and sends Basic auth", async () => {
    const endpoint = "http://127.0.0.1:4101";
    setEndpointAuthorization(endpoint, "opencode", "hunter2");
    let authorization: string | undefined;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(
        JSON.stringify([
          { name: "oracle", model: { providerID: "deepseek", modelID: "other" } },
          {
            name: "explore",
            model: { providerID: "deepseek", modelID: "deepseek-flash" },
          },
        ]),
        { status: 200 },
      );
    };

    await expect(
      verifyAgentModels(endpoint, "deepseek/deepseek-flash", fetchImpl),
    ).resolves.toEqual([
      'model_mismatch: agent "oracle" uses deepseek/other, expected deepseek/deepseek-flash',
    ]);
    expect(authorization).toMatch(/^Basic /);
  });
});

interface ImageFixture {
  manager: InstanceManager;
  runtime: FakeAgentRuntime;
  app: ManagedApp;
  appDir: string;
}

function imageFixture(
  status: ManagedApp["imageStatus"],
  imageRef: string | null,
  buildDeclaration = true,
): ImageFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-manager-image-"));
  dirs.push(dir);
  const appDir = path.join(dir, "apps", "web");
  mkdirSync(appDir, { recursive: true });
  if (buildDeclaration) {
    mkdirSync(path.join(appDir, ".hanse"), { recursive: true });
    writeFileSync(
      path.join(appDir, ".hanse", "app.yaml"),
      "name: web\nbuild:\n  dockerfile: Dockerfile\n",
      "utf8",
    );
    writeFileSync(path.join(appDir, "Dockerfile"), `FROM \${HANSE_BASE}\n`, "utf8");
  }
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:web','p','web','apps/web','AGENTS.md',?)",
  ).run(now);
  const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4100");
  const manager = new InstanceManager(db, dir, {
    runtime,
    verify: async () => [],
    workspaceRoot: dir,
  });
  return {
    manager,
    runtime,
    appDir,
    app: {
      id: "p:web",
      projectId: "p",
      appKey: "web",
      appDir,
      imageStatus: status,
      imageRef,
    },
  };
}

describe("InstanceManager app image selection", () => {
  it.each(["ready", "stale"] as const)("uses the built image when status is %s", async (status) => {
    const f = imageFixture(status, "hanse-app-p:web:build-1");
    await f.manager.ensure(f.app);
    expect(f.runtime.ensured[0]?.image).toBe("hanse-app-p:web:build-1");
  });

  it.each(["missing", "building", "error"] as const)(
    "refuses to start a build-configured app with status %s",
    async (status) => {
      const f = imageFixture(status, null);
      await expect(f.manager.ensure(f.app)).rejects.toThrow(/requires a built image/);
      expect(f.runtime.ensured).toHaveLength(0);
    },
  );

  it("refuses a ready app without an image reference", async () => {
    const f = imageFixture("ready", null);
    await expect(f.manager.ensure(f.app)).rejects.toThrow(/requires a built image/);
    expect(f.runtime.ensured).toHaveLength(0);
  });

  it("keeps the default image when the app has no build declaration", async () => {
    const f = imageFixture("missing", null, false);
    await f.manager.ensure(f.app);
    expect(f.runtime.ensured[0]?.image).toBe(
      process.env.HANSE_AGENT_IMAGE?.trim() || "agent-default",
    );
  });

  it("reconnects to a running container instead of replacing it after a failed build", async () => {
    const f = imageFixture("ready", "hanse-app-p:web:build-1");
    const endpoint = await f.manager.ensure(f.app);
    await f.manager.ensure({ ...f.app, imageStatus: "error", imageRef: null });
    expect(f.runtime.ensured).toHaveLength(1);
    expect(f.runtime.deleted).toHaveLength(0);
    expect(await f.manager.ensure({ ...f.app, imageStatus: "error", imageRef: null })).toBe(
      endpoint,
    );
  });
});
