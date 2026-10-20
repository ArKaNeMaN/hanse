import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstanceManager } from "../src/opencode/manager.js";
import {
  type AgentPermissionRule,
  buildPermissionPolicy,
  evaluateAgentPolicy,
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
const EXTERNAL = "/etc/hostname";
const SIBLING = "/srv/apps/api/notes.txt";
const VERIFY_SIBLING = path.join(path.dirname(APP_DIR), "sibling-app", "notes.txt");

function rules(...extra: AgentPermissionRule[]): AgentPermissionRule[] {
  return [
    { permission: "external_directory", pattern: "*", action: "deny" },
    ...ROOTS.map(
      (root): AgentPermissionRule => ({
        permission: "external_directory",
        pattern: `${root}/*`,
        action: "allow",
      }),
    ),
    { permission: "question", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
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
    { externalPath: EXTERNAL, siblingPath: SIBLING, trustedRoots: ROOTS },
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
    trustedRoots: ROOTS,
    fetch: fakeFetch(agents, pathInfo),
  });
}

describe("final ruleset evaluation", () => {
  it("accepts a compliant agent", () => {
    expect(evaluate({ name: "build", permission: rules() })).toEqual([]);
  });

  it("warns when the OMO global external-directory allow survives", () => {
    const warnings = evaluate({
      name: "Sisyphus",
      permission: rules({ permission: "external_directory", pattern: "*", action: "allow" }),
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('agent "Sisyphus"');
    expect(warnings[0]).toContain("external_directory");
  });

  it("warns when a project config allow survives the merge", () => {
    const warnings = evaluate({
      name: "build",
      permission: rules({ permission: "external_directory", pattern: "/etc/*", action: "allow" }),
    });
    expect(warnings).toEqual([`agent "build": external_directory does not deny ${EXTERNAL}`]);
  });

  it("warns for a custom agent whose allow is appended last", () => {
    const warnings = evaluate({
      name: "custom-auditor",
      permission: rules({ permission: "external_directory", pattern: "/srv/*", action: "allow" }),
    });
    expect(warnings).toEqual([
      `agent "custom-auditor": external_directory does not deny sibling path ${SIBLING}`,
    ]);
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
        { permission: "external_directory", pattern: "*", action: "deny" },
        { permission: "question", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
      ],
    });
    expect(warnings).toEqual([]);
  });

  it("still warns when a subagent allows an external path", () => {
    const warnings = evaluate({
      name: "explore",
      mode: "subagent",
      permission: [{ permission: "external_directory", pattern: "*", action: "allow" }],
    });
    expect(warnings).toEqual([
      `agent "explore": external_directory does not deny ${EXTERNAL}`,
      `agent "explore": external_directory does not deny sibling path ${SIBLING}`,
    ]);
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
    return expect(warnings).resolves.toEqual([
      'agent "bad": external_directory does not deny /etc/hostname',
      `agent "bad": external_directory does not deny sibling path ${VERIFY_SIBLING}`,
    ]);
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
      trustedRoots: ROOTS,
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
      trustedRoots: ROOTS,
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

async function managerFixture(handler: Parameters<typeof createServer>[1]): Promise<{
  manager: InstanceManager;
  db: SqliteDatabase;
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
  });
  return { manager, db };
}

const APP = {
  id: "p:web",
  projectId: "p",
  appKey: "web",
  appDir: APP_DIR,
};

describe("manager policy warnings", () => {
  it("stores mismatch warnings and exposes them per app", async () => {
    const { manager } = await managerFixture((incoming, outgoing) => {
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
    const warnings = manager.policyWarnings(APP.id);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toBe(
      'agent "custom-auditor": external_directory does not deny /etc/hostname',
    );
    expect(warnings[1]).toBe(
      `agent "custom-auditor": external_directory does not deny sibling path ${VERIFY_SIBLING}`,
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
});
