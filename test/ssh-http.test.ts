import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { handleSsh } from "../src/http/ssh.js";
import { upsertPrincipalWithToken } from "../src/identity/principals.js";
import { mintAgentToken } from "../src/mcp/agent-tokens.js";
import { SshService } from "../src/ssh/service.js";
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

function fixture(): { deps: HttpDeps; service: SshService; privateKey: string; token: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ssh-http-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  const appDir = path.join(workspace, "p", "apps", "a");
  mkdirSync(appDir, { recursive: true });
  const db = openDatabase(":memory:");
  dbs.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(path.join(workspace, "p"), now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  upsertPrincipalWithToken(db, { kind: "human", name: "op", token: "op-token" });
  const keyFile = path.join(dir, "id");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyFile, "-q"]);
  const service = new SshService({
    db,
    secretKey: Buffer.alloc(32, 9),
    workspaceRoot: workspace,
    agentsHome: path.join(dir, "agents"),
  });
  const deps: HttpDeps = {
    db,
    workspaceRoot: workspace,
    getProjects: () => [
      {
        id: "p",
        name: "P",
        rootPath: path.join(workspace, "p"),
        workspaceRoot: workspace,
        service: new CoordinatorService(db, "p"),
      },
    ],
    git: new GitService({ workspaceRoot: workspace }),
    ssh: service,
  };
  return {
    deps,
    service,
    privateKey: readFileSync(keyFile, "utf8"),
    token: mintAgentToken(db, "p:a"),
  };
}

const human = { cookie: "hanse_token=op-token" };
const agent = (token: string) => ({ authorization: `Bearer ${token}` });

describe("SSH HTTP surface", () => {
  it("is human-only, renders the page, and never returns key material", async () => {
    const f = fixture();
    const created = await handleSsh(f.deps, {
      method: "POST",
      path: "/api/ssh/hosts",
      headers: human,
      body: JSON.stringify({
        name: "h",
        address: "127.0.0.1",
        username: "deploy",
        privateKey: f.privateKey,
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body).not.toContain("PRIVATE KEY");
    expect(created.body).not.toContain("cipher");
    const page = await handleSsh(f.deps, {
      method: "GET",
      path: "/ssh",
      headers: { ...human, accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("SSH hosts");
    expect(page.body).not.toContain("PRIVATE KEY");
    const anonymous = await handleSsh(f.deps, {
      method: "GET",
      path: "/ssh",
      headers: { accept: "text/html" },
      query: {},
    });
    expect(anonymous.status).toBe(303);
    const agentResponse = await handleSsh(f.deps, {
      method: "GET",
      path: "/api/ssh/hosts",
      headers: agent(f.token),
    });
    expect(agentResponse.status).toBe(403);
  });

  it("serves host, grant, approval, audit, and count routes", async () => {
    const f = fixture();
    const created = await handleSsh(f.deps, {
      method: "POST",
      path: "/api/ssh/hosts",
      headers: human,
      body: JSON.stringify({
        name: "h",
        address: "127.0.0.1",
        username: "deploy",
        privateKey: f.privateKey,
      }),
    });
    const hostId = (JSON.parse(created.body) as { host: { id: string } }).host.id;
    expect(
      (await handleSsh(f.deps, { method: "GET", path: "/api/ssh/hosts", headers: human })).status,
    ).toBe(200);
    expect(
      (await handleSsh(f.deps, { method: "GET", path: "/api/ssh/approvals/count", headers: human }))
        .status,
    ).toBe(200);
    expect(
      (
        await handleSsh(f.deps, {
          method: "GET",
          path: "/api/apps/a/ssh/approvals",
          headers: human,
          query: { project: "p" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await handleSsh(f.deps, {
          method: "GET",
          path: "/api/apps/a/ssh/audit",
          headers: human,
          query: { project: "p" },
        })
      ).status,
    ).toBe(200);
    const grants = await handleSsh(f.deps, {
      method: "POST",
      path: "/api/projects/p/apps/a/ssh",
      headers: human,
      body: JSON.stringify({ hostIds: [hostId] }),
    });
    expect(grants.status).toBe(200);
    const list = await handleSsh(f.deps, {
      method: "GET",
      path: "/api/projects/p/apps/a/ssh",
      headers: human,
    });
    expect(list.status).toBe(200);
    expect(list.body).toContain(hostId);
  });
});
