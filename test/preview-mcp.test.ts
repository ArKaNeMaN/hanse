import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { MASTER_TOOLS } from "../src/master/tools.js";
import type { AgentTokenIdentity } from "../src/mcp/agent-tokens.js";
import { PREVIEW_TOOLS } from "../src/mcp/preview-protocol.js";
import type { RpcRequest, RpcResponse } from "../src/mcp/protocol.js";
import { TOOLS } from "../src/mcp/protocol.js";
import { type AppSkillRpcOptions, handleRpcAsync, SSH_TOOLS } from "../src/mcp/ssh-protocol.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { PreviewService } from "../src/preview/service.js";
import { appContainerName } from "../src/runner/names.js";
import { APP_SKILL_TOOLS } from "../src/skills/app-tools.js";
import { SkillService } from "../src/skills/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const START = Date.UTC(2026, 9, 23, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const PREVIEW_NAMES = PREVIEW_TOOLS.map((tool) => tool.name);

const APP_A: AgentTokenIdentity = { appId: "p:a", projectId: "p", appKey: "a" };
const APP_B: AgentTokenIdentity = { appId: "p:b", projectId: "p", appKey: "b" };

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

interface Fixture {
  db: SqliteDatabase;
}

function fixture(): Fixture {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/workspace/p',?,?)",
  ).run(now, now);
  for (const [id, appKey] of [
    ["p:a", "a"],
    ["p:b", "b"],
  ] as const) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
    ).run(id, appKey, `apps/${appKey}`, now);
  }
  return { db };
}

interface Clock {
  service: PreviewService;
  advance(ms: number): void;
}

function clockedService(): Clock {
  let current = START;
  const service = new PreviewService({ now: () => current });
  return {
    service,
    advance(ms: number): void {
      current += ms;
    },
  };
}

function runningManager(): InstanceManager {
  return { isRunning: () => true } as unknown as InstanceManager;
}

function stoppedManager(): InstanceManager {
  return { isRunning: () => false } as unknown as InstanceManager;
}

/** Answers `isRunning` from the given sequence, repeating the last answer. */
function sequencedManager(...answers: boolean[]): InstanceManager {
  let index = 0;
  return {
    isRunning: () => {
      const answer = answers[Math.min(index, answers.length - 1)] ?? false;
      index += 1;
      return answer;
    },
  } as unknown as InstanceManager;
}

function options(previews?: PreviewService, manager?: InstanceManager): AppSkillRpcOptions {
  return {
    ...(previews === undefined ? {} : { previews }),
    ...(manager === undefined ? {} : { manager }),
  };
}

async function dispatch(
  f: Fixture,
  agent: AgentTokenIdentity,
  request: RpcRequest,
  opts: AppSkillRpcOptions,
): Promise<RpcResponse | undefined> {
  return handleRpcAsync(
    new CoordinatorService(f.db, agent.projectId),
    undefined,
    agent,
    request,
    opts,
  );
}

function resultText(response: RpcResponse | undefined): Record<string, unknown> {
  const content = (response?.result as { content?: Array<{ text: string }> } | undefined)?.content;
  expect(content?.[0]?.text).toBeTypeOf("string");
  return JSON.parse(content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

function toolNames(response: RpcResponse | undefined): string[] {
  const result = response?.result as { tools?: Array<{ name: string }> } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name);
}

async function listTools(
  f: Fixture,
  agent: AgentTokenIdentity,
  opts: AppSkillRpcOptions,
): Promise<string[]> {
  return toolNames(await dispatch(f, agent, { jsonrpc: "2.0", id: 1, method: "tools/list" }, opts));
}

async function callTool(
  f: Fixture,
  agent: AgentTokenIdentity,
  name: string,
  args: unknown,
  opts: AppSkillRpcOptions,
): Promise<Record<string, unknown>> {
  return resultText(
    await dispatch(
      f,
      agent,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, ...(args === undefined ? {} : { arguments: args }) },
      },
      opts,
    ),
  );
}

function openArgs(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { key, name: "Storefront", port: 3000, ...overrides };
}

describe("preview tools/list", () => {
  it("does not advertise preview tools when previews are not configured", async () => {
    const f = fixture();
    expect(await listTools(f, APP_A, {})).toEqual(
      [...TOOLS, ...SSH_TOOLS].map((tool) => tool.name),
    );
    expect(await listTools(f, APP_A, options(undefined, runningManager()))).toEqual(
      [...TOOLS, ...SSH_TOOLS].map((tool) => tool.name),
    );
  });

  it("advertises exactly the three preview tools when previews are configured", async () => {
    const f = fixture();
    const names = await listTools(f, APP_A, options(new PreviewService(), runningManager()));
    expect(names).toEqual([...TOOLS, ...SSH_TOOLS, ...PREVIEW_TOOLS].map((tool) => tool.name));
    expect(names.filter((name) => PREVIEW_NAMES.includes(name))).toEqual([
      "preview_open",
      "preview_close",
      "preview_list",
    ]);
  });

  it("keeps app-skill tools before preview tools when both are configured", async () => {
    const f = fixture();
    const names = await listTools(f, APP_A, {
      ...options(new PreviewService(), runningManager()),
      db: f.db,
      skills: new SkillService({ db: f.db }),
    });
    expect(names).toEqual(
      [...TOOLS, ...SSH_TOOLS, ...APP_SKILL_TOOLS, ...PREVIEW_TOOLS].map((tool) => tool.name),
    );
  });

  it("never exposes preview tools on the master surface", () => {
    const masterNames = MASTER_TOOLS.map((tool) => tool.name);
    for (const name of PREVIEW_NAMES) {
      expect(masterNames).not.toContain(name);
    }
  });
});

describe("preview_open", () => {
  it("returns the documented result shape with null operator host fields", async () => {
    const f = fixture();
    const { service } = clockedService();
    const result = await callTool(
      f,
      APP_A,
      "preview_open",
      openArgs("web"),
      options(service, runningManager()),
    );

    expect(result).toEqual({
      ok: true,
      preview: {
        key: "web",
        name: "Storefront",
        port: 3000,
        url: "/preview/p/a/web/",
        base_path: "/preview/p/a/web/",
        base_path_without_trailing_slash: "/preview/p/a/web",
        operator_host: null,
        operator_hostname: null,
        expires_at: new Date(START + 2 * HOUR).toISOString(),
      },
    });
  });

  it("returns the operator host and hostname after a human chat load is recorded", async () => {
    const f = fixture();
    const { service } = clockedService();
    service.recordOperatorHost("p:a", "coordinator.example:8787");

    const result = await callTool(
      f,
      APP_A,
      "preview_open",
      openArgs("web"),
      options(service, runningManager()),
    );
    expect(result.preview).toMatchObject({
      operator_host: "coordinator.example:8787",
      operator_hostname: "coordinator.example",
    });
  });

  it("derives the app container target from the agent token", async () => {
    const f = fixture();
    const { service } = clockedService();
    await callTool(f, APP_A, "preview_open", openArgs("web"), options(service, runningManager()));

    const record = service.get("p:a", "web");
    expect(record?.targetHost).toBe(appContainerName("p:a"));
    expect(record?.appId).toBe("p:a");
    expect(record?.projectId).toBe("p");
    expect(record?.appKey).toBe("a");
  });

  it("rejects a non-running application without inserting a record", async () => {
    const f = fixture();
    const service = new PreviewService();
    const result = await callTool(
      f,
      APP_A,
      "preview_open",
      openArgs("web"),
      options(service, stoppedManager()),
    );

    expect(result).toEqual({
      ok: false,
      code: "preview_app_not_running",
      message: "application is not running",
    });
    expect(service.get("p:a", "web")).toBeUndefined();
    expect(service.list("p:a")).toEqual([]);
  });

  it("removes the record when the application stops between the check and the insert", async () => {
    const f = fixture();
    const service = new PreviewService();
    const result = await callTool(
      f,
      APP_A,
      "preview_open",
      openArgs("web"),
      options(service, sequencedManager(true, false)),
    );

    expect(result).toMatchObject({ ok: false, code: "preview_app_not_running" });
    expect(service.get("p:a", "web")).toBeUndefined();
    expect(service.list("p:a")).toEqual([]);
  });

  it("rejects invalid keys, names, and ports at the boundary", async () => {
    const f = fixture();
    const service = new PreviewService();
    const opts = options(service, runningManager());

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ key: "", name: "Storefront", port: 3000 }, "preview_invalid_key"],
      [{ key: "Upper", name: "Storefront", port: 3000 }, "preview_invalid_key"],
      [{ key: "-web", name: "Storefront", port: 3000 }, "preview_invalid_key"],
      [{ key: "a".repeat(33), name: "Storefront", port: 3000 }, "preview_invalid_key"],
      [{ key: "web", name: "", port: 3000 }, "preview_invalid_name"],
      [{ key: "web", name: "x".repeat(65), port: 3000 }, "preview_invalid_name"],
      [{ key: "web", name: "line\nbreak", port: 3000 }, "preview_invalid_name"],
      [{ key: "web", name: "Storefront" }, "preview_invalid_port"],
      [{ key: "web", name: "Storefront", port: "3000" }, "preview_invalid_port"],
      [{ key: "web", name: "Storefront", port: 0 }, "preview_invalid_port"],
      [{ key: "web", name: "Storefront", port: 1023 }, "preview_invalid_port"],
      [{ key: "web", name: "Storefront", port: 65536 }, "preview_invalid_port"],
      [{ key: "web", name: "Storefront", port: 3000.5 }, "preview_invalid_port"],
      [{ key: "web", name: "Storefront", port: 4100 }, "preview_reserved_port"],
    ];

    for (const [args, code] of cases) {
      const result = await callTool(f, APP_A, "preview_open", args, opts);
      expect(result).toMatchObject({ ok: false, code });
      expect(result.message).toBeTypeOf("string");
    }
    expect(service.list("p:a")).toEqual([]);
  });

  it("enforces the 8-preview limit and allows an upsert at the limit", async () => {
    const f = fixture();
    const service = new PreviewService();
    const opts = options(service, runningManager());

    for (let index = 0; index < 8; index += 1) {
      const result = await callTool(f, APP_A, "preview_open", openArgs(`preview-${index}`), opts);
      expect(result.ok).toBe(true);
    }

    const ninth = await callTool(f, APP_A, "preview_open", openArgs("nine"), opts);
    expect(ninth).toMatchObject({ ok: false, code: "preview_limit" });
    expect(service.list("p:a")).toHaveLength(8);

    const upsert = await callTool(
      f,
      APP_A,
      "preview_open",
      openArgs("preview-0", { name: "Updated", port: 5000 }),
      opts,
    );
    expect(upsert.ok).toBe(true);
    expect(upsert.preview).toMatchObject({ key: "preview-0", name: "Updated", port: 5000 });
    expect(service.list("p:a")).toHaveLength(8);
  });
});

describe("preview_close and preview_list isolation", () => {
  it("returns preview_unavailable without the preview service or the manager", async () => {
    const f = fixture();
    const missingPreviews = await callTool(
      f,
      APP_A,
      "preview_open",
      openArgs("web"),
      options(undefined, runningManager()),
    );
    expect(missingPreviews).toEqual({
      ok: false,
      code: "preview_unavailable",
      message: "previews are not configured",
    });

    const service = new PreviewService();
    const missingManager = await callTool(
      f,
      APP_A,
      "preview_open",
      openArgs("web"),
      options(service),
    );
    expect(missingManager).toEqual({
      ok: false,
      code: "preview_unavailable",
      message: "previews are not configured",
    });
    expect(service.list("p:a")).toEqual([]);
  });

  it("closes idempotently and rejects an invalid key", async () => {
    const f = fixture();
    const service = new PreviewService();
    const opts = options(service, runningManager());
    await callTool(f, APP_A, "preview_open", openArgs("web"), opts);

    expect(await callTool(f, APP_A, "preview_close", { key: "web" }, opts)).toEqual({
      ok: true,
      closed: true,
    });
    expect(await callTool(f, APP_A, "preview_close", { key: "web" }, opts)).toEqual({
      ok: true,
      closed: false,
    });
    expect(await callTool(f, APP_A, "preview_close", { key: "Upper" }, opts)).toMatchObject({
      ok: false,
      code: "preview_invalid_key",
    });
    await callTool(f, APP_A, "preview_open", openArgs("web"), opts);
    expect(await callTool(f, APP_A, "preview_close", { key: "web/" }, opts)).toMatchObject({
      ok: false,
      code: "preview_invalid_key",
    });
    expect(service.get("p:a", "web")).toBeDefined();
  });

  it("isolates previews by the agent token app", async () => {
    const f = fixture();
    const service = new PreviewService();
    const opts = options(service, runningManager());
    await callTool(f, APP_A, "preview_open", openArgs("web"), opts);

    const listB = await callTool(f, APP_B, "preview_list", {}, opts);
    expect(listB).toEqual({ ok: true, previews: [] });

    const closeB = await callTool(f, APP_B, "preview_close", { key: "web" }, opts);
    expect(closeB).toEqual({ ok: true, closed: false });
    expect(service.get("p:a", "web")?.name).toBe("Storefront");
  });

  it("lists previews newest first with both base spellings", async () => {
    const f = fixture();
    const { service, advance } = clockedService();
    const opts = options(service, runningManager());

    await callTool(f, APP_A, "preview_open", openArgs("alpha"), opts);
    advance(1000);
    await callTool(f, APP_A, "preview_open", openArgs("beta"), opts);
    advance(1000);
    await callTool(f, APP_A, "preview_open", openArgs("gamma"), opts);

    const result = await callTool(f, APP_A, "preview_list", {}, opts);
    expect(result).toMatchObject({
      ok: true,
      previews: [
        {
          key: "gamma",
          name: "Storefront",
          port: 3000,
          url: "/preview/p/a/gamma/",
          base_path: "/preview/p/a/gamma/",
          base_path_without_trailing_slash: "/preview/p/a/gamma",
          expires_at: new Date(START + 2000 + 2 * HOUR).toISOString(),
        },
        {
          key: "beta",
          url: "/preview/p/a/beta/",
          base_path: "/preview/p/a/beta/",
          base_path_without_trailing_slash: "/preview/p/a/beta",
        },
        { key: "alpha", url: "/preview/p/a/alpha/" },
      ],
    });
  });
});
