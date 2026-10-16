import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { handleRpc } from "../src/mcp/protocol.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): CoordinatorService {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-mcp-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/x',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:b','p','b','apps/b','AGENTS.md',?)",
  ).run(now);
  return new CoordinatorService(db, "p");
}

function toolText(response: ReturnType<typeof handleRpc>): unknown {
  const result = (response as { result: { content: { text: string }[] } }).result;
  return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("mcp protocol", () => {
  it("initializes", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(
      (response as { result: { protocolVersion: string } }).result.protocolVersion,
    ).toBeTruthy();
  });

  it("lists tools", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (response as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toContain("request_sibling_change");
  });

  it("calls request_sibling_change and handoff_status", () => {
    const service = fixture();
    const request = handleRpc(service, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "request_sibling_change",
        arguments: { from: "a", to: "b", summary: "s", spec: "x" },
      },
    });
    const { handoffId } = toolText(request) as { handoffId: string };
    expect(handoffId).toBeTruthy();
    const status = handleRpc(service, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "handoff_status", arguments: { id: handoffId } },
    });
    expect((toolText(status) as { handoff: { id: string } }).handoff.id).toBe(handoffId);
  });

  it("ignores notifications", () => {
    const service = fixture();
    expect(
      handleRpc(service, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
  });

  it("returns an error for unknown methods", () => {
    const service = fixture();
    const response = handleRpc(service, { jsonrpc: "2.0", id: 9, method: "nope" });
    expect((response as { error?: { code: number } }).error?.code).toBe(-32601);
  });
});
