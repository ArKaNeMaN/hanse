import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import type { RunSshKeygen } from "../src/git/credentials.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { handleSettings, isSettingsRoute } from "../src/http/settings.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  settings: SettingsService;
  token: string;
  agentToken: string;
  dir: string;
}

const VALID_SSH_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nsentinel-private-body\n-----END OPENSSH PRIVATE KEY-----\n";

function fakeSshKeygen(): RunSshKeygen {
  return (args) => {
    if (args[0] === "-y") {
      return { status: 0, stdout: "ssh-ed25519 AAAAC3NzaFake fake@test\n", stderr: "" };
    }
    if (args[0] === "-lf") {
      return { status: 0, stdout: "256 SHA256:fakefingerprint fake@test (ED25519)\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function fixture(
  options: { hostAuth?: Record<string, unknown>; runSshKeygen?: RunSshKeygen } = {},
): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-settings-http-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Alpha','main','/tmp/p1',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p1:web','p1','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p1:api','p1','api','apps/api','app','AGENTS.md',?)",
  ).run(now);

  let hostAuthFile: string | undefined;
  if (options.hostAuth !== undefined) {
    hostAuthFile = path.join(dir, "host-auth.json");
    writeFileSync(hostAuthFile, JSON.stringify(options.hostAuth));
  }
  const settings = new SettingsService({
    db,
    secretKey: randomBytes(32),
    hostAuthFile,
    runSshKeygen: options.runSshKeygen,
  });
  const token = createPrincipal(db, { kind: "human", name: "alice" }).token;
  const agent = createPrincipal(db, { kind: "agent", name: "bot" });
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    settings,
    getProjects: () => {
      const row = db.prepare("SELECT name, root_path FROM projects WHERE id = 'p1'").get() as
        | { name: string; root_path: string }
        | undefined;
      return [
        {
          id: "p1",
          name: row?.name ?? "Alpha",
          rootPath: row?.root_path ?? "/tmp/p1",
          workspaceRoot: "/tmp",
          service: new CoordinatorService(db, "p1"),
        },
      ];
    },
  };
  return { db, deps, settings, token, agentToken: agent.token, dir };
}

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function htmlAuth(token: string): Record<string, string> {
  return auth(token, { accept: "text/html" });
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", path: "/api/settings", headers: {}, query: {}, ...overrides };
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function fakeManager(
  options: { pending?: (appId: string) => boolean; stop?: (appId: string) => boolean } = {},
): InstanceManager & { stopped: string[] } {
  const stopped: string[] = [];
  const manager = {
    stopped,
    pendingRestart: (appId: string) => {
      const pending = options.pending?.(appId) ?? false;
      return pending
        ? { pending: true, reasons: ["settings_changed"] }
        : { pending: false, reasons: [] };
    },
    stopApp: async (appId: string) => {
      stopped.push(appId);
      return options.stop?.(appId) ?? false;
    },
  };
  return manager as unknown as InstanceManager & { stopped: string[] };
}

describe("settings route auth", () => {
  it("rejects unauthenticated and agent API callers", async () => {
    const f = fixture();
    const anonymous = await handleSettings(f.deps, request());
    expect(anonymous.status).toBe(401);
    expect(anonymous.contentType).toContain("application/json");
    expect(anonymous.headers?.["cache-control"]).toBe("no-store");

    const agent = await handleSettings(f.deps, request({ headers: auth(f.agentToken) }));
    expect(agent.status).toBe(403);
  });

  it("redirects unauthenticated and agent HTML callers to login", async () => {
    const f = fixture();
    const anonymous = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth("") }),
    );
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers?.location).toBe("/login?next=%2Fsettings");

    const agent = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.agentToken) }),
    );
    expect(agent.status).toBe(303);
    expect(agent.headers?.location).toBe("/login?next=%2Fsettings");
  });

  it("rejects oversized bodies with the existing 413 response", async () => {
    const f = fixture();
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { ...auth(f.token), "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        key: "llm.model",
        action: "set",
        value: "a/b",
      }).padEnd(70 * 1024, " "),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large" });
  });

  it("returns 503 when settings are not configured", async () => {
    const f = fixture();
    delete (f.deps as { settings?: SettingsService }).settings;
    const response = await handleSettings(f.deps, request({ headers: auth(f.token) }));
    expect(response.status).toBe(503);
  });
});

describe("settings API reads", () => {
  it("returns defaults for global, project, and app scopes", async () => {
    const f = fixture();
    for (const query of [
      { scope: "global" },
      { scope: "project", project: "p1" },
      { scope: "app", project: "p1", app: "web" },
    ]) {
      const response = await handleSettings(f.deps, request({ headers: auth(f.token), query }));
      expect(response.status).toBe(200);
      const payload = JSON.parse(response.body) as {
        effective: { llm: { model: { value: string } } };
        pendingRestart: unknown[];
      };
      expect(payload.effective.llm.model.value).toBe("deepseek/deepseek-flash");
      expect(payload.pendingRestart).toEqual([]);
    }
  });

  it("reports the narrowest source and raw scoped rows", async () => {
    const f = fixture();
    f.settings.set("global", {}, "llm.model", "global/model", "owner");
    f.settings.set("project", { projectId: "p1" }, "llm.model", "project/model", "owner");
    f.settings.set("app", { projectId: "p1", appKey: "web" }, "llm.model", "app/model", "owner");
    const response = await handleSettings(
      f.deps,
      request({
        headers: auth(f.token),
        query: { scope: "app", project: "p1", app: "web" },
      }),
    );
    const payload = JSON.parse(response.body) as {
      effective: { llm: { model: { value: string; source: string } } };
      scoped: Record<string, { state: string }>;
    };
    expect(payload.effective.llm.model).toMatchObject({
      value: "app/model",
      source: "app",
    });
    expect(payload.scoped["global:llm.model"]).toEqual({
      state: "set",
      value: "global/model",
    });
    expect(payload.scoped["project:llm.model"]).toEqual({
      state: "set",
      value: "project/model",
    });
    expect(payload.scoped["app:llm.model"]).toEqual({ state: "set", value: "app/model" });
  });

  it("rejects invalid scope and target combinations", async () => {
    const f = fixture();
    const missingScope = await handleSettings(
      f.deps,
      request({ headers: auth(f.token), query: {} }),
    );
    expect(missingScope.status).toBe(400);

    const projectWithoutId = await handleSettings(
      f.deps,
      request({ headers: auth(f.token), query: { scope: "project" } }),
    );
    expect(projectWithoutId.status).toBe(400);
  });
});

describe("settings mutations", () => {
  it("sets, inherits, and clears settings from form submissions", async () => {
    const f = fixture();
    const set = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({ scope: "global", key: "llm.model", action: "set", value: "acme/model" }),
      }),
    );
    expect(set.status).toBe(200);
    expect(f.settings.resolve({}).effective.llm.model.value).toBe("acme/model");

    const inherit = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({ scope: "global", key: "llm.model", action: "inherit" }),
      }),
    );
    expect(inherit.status).toBe(200);
    expect(f.settings.resolve({}).effective.llm.model.state).toBe("default");

    const clear = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({ scope: "global", key: "web.search", action: "clear" }),
      }),
    );
    expect(clear.status).toBe(200);
    const resolved = f.settings.resolve({});
    expect(resolved.effective.web.search).toMatchObject({ value: null, state: "cleared" });
    const row = f.db
      .prepare("SELECT value_json FROM settings WHERE scope='global' AND key='web.search'")
      .get() as { value_json: string };
    expect(row.value_json).toBe("null");
  });

  it("rejects clearing llm.model", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token),
        body: JSON.stringify({ scope: "global", key: "llm.model", action: "clear" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toContain("not clearable");
  });

  it("accepts strict JSON values and rejects arrays, prototype keys, and bad numbers", async () => {
    const f = fixture();
    const set = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "app",
          projectId: "p1",
          appKey: "web",
          key: "web.search",
          action: "set",
          value: {
            driver: "deepseek",
            options: { provider: "deepseek", count: 5, needContent: true },
          },
        }),
      }),
    );
    expect(set.status).toBe(200);
    expect(
      f.settings.resolve({ projectId: "p1", appKey: "web" }).effective.web.search.value,
    ).toEqual({
      driver: "deepseek",
      options: { provider: "deepseek", count: 5, needContent: true },
    });

    const array = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          key: "web.search",
          action: "set",
          value: ["builtin"],
        }),
      }),
    );
    expect(array.status).toBe(400);

    const prototype = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: '{"__proto__":{"polluted":true},"scope":"global","key":"llm.model","action":"set","value":"a/b"}',
      }),
    );
    expect(prototype.status).toBe(400);

    const badNumber = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          key: "web.search",
          action: "set",
          value: { driver: "deepseek", options: { provider: "deepseek", count: 999 } },
        }),
      }),
    );
    expect(badNumber.status).toBe(400);
  });

  it("builds web driver values from form fields", async () => {
    const f = fixture();
    const deepseek = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({
          scope: "global",
          key: "web.search",
          action: "set",
          driver: "deepseek",
          provider: "deepseek",
          count: "5",
          needContent: "1",
          timeoutMs: "5000",
          maxContentChars: "2048",
        }),
      }),
    );
    expect(deepseek.status).toBe(200);
    expect(f.settings.resolve({}).effective.web.search.value).toEqual({
      driver: "deepseek",
      options: {
        provider: "deepseek",
        count: 5,
        needContent: true,
        timeoutMs: 5000,
        maxContentChars: 2048,
      },
    });

    const builtin = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({
          scope: "global",
          key: "web.fetch",
          action: "set",
          driver: "builtin",
          provider: "ignored",
          count: "not-a-number",
        }),
      }),
    );
    expect(builtin.status).toBe(200);
    expect(f.settings.resolve({}).effective.web.fetch.value).toEqual({ driver: "builtin" });

    const invalid = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({
          scope: "global",
          key: "web.search",
          action: "set",
          driver: "deepseek",
          provider: "deepseek",
          count: "not-a-number",
        }),
      }),
    );
    expect(invalid.status).toBe(400);
  });

  it("redirects browser mutations with a notice", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: htmlAuth(f.token),
        body: form({
          scope: "global",
          key: "llm.model",
          action: "set",
          value: "acme/model",
          return_to: "/settings",
        }),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("/settings?");
    expect(response.headers?.location).toContain("notice=Settings+saved.");
    expect(f.settings.resolve({}).effective.llm.model.value).toBe("acme/model");
  });

  it("rejects malformed and oversized form bodies without poisoning the object prototype", async () => {
    const f = fixture();
    const malformed = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: "{not json",
      }),
    );
    expect(malformed.status).toBe(400);

    const prototype = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({
          scope: "global",
          key: "llm.model",
          action: "set",
          value: "a/b",
          ["__proto__"]: "x",
        }),
      }),
    );
    expect(prototype.status).toBe(400);
  });
});

describe("provider keys", () => {
  it("sets, clears, and inherits provider keys without echoing them", async () => {
    const f = fixture();
    const secret = "sk-super-secret-value";
    const set = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/provider",
        headers: auth(f.token),
        body: JSON.stringify({
          scope: "global",
          provider: "deepseek",
          action: "set",
          key: secret,
        }),
      }),
    );
    expect(set.status).toBe(200);
    expect(set.body).not.toContain(secret);
    expect(f.settings.resolve({}).providerKeys.deepseek).toEqual({
      state: "set",
      source: "global",
    });

    const read = await handleSettings(
      f.deps,
      request({ headers: auth(f.token), query: { scope: "global" } }),
    );
    expect(read.body).not.toContain(secret);
    expect(JSON.parse(read.body).providerKeys.deepseek).toEqual({
      state: "set",
      source: "global",
    });

    const clear = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/provider",
        headers: auth(f.token),
        body: form({ scope: "global", provider: "deepseek", action: "clear" }),
      }),
    );
    expect(clear.status).toBe(200);
    expect(f.settings.resolve({}).providerKeys.deepseek).toEqual({
      state: "cleared",
      source: "global",
    });

    const inherit = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/provider",
        headers: auth(f.token),
        body: form({ scope: "global", provider: "deepseek", action: "inherit" }),
      }),
    );
    expect(inherit.status).toBe(200);
    expect(f.settings.resolve({}).providerKeys.deepseek).toEqual({ state: "missing" });
  });

  it("reports host auth and never echoes the host key", async () => {
    const f = fixture({ hostAuth: { deepseek: { type: "api", key: "host-secret" } } });
    const response = await handleSettings(
      f.deps,
      request({ headers: auth(f.token), query: { scope: "global" } }),
    );
    expect(response.status).toBe(200);
    expect(response.body).not.toContain("host-secret");
    expect(JSON.parse(response.body).providerKeys.deepseek).toEqual({
      state: "host",
      source: "host-auth",
      authType: "api",
    });
  });
});

describe("settings pages and pending state", () => {
  it("renders global, project, and app pages with controls and a settings nav entry", async () => {
    const f = fixture();
    f.settings.setProviderKey("global", {}, "deepseek", "sk-page-secret", "owner");
    for (const pathname of [
      "/settings",
      "/projects/p1/settings",
      "/projects/p1/apps/web/settings",
    ]) {
      const response = await handleSettings(
        f.deps,
        request({ path: pathname, headers: htmlAuth(f.token) }),
      );
      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/html");
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(response.body).toContain('class="app-shell"');
      expect(response.body).toContain('href="/settings"');
      expect(response.body).toContain(">Model</h2>");
      expect(response.body).toContain(">Providers</h2>");
      expect(response.body).toContain(">Web search</h2>");
      expect(response.body).toContain(">Web fetch</h2>");
      expect(response.body).toContain(">Restart &amp; pending</h2>");
      expect(response.body).toContain("data-settings-driver");
      expect(response.body).toContain('autocomplete="new-password"');
      expect(response.body).toContain("/assets/settings.js");
      expect(response.body).not.toContain("sk-page-secret");
      const modelStart = response.body.indexOf('id="setting-llm-model"');
      const providersStart = response.body.indexOf('id="providers"');
      expect(modelStart).toBeGreaterThan(-1);
      expect(providersStart).toBeGreaterThan(modelStart);
      expect(response.body.slice(modelStart, providersStart)).not.toContain('value="clear"');
    }
  });

  it("shows a model provider warning when no key or host auth exists", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    expect(response.body).toContain("No provider key or host auth is configured");
    expect(response.body).toContain("existing sessions may keep their model");
  });

  it("warns that built-in search needs OMO when HANSE_OMO_PLUGIN is unset", async () => {
    const previous = process.env.HANSE_OMO_PLUGIN;
    delete process.env.HANSE_OMO_PLUGIN;
    try {
      const f = fixture();
      const response = await handleSettings(
        f.deps,
        request({ path: "/settings", headers: htmlAuth(f.token) }),
      );
      expect(response.body).toContain("Built-in search requires the OMO baseline");
    } finally {
      if (previous === undefined) delete process.env.HANSE_OMO_PLUGIN;
      else process.env.HANSE_OMO_PLUGIN = previous;
    }
  });

  it("lists pending apps with the response shape and renders a restart form", async () => {
    const f = fixture();
    f.deps.manager = fakeManager({ pending: (appId) => appId === "p1:web" });
    const response = await handleSettings(
      f.deps,
      request({
        headers: auth(f.token),
        query: { scope: "project", project: "p1" },
      }),
    );
    const payload = JSON.parse(response.body) as {
      pendingRestart: Array<{
        appId: string;
        appKey: string;
        projectId: string;
        reasons: string[];
      }>;
    };
    expect(payload.pendingRestart).toEqual([
      {
        appId: "p1:web",
        appKey: "web",
        projectId: "p1",
        reasons: ["settings_changed"],
      },
    ]);

    const page = await handleSettings(
      f.deps,
      request({ path: "/projects/p1/settings", headers: htmlAuth(f.token) }),
    );
    expect(page.body).toContain("Restart required");
    expect(page.body).toContain('action="/api/apps/web/restart?project=p1"');
  });

  it("shows profile warnings on the application settings page", async () => {
    const f = fixture();
    const manager = fakeManager();
    (manager as unknown as { profileWarnings: (appId: string) => string[] }).profileWarnings =
      () => ["omo_profile_write_failed: disk full"];
    f.deps.manager = manager;
    const response = await handleSettings(
      f.deps,
      request({ path: "/projects/p1/apps/web/settings", headers: htmlAuth(f.token) }),
    );
    expect(response.body).toContain("OMO profile warnings");
    expect(response.body).toContain("omo_profile_write_failed: disk full");
  });

  it("escapes dynamic content and returns styled 404s for unknown scopes", async () => {
    const f = fixture();
    f.db.prepare("UPDATE projects SET name = ? WHERE id = 'p1'").run('<script>alert("x")</script>');
    f.settings.setProviderKey("global", {}, "<img src=x onerror=alert(1)>", "secret", "owner");
    const page = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    expect(page.status).toBe(200);
    expect(page.body).not.toContain("<script>alert");
    expect(page.body).not.toContain("<img src=x");
    expect(page.body).toContain("&lt;script&gt;alert");

    for (const pathname of ["/projects/nope/settings", "/projects/p1/apps/nope/settings"]) {
      const response = await handleSettings(
        f.deps,
        request({ path: pathname, headers: htmlAuth(f.token) }),
      );
      expect(response.status).toBe(404);
      expect(response.body).toContain("Page not found");
    }
  });
});

describe("restart route", () => {
  it("reports a running app as restarted", async () => {
    const f = fixture();
    const manager = fakeManager({ stop: () => true });
    f.deps.manager = manager;
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ restarted: true });
    expect(manager.stopped).toEqual(["p1:web"]);
  });

  it("reports a stopped app without error", async () => {
    const f = fixture();
    f.deps.manager = fakeManager({ stop: () => false });
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ restarted: false, reason: "not_running" });
  });

  it("returns 404 for an unknown app, 503 without a manager, and redirects browsers", async () => {
    const f = fixture();
    const missing = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/nope/restart",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(missing.status).toBe(404);

    const unavailable = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(unavailable.status).toBe(503);

    f.deps.manager = fakeManager({ stop: () => true });
    const browser = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1" },
        headers: htmlAuth(f.token),
        body: form({ return_to: "/projects/p1" }),
      }),
    );
    expect(browser.status).toBe(303);
    expect(browser.headers?.location).toContain("/projects/p1");
    expect(browser.headers?.location).toContain("notice=Agent+restarted.");
  });
});

describe("git settings API", () => {
  it("advertises the git route and includes identity plus credential statuses on reads", async () => {
    const f = fixture();
    expect(isSettingsRoute("POST", "/api/settings/git")).toBe(true);
    expect(isSettingsRoute("GET", "/api/settings/git")).toBe(false);

    const response = await handleSettings(
      f.deps,
      request({ headers: auth(f.token), query: { scope: "app", project: "p1", app: "web" } }),
    );
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      effective: {
        git: { user: { name: { value: unknown; state: string }; email: { value: unknown } } };
      };
      gitAuth: unknown;
      gitAuthScoped: unknown;
    };
    expect(payload.effective.git.user.name).toEqual({
      value: null,
      state: "default",
      source: "default",
      sources: ["default"],
    });
    expect(payload.effective.git.user.email.value).toBeNull();
    expect(payload.gitAuth).toEqual({
      ssh: { state: "missing", kind: "ssh" },
      https: { state: "missing", kind: "https" },
    });
    expect(payload.gitAuthScoped).toEqual({
      ssh: { global: "absent", project: "absent", app: "absent" },
      https: { global: "absent", project: "absent", app: "absent" },
    });
    expect(response.body).not.toContain("gitAuthHash");
    expect(response.body).not.toContain("privateKey");
    expect(response.body).not.toContain("knownHosts");
  });

  it("sets, clears, and inherits HTTPS credentials without echoing the token", async () => {
    const f = fixture();
    const token = "sentinel-http-token";
    const set = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          kind: "https",
          action: "set",
          value: {
            hosts: ["GitHub.com", "github.com"],
            username: "x-access-token",
            token,
          },
        }),
      }),
    );
    expect(set.status).toBe(200);
    expect(set.body).not.toContain(token);
    expect(set.body).not.toContain("gitAuthHash");
    const payload = JSON.parse(set.body) as {
      gitAuth: { https: { state: string; hosts: string[]; username: string } };
    };
    expect(payload.gitAuth.https).toEqual({
      state: "set",
      kind: "https",
      source: "global",
      hosts: ["github.com"],
      username: "x-access-token",
    });

    const read = await handleSettings(
      f.deps,
      request({ headers: auth(f.token), query: { scope: "global" } }),
    );
    expect(read.body).not.toContain(token);
    expect(JSON.parse(read.body).gitAuthScoped.https.global).toBe("set");

    const clear = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({ scope: "global", kind: "https", action: "clear" }),
      }),
    );
    expect(clear.status).toBe(200);
    expect(JSON.parse(clear.body).gitAuth.https).toEqual({
      state: "cleared",
      kind: "https",
      source: "global",
    });

    const inherit = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({ scope: "global", kind: "https", action: "inherit" }),
      }),
    );
    expect(inherit.status).toBe(200);
    expect(JSON.parse(inherit.body).gitAuth.https).toEqual({ state: "missing", kind: "https" });
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM setting_secrets").get()).toEqual({
      count: 0,
    });
  });

  it("sets SSH credentials with metadata only in the response and pages", async () => {
    const f = fixture({ runSshKeygen: fakeSshKeygen() });
    const set = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          kind: "ssh",
          action: "set",
          value: { privateKey: VALID_SSH_KEY },
        }),
      }),
    );
    expect(set.status).toBe(200);
    expect(set.body).not.toContain("sentinel-private-body");
    expect(JSON.parse(set.body).gitAuth.ssh).toEqual({
      state: "set",
      kind: "ssh",
      source: "global",
      publicKey: "ssh-ed25519 AAAAC3NzaFake fake@test",
      fingerprint: "SHA256:fakefingerprint",
      hasKnownHosts: false,
    });

    for (const pathname of [
      "/settings",
      "/projects/p1/settings",
      "/projects/p1/apps/web/settings",
    ]) {
      const page = await handleSettings(
        f.deps,
        request({ path: pathname, headers: htmlAuth(f.token) }),
      );
      expect(page.status).toBe(200);
      expect(page.body).toContain(">Git</h2>");
      expect(page.body).toContain(">User name</label>");
      expect(page.body).toContain("ssh-ed25519 AAAAC3NzaFake fake@test");
      expect(page.body).toContain("SHA256:fakefingerprint");
      expect(page.body).toContain("known_hosts");
      expect(page.body).toContain("/assets/git-settings.js");
      expect(page.body).toContain("data-git-auth");
      expect(page.body).not.toContain("sentinel-private-body");
      expect(page.body).not.toContain("gitAuthHash");
      if (pathname.includes("/apps/")) {
        expect(page.body).toContain("Test connection");
      } else {
        expect(page.body).not.toContain("Test connection");
      }
      const ids = [...page.body.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("returns bounded validation errors without echoing the submitted secret", async () => {
    const f = fixture();
    const token = "sentinel-bad-token";
    const invalidHosts = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          kind: "https",
          action: "set",
          value: { hosts: ["https://github.com"], username: "u", token },
        }),
      }),
    );
    expect(invalidHosts.status).toBe(400);
    const error = JSON.parse(invalidHosts.body) as {
      code: string;
      field?: string;
      error: string;
    };
    expect(error.code).toBe("invalid_git_credential");
    expect(error.field).toBe("hosts");
    expect(invalidHosts.body).not.toContain(token);

    const missingValue = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({ scope: "global", kind: "https", action: "set" }),
      }),
    );
    expect(missingValue.status).toBe(400);

    const clearWithValue = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          kind: "https",
          action: "clear",
          value: { token: "should-not-be-used" },
        }),
      }),
    );
    expect(clearWithValue.status).toBe(400);
    expect(clearWithValue.body).not.toContain("should-not-be-used");

    const badKind = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token),
        body: JSON.stringify({ scope: "global", kind: "gpg", action: "clear" }),
      }),
    );
    expect(badKind.status).toBe(400);

    const formBody = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({ scope: "global", kind: "https", action: "clear" }),
      }),
    );
    expect(formBody.status).toBe(400);
    expect(JSON.parse(formBody.body).code).toBe("invalid_request");

    const agent = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.agentToken, { "content-type": "application/json" }),
        body: JSON.stringify({ scope: "global", kind: "https", action: "clear" }),
      }),
    );
    expect(agent.status).toBe(403);
  });

  it("keeps identity mutations on the normal settings route", async () => {
    const f = fixture();
    const set = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token),
        body: form({
          scope: "global",
          key: "git.user.name",
          action: "set",
          value: "Hanse Agent",
        }),
      }),
    );
    expect(set.status).toBe(200);
    expect(f.settings.resolve({}).effective.git.user.name.value).toBe("Hanse Agent");

    const read = await handleSettings(
      f.deps,
      request({ headers: auth(f.token), query: { scope: "global" } }),
    );
    expect(JSON.parse(read.body).effective.git.user.name).toMatchObject({
      value: "Hanse Agent",
      source: "global",
    });
    expect(JSON.parse(read.body).scoped["global:git.user.name"]).toEqual({
      state: "set",
      value: "Hanse Agent",
    });
  });

  it("accepts a 32 KiB SSH key plus known_hosts within the 64 KiB body limit", async () => {
    const f = fixture({ runSshKeygen: fakeSshKeygen() });
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const paddedKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"a".repeat(31 * 1024)}\n-----END OPENSSH PRIVATE KEY-----\n`;
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/git`, {
      method: "POST",
      headers: { ...auth(f.token), "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        kind: "ssh",
        action: "set",
        value: {
          privateKey: paddedKey,
          knownHosts: `${"#".repeat(8 * 1024)}\nexample.com ssh-ed25519 AAAA`,
        },
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBeUndefined();
  });
});
