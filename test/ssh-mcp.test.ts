import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { handleRpcAsync } from "../src/mcp/ssh-protocol.js";
import type { SshService } from "../src/ssh/service.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): {
  db: SqliteDatabase;
  service: CoordinatorService;
  agent: { appId: string; projectId: string; appKey: string };
} {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ssh-mcp-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  dbs.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  return {
    db,
    service: new CoordinatorService(db, "p"),
    agent: { appId: "p:a", projectId: "p", appKey: "a" },
  };
}

function text(response: { result?: unknown }): unknown {
  const result = response.result as { content: { text: string }[] } | undefined;
  return JSON.parse(result?.content[0]?.text ?? "{}");
}

describe("SSH MCP tools", () => {
  it("lists SSH tools and dispatches list/exec while delegating base tools", async () => {
    const f = fixture();
    const ssh = {
      listHosts: () => [{ id: "h", name: "host", allowed: true }],
      exec: async () => ({
        ok: false,
        code: "ssh_approval_pending",
        approval_id: "a1",
        expires_at: "later",
        message: "wait",
      }),
    } as unknown as SshService;
    const list = await handleRpcAsync(f.service, ssh, f.agent, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    if (list === undefined) throw new Error("tools/list returned no response");
    const tools = (list.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(tools).toContain("ssh_list_hosts");
    expect(tools).toContain("ssh_exec");
    expect(tools).toContain("ssh_upload");
    expect(tools).toContain("ssh_download");
    expect(tools).toContain("list_apps");

    const listed = await handleRpcAsync(f.service, ssh, f.agent, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ssh_list_hosts", arguments: {} },
    });
    expect(text(listed)).toEqual([{ id: "h", name: "host", allowed: true }]);

    const executed = await handleRpcAsync(f.service, ssh, f.agent, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ssh_exec", arguments: { host_id: "h", command: "true" } },
    });
    expect(text(executed)).toMatchObject({ ok: false, code: "ssh_approval_pending" });

    const base = await handleRpcAsync(f.service, ssh, f.agent, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_apps", arguments: {} },
    });
    expect(text(base)).toMatchObject({ apps: [{ appKey: "a" }] });
  });

  it("returns ssh_unavailable when the service is not wired", async () => {
    const f = fixture();
    const response = await handleRpcAsync(f.service, undefined, f.agent, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ssh_list_hosts", arguments: {} },
    });
    expect(text(response)).toMatchObject({ ok: false, code: "ssh_unavailable" });
  });
});
