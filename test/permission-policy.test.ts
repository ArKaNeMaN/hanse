import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../src/logging/logger.js";
import { InstanceManager, type InstanceManagerOptions } from "../src/opencode/manager.js";
import {
  type AgentPermissionRule,
  ATTACHMENTS_POLICY_VERSION,
  BASH_DENY_PATTERNS,
  BASH_DENY_PROBES,
  buildPermissionPolicy,
  credentialDenyPatterns,
  evaluateAgentPolicy,
  evaluatePermission,
  type PolicyFetch,
  verifyInstancePolicy,
} from "../src/opencode/policy.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { FakeAgentRuntime } from "./fixtures/fake-runtime.js";

const dirs: string[] = [];
const servers: Server[] = [];
const databases: SqliteDatabase[] = [];

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
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROOTS = ["/data/opencode/tool-output", "/data/opencode/repos", "/tmp/opencode"];
const APP_DIR = "/srv/apps/web";
const APP_ROOT = "/data/agents/p/web";
const HOME = path.join(APP_ROOT, "home");
const XDG_DATA = path.join(APP_ROOT, "data");
const PASSWORD = path.join(APP_ROOT, "state", "opencode-password");
const DENY = credentialDenyPatterns({
  appRoot: APP_ROOT,
  home: HOME,
  xdgDataHome: XDG_DATA,
  passwordFile: PASSWORD,
});

function rules(...extra: AgentPermissionRule[]): AgentPermissionRule[] {
  return [
    { permission: "external_directory", pattern: "*", action: "allow" },
    ...DENY.map(
      (pattern): AgentPermissionRule => ({
        permission: "external_directory",
        pattern,
        action: "deny",
      }),
    ),
    { permission: "question", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    ...BASH_DENY_PATTERNS.map(
      (pattern): AgentPermissionRule => ({ permission: "bash", pattern, action: "deny" }),
    ),
    ...extra,
  ];
}

function evaluate(agent: {
  name: string;
  hidden?: boolean;
  mode?: string;
  permission: AgentPermissionRule[];
}): string[] {
  return evaluateAgentPolicy(
    {
      name: agent.name,
      hidden: agent.hidden === true,
      mode: agent.mode ?? "primary",
      rules: agent.permission,
    },
    { denyPatterns: DENY, bashProbes: BASH_DENY_PROBES },
  );
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(
  agents: unknown,
  pathInfo: unknown = { directory: APP_DIR, worktree: APP_DIR },
): PolicyFetch {
  return async (url) => {
    if (url.endsWith("/agent")) return jsonResponse(agents);
    if (url.endsWith("/path")) return jsonResponse(pathInfo);
    return new Response("not found", { status: 404 });
  };
}

function verifyWith(agents: unknown, pathInfo?: unknown): Promise<string[]> {
  return verifyInstancePolicy({
    endpoint: "http://127.0.0.1:4100",
    appDir: APP_DIR,
    denyPatterns: DENY,
    fetch: fakeFetch(agents, pathInfo),
  });
}

describe("final ruleset evaluation", () => {
  it("accepts a compliant agent", () => {
    expect(evaluate({ name: "build", permission: rules() })).toEqual([]);
  });

  it("warns once per credential when a broad external allow is appended last", () => {
    const warnings = evaluate({
      name: "Sisyphus",
      permission: rules({ permission: "external_directory", pattern: "*", action: "allow" }),
    });
    expect(warnings).toEqual(
      DENY.map(
        (pattern) => `agent "Sisyphus": external_directory does not deny credential ${pattern}`,
      ),
    );
  });

  it("warns only for the credential overridden by a targeted allow", () => {
    const warnings = evaluate({
      name: "build",
      permission: rules({
        permission: "external_directory",
        pattern: `${XDG_DATA}/*`,
        action: "allow",
      }),
    });
    expect(warnings).toEqual([
      `agent "build": external_directory does not deny credential ${DENY[0]}`,
    ]);
  });

  it("builds allow-all external permission with credential denies last", () => {
    const policy = buildPermissionPolicy(ROOTS, { denyPatterns: DENY });
    const externalRules: AgentPermissionRule[] = Object.entries(policy.external_directory).map(
      ([pattern, action]) => ({ permission: "external_directory", pattern, action }),
    );
    expect(evaluatePermission(externalRules, "external_directory", "/etc/os-release")).toBe(
      "allow",
    );
    for (const pattern of DENY) {
      const probe = pattern.endsWith("/*") ? `${pattern.slice(0, -2)}/probe` : pattern;
      expect(evaluatePermission(externalRules, "external_directory", probe)).toBe("deny");
    }
  });

  it("builds deny-only bash rules with no catch-all and no broad kill deny", () => {
    const policy = buildPermissionPolicy(ROOTS);
    expect(Object.keys(policy.bash)).toEqual([...BASH_DENY_PATTERNS]);
    expect(policy.bash["*"]).toBeUndefined();
    expect(policy.bash["kill *"]).toBeUndefined();
    expect(BASH_DENY_PATTERNS).not.toContain("kill *");
    for (const pattern of BASH_DENY_PATTERNS) {
      expect(policy.bash[pattern]).toBe("deny");
    }
    expect(ATTACHMENTS_POLICY_VERSION).toBe(3);
  });

  it("requires every non-hidden agent including subagents to deny every bash probe", () => {
    expect(BASH_DENY_PROBES).toEqual([...BASH_DENY_PATTERNS]);
    const compliant = evaluate({ name: "build", permission: rules() });
    expect(compliant).toEqual([]);
    const subagent = evaluate({ name: "explore", mode: "subagent", permission: rules() });
    expect(subagent).toEqual([]);

    const missingOne = evaluate({
      name: "explore",
      mode: "subagent",
      permission: rules().filter(
        (rule) => !(rule.permission === "bash" && rule.pattern === "kill 1"),
      ),
    });
    expect(missingOne).toEqual(['agent "explore": bash does not deny "kill 1"']);

    const widened = evaluate({
      name: "build",
      permission: [
        ...rules(),
        { permission: "bash", pattern: "pkill *opencode*", action: "allow" },
      ],
    });
    expect(widened).toEqual(['agent "build": bash does not deny "pkill *opencode*"']);
  });

  it("skips bash verification entirely for hidden agents", () => {
    const warnings = evaluate({
      name: "compaction",
      hidden: true,
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });
    expect(warnings).toEqual([]);
  });

  it("skips hidden system agents with intentional deny profiles", () => {
    const warnings = evaluate({
      name: "compaction",
      hidden: true,
      permission: rules({ permission: "*", pattern: "*", action: "allow" }),
    });
    expect(warnings).toEqual([]);
  });

  it("does not warn for a hidden agent with question denied", () => {
    const warnings = evaluate({
      name: "title",
      hidden: true,
      permission: [{ permission: "question", pattern: "*", action: "deny" }],
    });
    expect(warnings).toEqual([]);
  });

  it("does not require primary-only capabilities for subagents", () => {
    const warnings = evaluate({
      name: "multimodal-looker",
      mode: "subagent",
      permission: [
        ...rules(),
        { permission: "question", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
      ],
    });
    expect(warnings).toEqual([]);
  });

  it("still checks credential denies for a subagent", () => {
    const warnings = evaluate({
      name: "explore",
      mode: "subagent",
      permission: rules({ permission: "external_directory", pattern: "*", action: "allow" }),
    });
    expect(warnings).toEqual(
      DENY.map(
        (pattern) => `agent "explore": external_directory does not deny credential ${pattern}`,
      ),
    );
  });

  it("evaluates every non-hidden agent in the response", () => {
    const warnings = verifyWith([
      { name: "good", permission: rules() },
      {
        name: "bad",
        permission: rules({ permission: "external_directory", pattern: "*", action: "allow" }),
      },
      {
        name: "compaction",
        hidden: true,
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    ]);
    return expect(warnings).resolves.toEqual(
      DENY.map((pattern) => `agent "bad": external_directory does not deny credential ${pattern}`),
    );
  });

  it("warns without throwing when the instance path is wider than the app", async () => {
    const warnings = await verifyWith([{ name: "build", permission: rules() }], {
      directory: APP_DIR,
      worktree: "/srv",
    });
    expect(warnings).toEqual([
      'instance path.worktree is "/srv" but expected "/srv/apps/web" or "/"',
    ]);
  });

  it("accepts a non-git worktree of /", async () => {
    const warnings = await verifyWith([{ name: "build", permission: rules() }], {
      directory: APP_DIR,
      worktree: "/",
    });
    expect(warnings).toEqual([]);
  });
});

describe("policy verification", () => {
  it("returns a timeout warning without throwing", async () => {
    const warnings = await verifyInstancePolicy({
      endpoint: "http://127.0.0.1:4100",
      appDir: APP_DIR,
      denyPatterns: DENY,
      timeoutMs: 10,
      retries: 0,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    expect(warnings).toEqual(["policy_unverified: agent policy verification timed out"]);
  });

  it("retries and succeeds after a transient failure", async () => {
    const responses = [
      new Response("bad gateway", { status: 502 }),
      jsonResponse([{ name: "build", permission: rules() }]),
    ];
    let calls = 0;
    const warnings = await verifyInstancePolicy({
      endpoint: "http://127.0.0.1:4100",
      appDir: APP_DIR,
      denyPatterns: DENY,
      retryDelayMs: 1,
      fetch: async (url) => {
        if (url.endsWith("/path")) {
          return jsonResponse({ directory: APP_DIR, worktree: APP_DIR });
        }
        return (
          responses[Math.min(calls++, responses.length - 1)] ?? new Response("", { status: 500 })
        );
      },
    });
    expect(warnings).toEqual([]);
    expect(calls).toBe(2);
  });
});

async function managerFixture(
  handler: Parameters<typeof createServer>[1],
  overrides: Partial<InstanceManagerOptions> = {},
): Promise<{
  manager: InstanceManager;
  db: SqliteDatabase;
  runtimeRoot: string;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-policy-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(APP_DIR, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:web','p','web',?, 'AGENTS.md', ?)",
  ).run(APP_DIR, now);
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const runtime = new FakeAgentRuntime(() => `http://127.0.0.1:${address.port}`);
  const manager = new InstanceManager(db, dir, {
    runtime,
    verificationTimeoutMs: 50,
    verificationRetries: 0,
    workspaceRoot: "/srv",
    ...overrides,
  });
  return { manager, db, runtimeRoot: dir };
}

const APP = {
  id: "p:web",
  projectId: "p",
  appKey: "web",
  appDir: APP_DIR,
};

describe("manager policy warnings", () => {
  it("stores mismatch warnings and exposes them per app", async () => {
    const { manager, runtimeRoot } = await managerFixture((incoming, outgoing) => {
      const body = incoming.url?.endsWith("/agent")
        ? [
            {
              name: "custom-auditor",
              permission: rules({
                permission: "external_directory",
                pattern: "*",
                action: "allow",
              }),
            },
          ]
        : { directory: APP_DIR, worktree: APP_DIR };
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(body));
    });

    const endpoint = await manager.ensure(APP);
    expect(endpoint).toContain("127.0.0.1");
    const appRoot = path.join(runtimeRoot, "p", "web");
    const deny = credentialDenyPatterns({
      appRoot,
      home: path.join(appRoot, "home"),
      xdgDataHome: path.join(appRoot, "data"),
      passwordFile: path.join(appRoot, "state", "opencode-password"),
    });
    const warnings = manager.policyWarnings(APP.id);
    expect(warnings).toEqual(
      deny.map(
        (pattern) =>
          `agent "custom-auditor": external_directory does not deny credential ${pattern}`,
      ),
    );
    expect(manager.policyWarnings("unknown")).toEqual([]);
    await manager.stopAll();
  });

  it("stores a timeout warning and still returns the endpoint", async () => {
    const { manager } = await managerFixture(() => {
      // Never respond; the verification timeout must not block startup.
    });

    const endpoint = await manager.ensure(APP);
    expect(endpoint).toContain("127.0.0.1");
    expect(manager.policyWarnings(APP.id)).toEqual([
      "policy_unverified: agent policy verification timed out",
    ]);
    await manager.stopAll();
  });

  function capturePolicyLogs(): {
    logger: Logger;
    entries: Array<{ message: string; fields?: Record<string, unknown> }>;
  } {
    const entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    return {
      entries,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message, fields) => {
          entries.push({ message, fields });
        },
        error: () => undefined,
      },
    };
  }

  it("logs a failed verification once and still exposes the warning", async () => {
    const { logger, entries } = capturePolicyLogs();
    const { manager } = await managerFixture(
      (_incoming, outgoing) => {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end("boom");
      },
      { logger },
    );

    await manager.ensure(APP);

    expect(manager.policyWarnings(APP.id)).toEqual([
      "policy_unverified: agent policy verification failed",
    ]);
    const logs = entries.filter((entry) => entry.message === "policy_verification_failed");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.fields).toEqual({
      appId: APP.id,
      warnings: ["policy_unverified: agent policy verification failed"],
    });
    await manager.stopAll();
  });

  it("logs a timed-out verification once and still exposes the warning", async () => {
    const { logger, entries } = capturePolicyLogs();
    const { manager } = await managerFixture(
      () => {
        // Never respond; the verification timeout must not block startup.
      },
      { logger },
    );

    await manager.ensure(APP);

    expect(manager.policyWarnings(APP.id)).toEqual([
      "policy_unverified: agent policy verification timed out",
    ]);
    const logs = entries.filter((entry) => entry.message === "policy_verification_failed");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.fields).toEqual({
      appId: APP.id,
      warnings: ["policy_unverified: agent policy verification timed out"],
    });
    await manager.stopAll();
  });

  it("bounds logged diagnostics and leaves policyWarnings unchanged", async () => {
    const { logger, entries } = capturePolicyLogs();
    const diagnostic = `policy_unverified: ${"x".repeat(400)}`;
    const { manager } = await managerFixture(
      () => {
        // The injected verifier replaces the runtime policy fetch.
      },
      { logger, verify: async () => [diagnostic, 'agent "x": policy mismatch'] },
    );

    await manager.ensure(APP);

    expect(manager.policyWarnings(APP.id)).toEqual([diagnostic, 'agent "x": policy mismatch']);
    const logs = entries.filter((entry) => entry.message === "policy_verification_failed");
    expect(logs).toHaveLength(1);
    const fields = logs[0]?.fields as { appId: string; warnings: string[] };
    expect(fields.appId).toBe(APP.id);
    expect(fields.warnings).toEqual([diagnostic.slice(0, 300)]);
    expect(fields.warnings[0]?.length).toBeLessThanOrEqual(300);
    await manager.stopAll();
  });
});

describe("web permission policy", () => {
  it("adds managed web tool keys after the built-in web keys", () => {
    const policy = buildPermissionPolicy(ROOTS, {
      webfetch: "deny",
      websearch: "deny",
      managedSearch: true,
      managedFetch: true,
    });
    expect(Object.keys(policy)).toEqual([
      "external_directory",
      "question",
      "todowrite",
      "todoread",
      "webfetch",
      "websearch",
      "hanse_web_search",
      "hanse_web_fetch",
      "bash",
      "read",
      "edit",
      "doom_loop",
    ]);
    expect(policy.webfetch).toBe("deny");
    expect(policy.websearch).toBe("deny");
    expect(policy.hanse_web_search).toBe("allow");
    expect(policy.hanse_web_fetch).toBe("allow");
  });

  it("emits only the managed key that is active", () => {
    const policy = buildPermissionPolicy(ROOTS, {
      webfetch: "allow",
      websearch: "deny",
      managedSearch: true,
      managedFetch: false,
    });
    expect(policy.hanse_web_search).toBe("allow");
    expect(policy.hanse_web_fetch).toBeUndefined();
    expect(Object.keys(policy)).not.toContain("hanse_web_fetch");
  });

  it("keeps built-in web tools allowed by default", () => {
    const policy = buildPermissionPolicy(ROOTS);
    expect(policy.webfetch).toBe("allow");
    expect(policy.websearch).toBe("allow");
    expect(Object.keys(policy)).not.toContain("hanse_web_search");
  });

  it("orders external_directory as allow-all, roots, then credential denies", () => {
    const policy = buildPermissionPolicy(ROOTS, { denyPatterns: DENY });
    expect(Object.keys(policy.external_directory)).toEqual([
      "*",
      ...ROOTS.map((root) => `${root}/*`),
      ...DENY,
    ]);
    expect(policy.external_directory["*"]).toBe("allow");
    for (const pattern of DENY) {
      expect(policy.external_directory[pattern]).toBe("deny");
    }
  });
});
