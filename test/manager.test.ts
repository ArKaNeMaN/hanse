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
import type {
  ContextMonitorLike,
  ContextMonitorOptions,
  ContextPolicy,
  ContextSnapshot,
} from "../src/opencode/context.js";
import { authorizationFor, setEndpointAuthorization } from "../src/opencode/endpoint-auth.js";
import {
  DeletionPendingError,
  InstanceManager,
  type ManagedApp,
  type OmoProfileSource,
  type SettingsSource,
  settingsHashFor,
  verifyAgentModels,
} from "../src/opencode/manager.js";
import type { OmoProfileInput, OmoProfileResult } from "../src/opencode/omo-profile.js";
import type { VerifyPolicyOptions } from "../src/opencode/policy.js";
import { hashValue } from "../src/settings/hash.js";
import type {
  EffectiveSettings,
  EffectiveValue,
  LaunchSettingsSnapshot,
} from "../src/settings/types.js";
import {
  type ResolvedSkills,
  type SkillApplyOptions,
  type SkillMaterializeResult,
  SkillService,
  type SkillSource,
  type SkillTarget,
} from "../src/skills/index.js";
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
  setContext(enabled: boolean, percent: number): void;
}

function fakeSettings(
  options: {
    model?: string;
    search?: WebToolConfig | null;
    gitAuth?: LaunchSettingsSnapshot["gitAuth"];
    gitAuthHash?: string;
    gitIdentity?: { name?: string | null; email?: string | null };
    context?: { enabled?: boolean; percent?: number };
  } = {},
): FakeSettings {
  let model = options.model ?? "deepseek/deepseek-flash";
  let search: WebToolConfig | null = options.search ?? { driver: "builtin" };
  const gitAuth = options.gitAuth ?? {};
  let gitAuthHash = options.gitAuthHash ?? "git-auth-hash";
  let contextEnabled = options.context?.enabled ?? false;
  let contextPercent = options.context?.percent ?? 80;
  const settings: FakeSettings = {
    setModel(next) {
      model = next;
    },
    setSearch(next) {
      search = next;
    },
    setGitAuthHash(next) {
      gitAuthHash = next;
    },
    setContext(nextEnabled, nextPercent) {
      contextEnabled = nextEnabled;
      contextPercent = nextPercent;
    },
    snapshot: (_target): LaunchSettingsSnapshot => {
      const effective: EffectiveSettings = {
        llm: { model: value(model) },
        web: { search: value(search), fetch: value({ driver: "builtin" }) },
        context: {
          autoCompact: { enabled: value(contextEnabled), percent: value(contextPercent) },
        },
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
  if (options.context !== undefined) {
    settings.contextPolicy = (): ContextPolicy => ({
      enabled: contextEnabled,
      percent: contextPercent,
      model,
      enabledSource: "global",
      percentSource: "global",
    });
  }
  return settings;
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

interface FakeSkills {
  source: SkillSource;
  probes: Array<{ target: SkillTarget; xdgConfigHome: string; options: SkillApplyOptions }>;
  applies: Array<{ target: SkillTarget; xdgConfigHome: string; options: SkillApplyOptions }>;
  hashes: SkillTarget[];
  setHash(hash: string | undefined): void;
  failProbe?: Error;
  failApply?: Error;
}

function fakeSkills(initialHash: string | undefined = "skills-hash", order?: string[]): FakeSkills {
  let hash = initialHash;
  const probes: FakeSkills["probes"] = [];
  const applies: FakeSkills["applies"] = [];
  const hashes: SkillTarget[] = [];
  const resolved = (target: SkillTarget): ResolvedSkills => ({
    scope:
      target.appKey === undefined ? (target.projectId === undefined ? "global" : "project") : "app",
    effective: [],
    rows: [],
    disabled: [],
    warnings: [],
  });
  const result = (): SkillMaterializeResult => ({
    hash,
    written: [],
    removed: [],
    preserved: [],
    warnings: [],
  });
  const fake: FakeSkills = {
    probes,
    applies,
    hashes,
    setHash(next) {
      hash = next;
    },
    source: {
      resolve: (target) => resolved(target),
      preview: (target) => ({ resolved: resolved(target), warnings: [] }),
      hash: (target) => {
        hashes.push(target);
        return hash;
      },
      probe: (target, xdgConfigHome, options) => {
        order?.push("probe");
        probes.push({ target, xdgConfigHome, options });
        if (fake.failProbe !== undefined) throw fake.failProbe;
        return result();
      },
      apply: (target, xdgConfigHome, options) => {
        order?.push("apply");
        applies.push({ target, xdgConfigHome, options });
        if (fake.failApply !== undefined) throw fake.failApply;
        return result();
      },
    },
  };
  return fake;
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
  monitorOptions?: {
    monitorFactory?: (options: ContextMonitorOptions) => ContextMonitorLike;
    enableContextMonitors?: boolean;
  },
  skills?: SkillSource | ((db: SqliteDatabase) => SkillSource),
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
  const skillsSource = typeof skills === "function" ? skills(db) : skills;
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
    ...monitorOptions,
    ...(skillsSource === undefined ? {} : { skills: skillsSource }),
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

interface FakeMonitor extends ContextMonitorLike {
  options: ContextMonitorOptions;
  startCount: number;
  stopCount: number;
}

function snapshotStub(sessionID: string): ContextSnapshot {
  return {
    sessionID,
    state: "unknown",
    used: null,
    limit: null,
    percent: null,
    model: null,
    status: "unknown",
    updatedAt: new Date(0).toISOString(),
    lastCompactedAt: null,
    lastError: null,
    autoCompact: { enabled: false, percent: 80, source: "default", percentSource: "default" },
  };
}

function fakeMonitorFactory(): {
  monitors: FakeMonitor[];
  factory: (options: ContextMonitorOptions) => ContextMonitorLike;
} {
  const monitors: FakeMonitor[] = [];
  return {
    monitors,
    factory: (options) => {
      const monitor: FakeMonitor = {
        options,
        startCount: 0,
        stopCount: 0,
        start() {
          this.startCount += 1;
        },
        stop() {
          this.stopCount += 1;
        },
        snapshot: async (sessionID) => snapshotStub(sessionID),
        compact: async () => ({ accepted: true }),
      };
      monitors.push(monitor);
      return monitor;
    },
  };
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

  it("probes before teardown and applies after delete before ensure", async () => {
    const order: string[] = [];
    class OrderedRuntime extends FakeAgentRuntime {
      override async ensure(spec: Parameters<FakeAgentRuntime["ensure"]>[0]) {
        order.push("ensure");
        return super.ensure(spec);
      }
      override async delete(appId: string) {
        order.push("delete");
        return super.delete(appId);
      }
    }
    const runtime = new OrderedRuntime();
    const skills = fakeSkills("skills-one", order);
    const { manager, dir } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    writeFileSync(path.join(dir, "p", "web", "mcp-token"), "tampered-token", { mode: 0o600 });
    order.length = 0;

    await manager.ensure(APP);

    expect(order).toEqual(["probe", "delete", "apply", "ensure"]);
    expect(skills.probes).toHaveLength(2);
    expect(skills.applies).toHaveLength(2);
  });

  it("does not probe or apply when reconnecting to a running agent", async () => {
    const order: string[] = [];
    const skills = fakeSkills("skills-one", order);
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    order.length = 0;
    skills.probes.length = 0;
    skills.applies.length = 0;

    await manager.ensure(APP);

    expect(order).toEqual([]);
    expect(skills.probes).toHaveLength(0);
    expect(skills.applies).toHaveLength(0);
  });

  it("aborts before teardown when the skills probe fails", async () => {
    const order: string[] = [];
    const skills = fakeSkills("skills-one", order);
    const runtime = new FakeAgentRuntime();
    const { manager, dir } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    writeFileSync(path.join(dir, "p", "web", "mcp-token"), "tampered-token", { mode: 0o600 });
    order.length = 0;
    runtime.deleted.length = 0;
    skills.failProbe = new Error("staging write failed");

    await expect(manager.ensure(APP)).rejects.toThrow(
      /^skills_materialize_failed: staging write failed$/,
    );
    expect(order).toEqual(["probe"]);
    expect(runtime.deleted).toEqual([]);
    expect(manager.isRunning(APP.id)).toBe(true);
  });

  it("records error and aborts when apply fails after teardown", async () => {
    const order: string[] = [];
    class OrderedRuntime extends FakeAgentRuntime {
      override async ensure(spec: Parameters<FakeAgentRuntime["ensure"]>[0]) {
        order.push("ensure");
        return super.ensure(spec);
      }
      override async delete(appId: string) {
        order.push("delete");
        return super.delete(appId);
      }
    }
    const skills = fakeSkills("skills-one", order);
    const runtime = new OrderedRuntime();
    const { manager, db, dir } = fixture(
      runtime,
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    writeFileSync(path.join(dir, "p", "web", "mcp-token"), "tampered-token", { mode: 0o600 });
    order.length = 0;
    runtime.deleted.length = 0;
    skills.failApply = new Error("live write failed");

    await expect(manager.ensure(APP)).rejects.toThrow(
      /^skills_materialize_failed: live write failed$/,
    );
    expect(order).toEqual(["probe", "delete", "apply"]);
    expect(runtime.deleted).toEqual([APP.id]);
    expect(runtime.ensured).toHaveLength(1);
    expect(manager.isRunning(APP.id)).toBe(false);
    expect(
      db
        .prepare(
          "SELECT state, runtime_state AS runtimeState, endpoint, pid FROM instances WHERE app_id = ?",
        )
        .get(APP.id),
    ).toEqual({ state: "error", runtimeState: "error", endpoint: null, pid: null });
  });

  it("keeps the old launch hash when the skills hash is undefined", () => {
    const settings = fakeSettings();
    const snapshot = settings.snapshot({ projectId: "p", appKey: "web" });
    const preSkillsEffective = {
      llm: { model: value("deepseek/deepseek-flash") },
      web: { search: value({ driver: "builtin" }), fetch: value({ driver: "builtin" }) },
      git: {
        user: { name: value<string | null>(null), email: value<string | null>(null) },
      },
    };
    const expected = hashValue({
      effective: preSkillsEffective,
      providerKeys: {},
      authHash: "auth-hash",
      gitAuthHash: "git-auth-hash",
      profile: "profile-hash",
    });

    expect(settingsHashFor(snapshot, "profile-hash")).toBe(expected);
    expect(settingsHashFor(snapshot, "profile-hash", undefined)).toBe(expected);
  });

  it("does not mark a zero-skill install restart-required", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings();
    const skills = fakeSkills();
    skills.setHash(undefined);
    const { manager, db } = fixture(
      runtime,
      settings,
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    const recorded = db
      .prepare(
        "SELECT applied_settings_hash AS appliedSettingsHash FROM instances WHERE app_id = 'p:web'",
      )
      .get() as { appliedSettingsHash: string | null };

    expect(recorded.appliedSettingsHash).toBe(
      settingsHashFor(settings.snapshot({ projectId: "p", appKey: "web" }), "profile-hash"),
    );
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("marks restart-required when the effective skills hash changes", async () => {
    const skills = fakeSkills("skills-one");
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      skills.source,
    );
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    skills.setHash("skills-two");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });

    skills.setHash("skills-one");
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });
  });

  it("ignores edits to shadowed and disabled skills when the effective hash is unchanged", async () => {
    let registry: SkillService | undefined;
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      undefined,
      (db) => {
        registry = new SkillService({ db });
        return registry;
      },
    );
    if (registry === undefined) throw new Error("missing skill registry");
    const target = { projectId: "p", appKey: "web" };
    const globalAlpha = registry.create(
      "global",
      {},
      { name: "alpha", description: "global alpha", content: "global alpha body" },
      "test",
    );
    registry.create(
      "app",
      target,
      { name: "alpha", description: "app alpha", content: "app alpha body" },
      "test",
    );
    const globalBeta = registry.create(
      "global",
      {},
      { name: "beta", description: "global beta", content: "global beta body" },
      "test",
    );
    const betaTombstone = registry.override(globalBeta.id, "app", target, false, "test");
    await manager.ensure(APP);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(globalAlpha.id, { content: "edited shadowed body" }, "test");
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(betaTombstone.id, { content: "edited disabled body" }, "test");
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    registry.update(betaTombstone.id, { enabled: true }, "test");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
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

  it("refuses to start an app whose project is marked deleting", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(APP.projectId);

    await expect(manager.ensure(APP)).rejects.toBeInstanceOf(DeletionPendingError);
    expect(runtime.ensured).toHaveLength(0);
    expect(manager.isRunning(APP.id)).toBe(false);
  });

  it("refuses a queued ensure after stopForDeletion commits the marker", async () => {
    const gate = deferred<void>();
    let deleteStarted = false;
    class GatedRuntime extends FakeAgentRuntime {
      override async delete(appId: string) {
        deleteStarted = true;
        await gate.promise;
        return super.delete(appId);
      }
    }
    const runtime = new GatedRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);

    const stopping = manager.stopForDeletion(APP.id);
    await waitFor(() => deleteStarted);
    const queued = manager.ensure(APP).then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.ensured).toHaveLength(1);

    gate.resolve(undefined);
    await expect(stopping).resolves.toBe(true);
    const queuedError = await queued;
    expect(queuedError).toBeInstanceOf(DeletionPendingError);
    expect(runtime.ensured).toHaveLength(1);
    expect(manager.isRunning(APP.id)).toBe(false);
    const row = db.prepare("SELECT deleting FROM apps WHERE id = ?").get(APP.id) as {
      deleting: number;
    };
    expect(row.deleting).toBe(1);
  });

  it("retries stopForDeletion on an already-marked app", async () => {
    const runtime = new FakeAgentRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    await manager.ensure(APP);
    db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(APP.id);
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(APP.projectId);

    await expect(manager.stopForDeletion(APP.id)).resolves.toBe(true);

    expect(runtime.deleted).toEqual([APP.id]);
    expect(manager.isRunning(APP.id)).toBe(false);
  });

  it("keeps the instance and writes no marker when the runtime delete fails", async () => {
    class FailingDeleteRuntime extends FakeAgentRuntime {
      failDelete = false;
      override async delete(appId: string) {
        if (this.failDelete) throw new Error("runtime unavailable");
        return super.delete(appId);
      }
    }
    const runtime = new FailingDeleteRuntime();
    const { manager, db } = fixture(runtime, fakeSettings(), fakeProfiles().source);
    const endpoint = await manager.ensure(APP);
    runtime.failDelete = true;

    await expect(manager.stopForDeletion(APP.id)).rejects.toThrow("runtime unavailable");
    expect(manager.isRunning(APP.id)).toBe(true);
    expect(authorizationFor(endpoint)).toBeDefined();
    expect(runtime.deleted).toEqual([]);
    const marked = db.prepare("SELECT deleting FROM apps WHERE id = ?").get(APP.id) as {
      deleting: number;
    };
    expect(marked.deleting).toBe(0);

    runtime.failDelete = false;
    await expect(manager.stopForDeletion(APP.id)).resolves.toBe(true);
    expect(manager.isRunning(APP.id)).toBe(false);
    const stopped = db.prepare("SELECT deleting FROM apps WHERE id = ?").get(APP.id) as {
      deleting: number;
    };
    expect(stopped.deleting).toBe(1);
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

describe("InstanceManager context monitors", () => {
  it("starts one monitor per running app and keeps it across repeated ensure", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4201");
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    expect(monitors.monitors).toHaveLength(1);
    expect(monitors.monitors[0]?.startCount).toBe(1);
    expect(monitors.monitors[0]?.options.endpoint).toBe("http://127.0.0.1:4201");

    await expect(manager.contextSnapshot(APP.id, "s")).resolves.toMatchObject({ sessionID: "s" });
    await expect(manager.compactSession(APP.id, "s")).resolves.toEqual({ accepted: true });

    await manager.ensure(APP);
    expect(monitors.monitors).toHaveLength(1);
    expect(monitors.monitors[0]?.startCount).toBe(1);
  });

  it("does not start a monitor when settings lack a context policy", async () => {
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings(),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    expect(monitors.monitors).toHaveLength(0);
  });

  it("stops the monitor on stopApp, stopForDeletion, and detach", async () => {
    const runtime = new FakeAgentRuntime();
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    await manager.stopApp(APP.id);
    expect(monitors.monitors[0]?.stopCount).toBe(1);

    await manager.ensure(APP);
    await manager.stopForDeletion(APP.id);
    expect(monitors.monitors[1]?.stopCount).toBe(1);

    const restarted = new FakeAgentRuntime();
    const next = fakeMonitorFactory();
    const other = fixture(
      restarted,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: next.factory },
    );
    await other.manager.ensure(APP);
    other.manager.detach();
    expect(next.monitors[0]?.stopCount).toBe(1);
    expect(other.manager.isRunning(APP.id)).toBe(false);
  });

  it("stops the old monitor before starting a new one on restart", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4202");
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    await expect(manager.restartIfRunning(APP)).resolves.toBe(true);

    expect(monitors.monitors).toHaveLength(2);
    expect(monitors.monitors[0]?.stopCount).toBe(1);
    expect(monitors.monitors[1]?.startCount).toBe(1);
  });

  it("supersedes the monitor when a reconnect sees a new endpoint", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4203");
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      runtime,
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await manager.ensure(APP);
    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...status, endpoint: "http://127.0.0.1:4299" });

    await manager.ensure(APP);

    expect(monitors.monitors).toHaveLength(2);
    expect(monitors.monitors[0]?.stopCount).toBe(1);
    expect(monitors.monitors[1]?.options.endpoint).toBe("http://127.0.0.1:4299");
  });

  it("stops every monitor before runtime.reconcile on stopAll", async () => {
    const order: string[] = [];
    class OrderedRuntime extends FakeAgentRuntime {
      override async reconcile(appIds: string[]) {
        order.push("reconcile");
        return super.reconcile(appIds);
      }
    }
    const monitors = fakeMonitorFactory();
    const factory = (options: ContextMonitorOptions): ContextMonitorLike => {
      const monitor = monitors.factory(options);
      const stop = monitor.stop.bind(monitor);
      monitor.stop = () => {
        order.push("monitor:stop");
        stop();
      };
      return monitor;
    };
    const { manager } = fixture(
      new OrderedRuntime(),
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: factory },
    );

    await manager.ensure(APP);
    await manager.stopAll();

    expect(order[0]).toBe("monitor:stop");
    expect(order).toContain("reconcile");
    expect(order.indexOf("monitor:stop")).toBeLessThan(order.indexOf("reconcile"));
  });

  it("resumes only running or starting instances and skips deleting apps", async () => {
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4204");
    const settings = fakeSettings({ context: {} });
    const profiles = fakeProfiles();
    const monitors = fakeMonitorFactory();
    const initial = fixture(
      runtime,
      settings,
      profiles.source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );
    await initial.manager.ensure(APP);
    initial.manager.detach();

    const resumed = fakeMonitorFactory();
    const manager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: resumed.factory,
    });

    await manager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);
    expect(manager.isRunning(APP.id)).toBe(true);
    expect(resumed.monitors).toHaveLength(1);

    const status = runtime.statuses.get(APP.id);
    if (status === undefined) throw new Error("missing runtime status");
    runtime.statuses.set(APP.id, { ...status, state: "starting" });
    manager.detach();
    const starting = fakeMonitorFactory();
    const startingManager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: starting.factory,
    });
    await startingManager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);
    expect(startingManager.isRunning(APP.id)).toBe(true);
    expect(starting.monitors).toHaveLength(1);

    runtime.statuses.set(APP.id, { ...status, state: "stopped", endpoint: null });
    startingManager.detach();
    const stopped = fakeMonitorFactory();
    const stoppedManager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: stopped.factory,
    });
    await stoppedManager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);
    expect(stoppedManager.isRunning(APP.id)).toBe(false);
    expect(stopped.monitors).toHaveLength(0);

    runtime.statuses.set(APP.id, status);
    initial.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(APP.id);
    const deleted = fakeMonitorFactory();
    const deletedManager = new InstanceManager(initial.db, initial.dir, {
      runtime,
      verify: async () => [],
      settings,
      omoProfiles: profiles.source,
      workspaceRoot: "/srv",
      monitorFactory: deleted.factory,
    });
    await deletedManager.resumeRunning([{ id: APP.id, projectId: "p", appKey: "web" }]);
    expect(deletedManager.isRunning(APP.id)).toBe(false);
    expect(deleted.monitors).toHaveLength(0);
  });

  it("throws AgentNotRunningError when no monitor is attached", async () => {
    const monitors = fakeMonitorFactory();
    const { manager } = fixture(
      new FakeAgentRuntime(),
      fakeSettings({ context: {} }),
      fakeProfiles().source,
      undefined,
      async () => [],
      undefined,
      { monitorFactory: monitors.factory },
    );

    await expect(manager.contextSnapshot(APP.id, "s")).rejects.toMatchObject({
      code: "agent_not_running",
    });
    await expect(manager.compactSession(APP.id, "s")).rejects.toMatchObject({
      code: "agent_not_running",
    });
  });

  it("hashes the pre-change effective shape and ignores context-only changes", async () => {
    const runtime = new FakeAgentRuntime();
    const settings = fakeSettings({ context: { enabled: false, percent: 80 } });
    const profiles = fakeProfiles();
    const { manager, db } = fixture(runtime, settings, profiles.source);
    await manager.ensure(APP);

    const recorded = db
      .prepare(
        "SELECT applied_settings_hash AS appliedSettingsHash FROM instances WHERE app_id = 'p:web'",
      )
      .get() as { appliedSettingsHash: string | null };
    const preChangeEffective = {
      llm: { model: value("deepseek/deepseek-flash") },
      web: { search: value({ driver: "builtin" }), fetch: value({ driver: "builtin" }) },
      git: {
        user: { name: value<string | null>(null), email: value<string | null>(null) },
      },
    };
    expect(recorded.appliedSettingsHash).toBe(
      hashValue({
        effective: preChangeEffective,
        providerKeys: {},
        authHash: "auth-hash",
        gitAuthHash: "git-auth-hash",
        profile: "profile-hash",
      }),
    );
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    settings.setContext(true, 55);
    expect(manager.pendingRestart(APP.id)).toEqual({ pending: false, reasons: [] });

    settings.setModel("deepseek/deepseek-pro");
    expect(manager.pendingRestart(APP.id)).toEqual({
      pending: true,
      reasons: ["settings_changed"],
    });
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
  it("refuses an application whose sanitized state path collides with a sibling", async () => {
    const f = fixture();
    const now = new Date().toISOString();
    f.db
      .prepare(
        "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:web:api','p','web:api','apps/web-api-sibling','AGENTS.md',?)",
      )
      .run(now);
    await expect(
      f.manager.ensure({
        id: "p:web-api",
        projectId: "p",
        appKey: "web-api",
        appDir: path.join(f.dir, "apps", "web-api"),
      }),
    ).rejects.toThrow(/state_path_collision/);
    expect(f.runtime.ensured).toHaveLength(0);
  });
});
