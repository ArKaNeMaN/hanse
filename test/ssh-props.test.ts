import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { buildSite } from "../src/http/dashboard.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { buildSshProps, resolveSshScope } from "../src/http/props/ssh.js";
import { handleUiApi, maybeServeSpa } from "../src/http/spa.js";
import { handleSsh } from "../src/http/ssh.js";
import { upsertPrincipalWithToken } from "../src/identity/principals.js";
import { mintAgentToken } from "../src/mcp/agent-tokens.js";
import { ROUTES } from "../src/shared/routes.js";
import { SshService } from "../src/ssh/service.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];
const originalLegacy = process.env.HANSE_UI_LEGACY;
const originalAllowlist = process.env.HANSE_UI_SPA_ROUTES;
const originalDevUrl = process.env.HANSE_UI_DEV_URL;

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalLegacy === undefined) delete process.env.HANSE_UI_LEGACY;
  else process.env.HANSE_UI_LEGACY = originalLegacy;
  if (originalAllowlist === undefined) delete process.env.HANSE_UI_SPA_ROUTES;
  else process.env.HANSE_UI_SPA_ROUTES = originalAllowlist;
  if (originalDevUrl === undefined) delete process.env.HANSE_UI_DEV_URL;
  else process.env.HANSE_UI_DEV_URL = originalDevUrl;
});

interface Fixture {
  deps: HttpDeps;
  db: SqliteDatabase;
  ssh: SshService;
  hostId: string;
  privateKey: string;
  humanToken: string;
  agentToken: string;
  cipher: string;
  nonce: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ssh-props-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  mkdirSync(path.join(workspace, "p", "apps", "a"), { recursive: true });
  const db = openDatabase(":memory:");
  dbs.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Alpha','main',?,?,?)",
  ).run(path.join(workspace, "p"), now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:a','p','a','apps/a','app','AGENTS.md',?)",
  ).run(now);
  upsertPrincipalWithToken(db, { kind: "human", name: "op", token: "op-token" });
  const keyFile = path.join(dir, "id");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyFile, "-q"]);
  const ssh = new SshService({
    db,
    secretKey: Buffer.alloc(32, 9),
    workspaceRoot: workspace,
    agentsHome: path.join(dir, "agents"),
  });
  const host = ssh.createHost(
    {
      name: "deploy-host",
      address: "127.0.0.1",
      username: "deploy",
      privateKey: readFileSync(keyFile, "utf8"),
      requireApproval: true,
    },
    "op",
  );
  ssh.replaceAppHosts("p:a", [host.id], "op");
  const requested = "2026-01-02T11:58:00.000Z";
  const expires = "2099-01-02T12:03:00.000Z";
  db.prepare(
    "INSERT INTO ssh_approvals (id,app_id,host_id,action,command_hash,command_preview,command_bytes,status,requested_at,expires_at) VALUES ('approval-1','p:a',?,'exec','hash-1','uptime',6,'pending',?,?)",
  ).run(host.id, requested, expires);
  db.prepare(
    "INSERT INTO ssh_grants (id,app_id,host_id,approval_id,granted_by,granted_at,last_used_at,idle_expires_at,absolute_expires_at,revoked_at) VALUES ('grant-1','p:a',?,'approval-1','op',?,?,?,?,NULL)",
  ).run(host.id, requested, requested, expires, "2099-01-02T19:58:00.000Z");
  db.prepare(
    "INSERT INTO ssh_audit (app_id,project_id,app_key,host_id,host_name,address,username,action,command_preview,started_at,finished_at,exit_code,error_code) VALUES ('p:a','p','a',?,'deploy-host','127.0.0.1','deploy','exec','uptime',?,?,0,NULL)",
  ).run(host.id, requested, expires);
  const credential = db
    .prepare("SELECT cipher, nonce FROM ssh_host_credentials WHERE host_id = ?")
    .get(host.id) as { cipher: string; nonce: string };
  const deps: HttpDeps = {
    db,
    workspaceRoot: workspace,
    getProjects: () => [
      {
        id: "p",
        name: "Alpha",
        rootPath: path.join(workspace, "p"),
        workspaceRoot: workspace,
        service: new CoordinatorService(db, "p"),
      },
    ],
    git: new GitService({ workspaceRoot: workspace }),
    ssh,
  };
  return {
    deps,
    db,
    ssh,
    hostId: host.id,
    privateKey: readFileSync(keyFile, "utf8"),
    humanToken: "op-token",
    agentToken: mintAgentToken(db, "p:a"),
    cipher: credential.cipher,
    nonce: credential.nonce,
  };
}

function cookie(token: string): Record<string, string> {
  return { cookie: `hanse_token=${encodeURIComponent(token)}` };
}

function request(
  pathname: string,
  headers: Record<string, string>,
  query?: Record<string, string>,
): HttpRequest {
  return { method: "GET", path: pathname, headers, ...(query === undefined ? {} : { query }) };
}

interface SshApiPayload {
  scope: {
    scoped: boolean;
    projectId: string;
    appKey: string;
    href: string;
    options: readonly unknown[];
  };
  hosts: Array<{
    id: string;
    name: string;
    pinState: string;
    allowed: boolean;
    actions: {
      api: { host: string; test: string; update: string; delete: string; rePin: string };
      form: { test: string; update: string; delete: string; rePin: string };
    };
    credential: { publicKey: string; fingerprint: string } | null;
  }>;
  grants: Array<{
    hostName: string;
    state: string;
    actions: { api: { revoke: string }; form: { revoke: string } };
  }>;
  approvals: Array<{
    hostName: string;
    commandPreview: string;
    actions: {
      api: { approve: string; reject: string };
      form: { approve: string; reject: string };
      returnTo: string;
    };
  }>;
  audit: Array<{ hostName: string; outcome: string; commandPreview: string | null }>;
  counts: {
    hosts: number;
    pendingApprovals: number;
    activeGrants: number;
    allowedHosts: number;
    auditRows: number;
  };
  actions: {
    createHost: string;
    saveGrants: string | null;
    form: { createHost: string; saveGrants: string };
    api: { appApprovals: string | null };
  };
  policy: { idleOptions: readonly number[]; auditLimit: number };
  labels: { title: string; actions: { addHost: string } };
  chrome: { title: string; active: string };
}

function payload(response: ReturnType<typeof handleUiApi>): SshApiPayload {
  return JSON.parse(response?.body ?? "{}") as SshApiPayload;
}

function enableSshRoute(): void {
  delete process.env.HANSE_UI_LEGACY;
  process.env.HANSE_UI_SPA_ROUTES = ROUTES.map((route) => route.id).join(",");
  process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
}

function assertNoKeyMaterial(body: string, f: Fixture): void {
  expect(body).not.toContain(f.privateKey);
  expect(body).not.toContain("PRIVATE KEY");
  expect(body).not.toContain(f.cipher);
  expect(body).not.toContain(f.nonce);
}

describe("SSH page props", () => {
  it("assembles hosts, grants, approvals, audit, actions, and counts without key material", () => {
    const f = fixture();
    const site = buildSite(f.deps);
    const scope = resolveSshScope(f.deps, { target: "p:a" });
    const props = buildSshProps({ ssh: f.ssh, site, scope });

    expect(props.scope).toMatchObject({
      scoped: true,
      projectId: "p",
      appKey: "a",
      href: "/ssh?target=p%3Aa",
      hostsHref: "/ssh?target=p%3Aa#ssh-hosts",
      accessHref: "/ssh?target=p%3Aa#ssh-access",
      approvalsHref: "/ssh?target=p%3Aa#ssh-approvals",
      auditHref: "/ssh?target=p%3Aa#ssh-audit",
    });
    expect(props.scope.options).toEqual([
      expect.objectContaining({
        label: "Alpha",
        options: [expect.objectContaining({ value: "p:a", selected: true })],
      }),
    ]);
    expect(props.hosts[0]).toMatchObject({
      id: f.hostId,
      name: "deploy-host",
      address: "127.0.0.1",
      username: "deploy",
      port: 22,
      requireApproval: true,
      pinState: "unpinned",
      status: "unpinned",
      allowed: true,
      pendingApprovals: 1,
      actions: {
        api: {
          host: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}`,
          test: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}/test`,
          update: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}`,
          delete: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}`,
          rePin: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}/re-pin`,
        },
        form: {
          test: `/ssh/hosts/${encodeURIComponent(f.hostId)}/test`,
          rePin: `/ssh/hosts/${encodeURIComponent(f.hostId)}/re-pin`,
          update: `/ssh/hosts/${encodeURIComponent(f.hostId)}/update`,
          delete: `/ssh/hosts/${encodeURIComponent(f.hostId)}/delete`,
        },
      },
    });
    expect(props.hosts[0]?.credential?.publicKey).toContain("ssh-ed25519");
    expect(props.grants[0]).toMatchObject({
      id: "grant-1",
      hostId: f.hostId,
      hostName: "deploy-host",
      appKey: "a",
      projectId: "p",
      state: "active",
      canRevoke: true,
      actions: {
        api: { revoke: "/api/projects/p/apps/a/ssh/grants/grant-1/revoke" },
        form: { revoke: "/ssh/grants/grant-1/revoke" },
      },
    });
    expect(props.approvals[0]).toMatchObject({
      id: "approval-1",
      hostName: "deploy-host",
      appKey: "a",
      action: "exec",
      commandPreview: "uptime",
      actions: {
        api: {
          approve: "/api/apps/a/ssh/approvals/approval-1/decision?project=p",
          reject: "/api/apps/a/ssh/approvals/approval-1/decision?project=p",
        },
        form: {
          approve: "/ssh/approvals/approval-1/decision",
          reject: "/ssh/approvals/approval-1/decision",
        },
        returnTo: props.scope.approvalsHref,
      },
    });
    expect(props.audit[0]).toMatchObject({
      hostName: "deploy-host",
      action: "exec",
      outcome: "ok",
      commandPreview: "uptime",
    });
    expect(props.counts).toEqual({
      hosts: 1,
      pinned: 0,
      unpinned: 1,
      mismatch: 0,
      pendingApprovals: 1,
      activeGrants: 1,
      grants: 1,
      allowedHosts: 1,
      auditRows: 1,
    });
    expect(props.actions).toMatchObject({
      createHost: "/api/ssh/hosts",
      saveGrants: "/api/projects/p/apps/a/ssh",
      form: { createHost: "/ssh/hosts", saveGrants: "/ssh/grants" },
      api: {
        hosts: "/api/ssh/hosts",
        approvalsCount: "/api/ssh/approvals/count",
        appApprovals: "/api/apps/a/ssh/approvals?project=p",
        audit: "/api/apps/a/ssh/audit?project=p",
        grants: "/api/projects/p/apps/a/ssh",
      },
    });
    expect(props.policy).toMatchObject({
      idleOptions: [300, 900, 1800, 3600, 7200],
      auditLimit: 30,
    });
    expect(props.labels.title).toBe("SSH hosts");

    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain(f.privateKey);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain(f.cipher);
    expect(serialized).not.toContain(f.nonce);
  });

  it("keeps the legacy page renderer consuming props and hiding key material", async () => {
    const f = fixture();
    const page = await handleSsh(f.deps, {
      method: "GET",
      path: "/ssh",
      headers: { ...cookie(f.humanToken), accept: "text/html" },
      query: { target: "p:a" },
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("SSH hosts");
    expect(page.body).toContain(`id="ssh-host-${f.hostId}"`);
    expect(page.body).toContain(`/ssh/hosts/${f.hostId}/test`);
    expect(page.body).toContain("/ssh/approvals/approval-1/decision");
    expect(page.body).not.toContain("PRIVATE KEY");
    assertNoKeyMaterial(page.body, f);
  });
});

describe("GET /api/ui/ssh", () => {
  it("is cookie-only: 401 anonymous, 403 human bearer, 403 agent token", () => {
    const f = fixture();
    const anonymous = handleUiApi(f.deps, request("/api/ui/ssh", {}));
    expect(anonymous?.status).toBe(401);
    expect(anonymous?.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(anonymous?.body ?? "{}")).toEqual({
      error: "sign in required",
      code: "unauthenticated",
    });

    const bearer = handleUiApi(
      f.deps,
      request("/api/ui/ssh", { authorization: `Bearer ${f.humanToken}` }),
    );
    expect(bearer?.status).toBe(403);
    expect(JSON.parse(bearer?.body ?? "{}")).toEqual({
      error: "cookie sign-in required",
      code: "cookie_required",
    });

    const agent = handleUiApi(
      f.deps,
      request("/api/ui/ssh", { authorization: `Bearer ${f.agentToken}` }),
    );
    expect(agent?.status).toBe(403);
    expect(JSON.parse(agent?.body ?? "{}")).toEqual({
      error: "agent tokens may only call the MCP endpoint",
    });
  });

  it("returns SSH props plus chrome, action URLs, and no secrets", () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/ssh", cookie(f.humanToken), { target: "p:a" }),
    );
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    const data = payload(response);
    expect(data.scope).toMatchObject({ scoped: true, projectId: "p", appKey: "a" });
    expect(data.hosts).toEqual([
      expect.objectContaining({
        id: f.hostId,
        name: "deploy-host",
        pinState: "unpinned",
        actions: expect.objectContaining({
          api: expect.objectContaining({
            test: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}/test`,
            update: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}`,
            delete: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}`,
            rePin: `/api/ssh/hosts/${encodeURIComponent(f.hostId)}/re-pin`,
          }),
          form: expect.objectContaining({
            test: `/ssh/hosts/${encodeURIComponent(f.hostId)}/test`,
          }),
        }),
      }),
    ]);
    expect(data.grants[0]).toMatchObject({ id: "grant-1", state: "active" });
    expect(data.approvals[0]).toMatchObject({ id: "approval-1", commandPreview: "uptime" });
    expect(data.audit[0]).toMatchObject({ action: "exec", outcome: "ok" });
    expect(data.counts).toMatchObject({
      hosts: 1,
      pendingApprovals: 1,
      activeGrants: 1,
      allowedHosts: 1,
      auditRows: 1,
    });
    expect(data.actions.createHost).toBe("/api/ssh/hosts");
    expect(data.actions.api.appApprovals).toBe("/api/apps/a/ssh/approvals?project=p");
    expect(data.policy.idleOptions).toEqual([300, 900, 1800, 3600, 7200]);
    expect(data.labels.actions.addHost).toBe("Add host");
    expect(data.chrome).toMatchObject({ title: "SSH", active: "ssh" });
    assertNoKeyMaterial(response?.body ?? "", f);
  });

  it("returns the unscoped console when no target is selected", () => {
    const f = fixture();
    const response = handleUiApi(f.deps, request("/api/ui/ssh", cookie(f.humanToken)));
    expect(response?.status).toBe(200);
    const data = payload(response);
    expect(data.scope).toMatchObject({ scoped: false, projectId: "", appKey: "" });
    expect(data.hosts).toHaveLength(1);
    expect(data.hosts[0]?.allowed).toBe(false);
    expect(data.approvals).toHaveLength(1);
    expect(data.actions.api.appApprovals).toBeNull();
  });
});

describe("SSH route boot", () => {
  it("boots SSH page props for an enabled document", () => {
    const f = fixture();
    const sshRoute = ROUTES.find((route) => route.id === "ssh");
    expect(sshRoute?.spa).toBe(true);
    enableSshRoute();
    const response = maybeServeSpa(
      f.deps,
      request("/ssh", { ...cookie(f.humanToken), accept: "text/html" }, { target: "p:a" }),
    );
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    const match = /<script id="hanse-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(
      response?.body ?? "",
    );
    const boot = JSON.parse(match?.[1] ?? "{}") as {
      route: { id: string };
      props: SshApiPayload;
      chrome: { title: string; active: string };
    };
    expect(boot.route.id).toBe("ssh");
    expect(boot.props.hosts[0]).toMatchObject({ id: f.hostId, name: "deploy-host" });
    expect(boot.props.counts).toMatchObject({ hosts: 1, pendingApprovals: 1 });
    expect(boot.chrome).toMatchObject({ title: "SSH", active: "ssh" });
    expect(response?.body).not.toContain(f.privateKey);
    expect(response?.body).not.toContain("PRIVATE KEY");
    expect(response?.body).not.toContain(f.cipher);
    expect(response?.body).not.toContain(f.nonce);
  });
});
