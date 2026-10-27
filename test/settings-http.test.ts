import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeploymentInProgressError } from "../src/coordinator/deployment-lock.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import type { RunSshKeygen } from "../src/git/credentials.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { handleSettings, isSettingsRoute } from "../src/http/settings.js";
import { createPrincipal } from "../src/identity/principals.js";
import { DefaultImageUnavailableError, ImageNotReadyError } from "../src/images/service.js";
import { ModelProviderService } from "../src/model-providers/index.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { imageStateView } from "./fixtures/image-state.js";

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
  modelProviders: ModelProviderService;
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
  const modelProviders = new ModelProviderService({ db });
  const settings = new SettingsService({
    db,
    secretKey: randomBytes(32),
    hostAuthFile,
    runSshKeygen: options.runSshKeygen,
    providerIds: () => modelProviders.list().map((provider) => provider.id),
  });
  const token = createPrincipal(db, { kind: "human", name: "alice" }).token;
  const agent = createPrincipal(db, { kind: "agent", name: "bot" });
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    settings,
    modelProviders,
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
  return { db, deps, settings, modelProviders, token, agentToken: agent.token, dir };
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

interface FragmentPayload {
  ok: boolean;
  changed: string[];
  sections: Record<string, string>;
}

function rowMarkup(body: string, id: string): string {
  const start = body.indexOf(`<details class="setting-row" id="${id}"`);
  if (start < 0) {
    return "";
  }
  const next = body.indexOf('<details class="setting-row"', start + 1);
  return body.slice(start, next < 0 ? body.length : next);
}

function fakeManager(
  options: {
    pending?: (appId: string) => boolean;
    restart?: (appId: string) => boolean;
    preflight?: (appId: string) => boolean;
    preflightError?: Error;
  } = {},
): InstanceManager & { restarted: string[]; stopped: string[]; preflighted: string[] } {
  const restarted: string[] = [];
  const stopped: string[] = [];
  const preflighted: string[] = [];
  let active: string | undefined;
  const manager = {
    restarted,
    stopped,
    preflighted,
    preflightRestart: async (app: { id: string }) => {
      preflighted.push(app.id);
      if (options.preflightError !== undefined) {
        throw options.preflightError;
      }
      return options.preflight?.(app.id) ?? true;
    },
    pendingRestart: (appId: string) => {
      const pending = options.pending?.(appId) ?? false;
      return pending
        ? { pending: true, reasons: ["settings_changed"] }
        : { pending: false, reasons: [] };
    },
    isRestarting: (appId: string) => active === appId,
    beginRestart: (app: { id: string }) => {
      if (active === app.id) {
        return { accepted: false };
      }
      active = app.id;
      restarted.push(app.id);
      const completion = Promise.resolve(options.restart?.(app.id) ?? false).finally(() => {
        if (active === app.id) active = undefined;
      });
      return { accepted: true, completion };
    },
    restartIfRunning: async (app: { id: string }) => {
      restarted.push(app.id);
      return options.restart?.(app.id) ?? false;
    },
    stopApp: async (appId: string) => {
      stopped.push(appId);
      return false;
    },
  };
  return manager as unknown as InstanceManager & {
    restarted: string[];
    stopped: string[];
    preflighted: string[];
  };
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

  it("returns JSON 401 for fragment requests instead of redirecting", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
          "x-hanse-fragment": "settings",
        },
        body: form({
          scope: "global",
          key: "llm.model",
          action: "set",
          value: "acme/unauthorized",
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.contentType).toContain("application/json");
    expect(response.headers?.location).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({ error: "sign in required" });
  });

  it("returns JSON 400 for fragment validation errors", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, {
          "content-type": "application/x-www-form-urlencoded",
          "x-hanse-fragment": "settings",
        }),
        body: form({ scope: "global", key: "llm.model", action: "bogus" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers?.location).toBeUndefined();
    expect(JSON.parse(response.body).error).toContain("action must be");
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

  it("sets context auto-compaction from native JSON values", async () => {
    const f = fixture();
    const defaults = JSON.parse(
      (
        await handleSettings(
          f.deps,
          request({ headers: auth(f.token), query: { scope: "global" } }),
        )
      ).body,
    ) as {
      effective: {
        context: {
          autoCompact: {
            enabled: { value: boolean };
            percent: { value: number };
          };
        };
      };
    };
    expect(defaults.effective.context.autoCompact.enabled.value).toBe(false);
    expect(defaults.effective.context.autoCompact.percent.value).toBe(80);

    const enabled = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          key: "context.auto_compact.enabled",
          action: "set",
          value: true,
        }),
      }),
    );
    expect(enabled.status).toBe(200);
    expect(f.settings.resolve({}).effective.context.autoCompact.enabled).toEqual({
      value: true,
      state: "set",
      source: "global",
      sources: ["global"],
    });

    const percent = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          key: "context.auto_compact.percent",
          action: "set",
          value: 67,
        }),
      }),
    );
    expect(percent.status).toBe(200);
    const read = JSON.parse(
      (
        await handleSettings(
          f.deps,
          request({ headers: auth(f.token), query: { scope: "global" } }),
        )
      ).body,
    ) as { scoped: Record<string, unknown> };
    expect(read.scoped["global:context.auto_compact.percent"]).toEqual({
      state: "set",
      value: 67,
    });

    for (const invalid of [0, 100, 1.5, "67", null]) {
      const rejected = await handleSettings(
        f.deps,
        request({
          method: "POST",
          path: "/api/settings",
          headers: auth(f.token, { "content-type": "application/json" }),
          body: JSON.stringify({
            scope: "global",
            key: "context.auto_compact.percent",
            action: "set",
            value: invalid,
          }),
        }),
      );
      expect(rejected.status).toBe(400);
    }

    const booleanString = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          scope: "global",
          key: "context.auto_compact.enabled",
          action: "set",
          value: "on",
        }),
      }),
    );
    expect(booleanString.status).toBe(400);
  });

  it("converts context form strings and rejects invalid values", async () => {
    const f = fixture();
    const booleanCases: Array<[string, boolean]> = [
      ["on", true],
      ["off", false],
      ["true", true],
      ["false", false],
      ["1", true],
      ["0", false],
    ];
    for (const [raw, expected] of booleanCases) {
      const response = await handleSettings(
        f.deps,
        request({
          method: "POST",
          path: "/api/settings",
          headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
          body: form({
            scope: "global",
            key: "context.auto_compact.enabled",
            action: "set",
            value: raw,
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(f.settings.resolve({}).effective.context.autoCompact.enabled.value).toBe(expected);
    }

    const percent = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
        body: form({
          scope: "global",
          key: "context.auto_compact.percent",
          action: "set",
          value: "55",
        }),
      }),
    );
    expect(percent.status).toBe(200);
    expect(f.settings.resolve({}).effective.context.autoCompact.percent.value).toBe(55);

    for (const [key, raw] of [
      ["context.auto_compact.percent", ""],
      ["context.auto_compact.percent", "abc"],
      ["context.auto_compact.percent", "0"],
      ["context.auto_compact.percent", "100"],
      ["context.auto_compact.percent", "1.5"],
      ["context.auto_compact.enabled", "maybe"],
    ] as const) {
      const rejected = await handleSettings(
        f.deps,
        request({
          method: "POST",
          path: "/api/settings",
          headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
          body: form({ scope: "global", key, action: "set", value: raw }),
        }),
      );
      expect(rejected.status).toBe(400);
    }

    for (const key of ["context.auto_compact.enabled", "context.auto_compact.percent"]) {
      const clear = await handleSettings(
        f.deps,
        request({
          method: "POST",
          path: "/api/settings",
          headers: auth(f.token, { "content-type": "application/x-www-form-urlencoded" }),
          body: form({ scope: "global", key, action: "clear" }),
        }),
      );
      expect(clear.status).toBe(400);
      expect(JSON.parse(clear.body).error).toContain("not clearable");
    }
  });

  it("returns the Context fragment for context mutations without a restart warning", async () => {
    const f = fixture();
    const enabled = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, {
          "content-type": "application/x-www-form-urlencoded",
          "x-hanse-fragment": "settings",
        }),
        body: form({
          scope: "project",
          projectId: "p1",
          key: "context.auto_compact.enabled",
          action: "set",
          value: "on",
        }),
      }),
    );
    expect(enabled.status).toBe(200);
    const enabledPayload = JSON.parse(enabled.body) as FragmentPayload;
    expect(enabledPayload.changed).toEqual(["context", "restart", "warnings"]);
    expect(enabledPayload.sections.context).toContain('id="settings-context"');
    expect(enabledPayload.sections.context).toContain('class="mono">On</span>');
    expect(enabledPayload.sections.context).not.toContain("Restart required");
    expect(enabledPayload.sections.agent).toBeUndefined();
    expect(enabledPayload.sections.web).toBeUndefined();
    expect(enabledPayload.sections.restart).toContain(
      "No running agents are waiting for a restart.",
    );
    expect(enabledPayload.sections.restart).not.toContain("Restart required");
    expect(enabledPayload.sections.warnings).toBe("");

    const percent = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, {
          "content-type": "application/x-www-form-urlencoded",
          "x-hanse-fragment": "settings",
        }),
        body: form({
          scope: "project",
          projectId: "p1",
          key: "context.auto_compact.percent",
          action: "set",
          value: "72",
        }),
      }),
    );
    const percentPayload = JSON.parse(percent.body) as FragmentPayload;
    expect(percentPayload.changed).toEqual(["context", "restart", "warnings"]);
    expect(percentPayload.sections.context).toContain('class="mono">72%</span>');
    expect(percentPayload.sections.context).toContain('value="72"');
    expect(percentPayload.sections.context).not.toContain("Restart required");
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

  it("returns only the changed settings sections for fragment requests", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, {
          "content-type": "application/x-www-form-urlencoded",
          "x-hanse-fragment": "settings",
        }),
        body: form({
          scope: "global",
          key: "llm.model",
          action: "set",
          value: "acme/fragment-model",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers?.location).toBeUndefined();
    const payload = JSON.parse(response.body) as FragmentPayload;
    expect(payload.ok).toBe(true);
    expect(payload.changed).toEqual(["agent", "web", "context", "restart", "warnings"]);
    expect(payload.sections.agent).toContain('id="settings-agent"');
    expect(payload.sections.agent).toContain("acme/fragment-model");
    expect(payload.sections.restart).toContain('id="settings-restart"');
    expect(typeof payload.sections.warnings).toBe("string");
    expect(f.settings.resolve({}).effective.llm.model.value).toBe("acme/fragment-model");
  });

  it("returns git section fragments and only the changed keys for git identity edits", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, {
          "content-type": "application/x-www-form-urlencoded",
          "x-hanse-fragment": "setTings",
        }),
        body: form({
          scope: "global",
          key: "git.user.name",
          action: "set",
          value: "Fragment Agent",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as FragmentPayload;
    expect(payload.changed).toEqual(["git", "restart"]);
    expect(payload.sections.git).toContain('id="settings-git"');
    expect(payload.sections.git).toContain("Fragment Agent");
    expect(payload.sections.agent).toBeUndefined();
  });

  it("never echoes Git credential secrets in fragment responses", async () => {
    const f = fixture();
    const secret = "sentinel-fragment-git-secret";
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, {
          "content-type": "application/json",
          "x-hanse-fragment": "settings",
        }),
        body: JSON.stringify({
          scope: "global",
          kind: "https",
          action: "set",
          value: { hosts: ["github.com"], username: "x-access-token", token: secret },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).not.toContain(secret);
    const payload = JSON.parse(response.body) as FragmentPayload;
    expect(payload.changed).toEqual(["git", "restart"]);
    expect(payload.sections.git).toContain('id="settings-git"');
    expect(payload.sections.git).not.toContain(secret);
  });

  it("returns 404 JSON when a fragment target no longer exists", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, {
          "content-type": "application/json",
          "x-hanse-fragment": "settings",
        }),
        body: JSON.stringify({
          scope: "app",
          projectId: "p1",
          appKey: "nope",
          key: "llm.model",
          action: "set",
          value: "acme/orphan",
        }),
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers?.location).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({ error: "not found" });
    expect(f.settings.resolve({ projectId: "p1", appKey: "nope" }).scoped["app:llm.model"]).toEqual(
      { state: "absent", value: null },
    );
  });

  it("keeps the existing JSON response shape without the fragment header", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings",
        headers: auth(f.token, {
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: form({ scope: "global", key: "llm.model", action: "set", value: "acme/json-model" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers?.location).toBeUndefined();
    const payload = JSON.parse(response.body) as {
      ok?: boolean;
      effective: { llm: { model: { value: string } } };
      pendingRestart: unknown[];
      sections?: unknown;
    };
    expect(payload.ok).toBeUndefined();
    expect(payload.effective.llm.model.value).toBe("acme/json-model");
    expect(payload.pendingRestart).toEqual([]);
    expect(payload.sections).toBeUndefined();
  });

  it("forwards the fragment header through the HTTP server", async () => {
    const f = fixture();
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: {
        ...auth(f.token),
        "content-type": "application/json",
        "x-hanse-fragment": "settings",
      },
      body: JSON.stringify({
        scope: "global",
        key: "llm.model",
        action: "set",
        value: "http/fragment-model",
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as FragmentPayload;
    expect(payload.ok).toBe(true);
    expect(payload.sections.agent).toContain("http/fragment-model");
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

  it("returns agent and warnings fragments for provider mutations", async () => {
    const f = fixture();
    const secret = "sk-fragment-provider-secret";
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/provider",
        headers: auth(f.token, {
          "content-type": "application/json",
          "x-hanse-fragment": "settings",
        }),
        body: JSON.stringify({
          scope: "global",
          provider: "deepseek",
          action: "set",
          key: secret,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers?.location).toBeUndefined();
    const payload = JSON.parse(response.body) as FragmentPayload;
    expect(payload.ok).toBe(true);
    expect(payload.changed).toEqual(["agent", "web", "context", "restart", "warnings"]);
    expect(payload.sections.agent).toContain('id="providers"');
    expect(payload.sections.warnings).toBe("");
    expect(response.body).not.toContain(secret);
    expect(payload.sections.restart).toContain('id="settings-restart"');
  });
});

describe("settings pages and pending state", () => {
  it("renders five section cards, one setting row per setting, and the sticky nav", async () => {
    const f = fixture();
    f.settings.setProviderKey("global", {}, "deepseek", "sk-page-secret", "owner");
    const paths = ["/settings", "/projects/p1/settings", "/projects/p1/apps/web/settings"];
    for (const pathname of paths) {
      const response = await handleSettings(
        f.deps,
        request({ path: pathname, headers: htmlAuth(f.token) }),
      );
      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/html");
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(response.body).toContain('class="app-shell"');
      expect(response.body).toContain(`href="${pathname}"`);
      expect(response.body).toContain('class="settings-nav"');
      expect(response.body).toContain('href="#settings-agent"');
      expect(response.body).toContain('href="#settings-web"');
      expect(response.body).toContain('href="#settings-context"');
      expect(response.body).toContain('href="#settings-git"');
      expect(response.body).toContain('href="#settings-restart"');
      for (const id of [
        "settings-agent",
        "settings-web",
        "settings-context",
        "settings-git",
        "settings-restart",
      ]) {
        expect(response.body).toContain(`id="${id}"`);
      }
      expect(response.body).toContain(">Agent</h2>");
      expect(response.body).toContain(">Web tools</h2>");
      expect(response.body).toContain(">Context</h2>");
      expect(response.body).toContain(">Git</h2>");
      expect(response.body).toContain(">Restart &amp; pending</h2>");
      const rows = [
        ...response.body.matchAll(/<details class="setting-row" id="(setting-[^"]+)"/g),
      ].map((match) => match[1]);
      expect(rows).toEqual([
        "setting-llm-model",
        "setting-web-search",
        "setting-web-fetch",
        "setting-context-auto-compact",
        "setting-context-auto-compact-percent",
        "setting-git-user-name",
        "setting-git-user-email",
        "setting-git-ssh",
        "setting-git-https",
      ]);
      expect(response.body).toContain("data-settings-driver");
      expect(response.body).toContain("data-settings-form");
      const compactRow = rowMarkup(response.body, "setting-context-auto-compact");
      expect(compactRow).toContain('action="/api/settings"');
      expect(compactRow).toContain('name="key" value="context.auto_compact.enabled"');
      expect(compactRow).toContain("data-settings-form");
      expect(compactRow).toContain("data-no-busy");
      expect(compactRow).toContain('name="return_to"');
      expect(compactRow).toContain('<option value="true"');
      expect(compactRow).toContain('<option value="false"');
      expect(compactRow).toContain(">On</option>");
      expect(compactRow).toContain(">Off</option>");
      expect(compactRow).toContain('class="mono">Off</span>');
      const percentRow = rowMarkup(response.body, "setting-context-auto-compact-percent");
      expect(percentRow).toContain('name="key" value="context.auto_compact.percent"');
      expect(percentRow).toContain('type="number"');
      expect(percentRow).toContain('min="1"');
      expect(percentRow).toContain('max="99"');
      expect(percentRow).toContain('step="1"');
      expect(percentRow).toContain('class="mono">80%</span>');
      expect(response.body).toContain('autocomplete="new-password"');
      expect(response.body).toContain("/assets/settings.js");
      expect(response.body).not.toContain("<table");
      expect(response.body).not.toContain("sk-page-secret");
      expect(
        response.body.slice(
          response.body.indexOf('id="setting-llm-model"'),
          response.body.indexOf('id="providers"'),
        ),
      ).not.toContain('value="clear"');
      expect(response.body).not.toContain('action="/api/apps/');
      if (pathname === "/settings") {
        expect(response.body).not.toContain("settings-nav__scopes");
        expect(response.body).not.toContain('class="scope-list"');
      } else {
        expect(response.body).toContain("settings-nav__scopes");
        expect(response.body).toContain('class="scope-list"');
        expect(response.body).toContain('aria-current="page"');
      }
      if (pathname === "/projects/p1/settings") {
        expect(response.body).toContain('href="/settings">Global</a>');
        expect(response.body).toContain(">Project</span>");
      }
      if (pathname === "/projects/p1/apps/web/settings") {
        expect(response.body).toContain('href="/projects/p1/settings">Project</a>');
        expect(response.body).toContain(">Application</span>");
        expect(response.body).toContain(">App</span>");
      }
    }
  });

  it("prefills only own-scope values and names the inherited effective value", async () => {
    const f = fixture();
    f.settings.set("global", {}, "llm.model", "global/model", "owner");
    f.settings.set("global", {}, "git.user.name", "Global Agent", "owner");
    f.settings.set("global", {}, "web.search", { driver: "builtin" }, "owner");
    f.settings.set("global", {}, "context.auto_compact.enabled", true, "owner");
    f.settings.set("global", {}, "context.auto_compact.percent", 70, "owner");

    const project = await handleSettings(
      f.deps,
      request({ path: "/projects/p1/settings", headers: htmlAuth(f.token) }),
    );
    const modelRow = rowMarkup(project.body, "setting-llm-model");
    expect(modelRow).toContain('value=""');
    expect(modelRow).toContain('placeholder="Inherited: global/model"');
    const searchRow = rowMarkup(project.body, "setting-web-search");
    expect(searchRow).toContain('<option value="" selected disabled>Choose a driver</option>');
    expect(searchRow).toContain(
      "This scope inherits builtin from Global. Saving creates an override.",
    );
    const identityRow = rowMarkup(project.body, "setting-git-user-name");
    expect(identityRow).toContain('value=""');
    expect(identityRow).toContain('placeholder="Inherited: Global Agent"');
    const compactRow = rowMarkup(project.body, "setting-context-auto-compact");
    expect(compactRow).toContain('<option value="" selected disabled>Inherited: On</option>');
    expect(compactRow).toContain("data-settings-inherit");
    const percentRow = rowMarkup(project.body, "setting-context-auto-compact-percent");
    expect(percentRow).toContain('value=""');
    expect(percentRow).toContain('placeholder="Inherited: 70%"');

    f.settings.set("app", { projectId: "p1", appKey: "web" }, "llm.model", "app/model", "owner");
    const app = await handleSettings(
      f.deps,
      request({ path: "/projects/p1/apps/web/settings", headers: htmlAuth(f.token) }),
    );
    expect(rowMarkup(app.body, "setting-llm-model")).toContain('value="app/model"');

    const globalPage = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    expect(rowMarkup(globalPage.body, "setting-llm-model")).toContain('value="global/model"');

    const fresh = fixture();
    const freshGlobal = await handleSettings(
      fresh.deps,
      request({ path: "/settings", headers: htmlAuth(fresh.token) }),
    );
    expect(rowMarkup(freshGlobal.body, "setting-llm-model")).toContain(
      'placeholder="Default: deepseek/deepseek-flash"',
    );
    expect(rowMarkup(freshGlobal.body, "setting-context-auto-compact")).toContain(
      '<option value="" selected disabled>Default: Off</option>',
    );
    expect(rowMarkup(freshGlobal.body, "setting-context-auto-compact-percent")).toContain(
      'placeholder="Default: 80%"',
    );
  });

  it("disables no-op inherit and clear actions with visible reasons", async () => {
    const f = fixture();
    f.settings.set("global", {}, "llm.model", "global/model", "owner");
    f.settings.clear("global", {}, "web.search", "owner");

    const project = await handleSettings(
      f.deps,
      request({ path: "/projects/p1/settings", headers: htmlAuth(f.token) }),
    );
    const modelRow = rowMarkup(project.body, "setting-llm-model");
    expect(modelRow).toMatch(
      /<button class="btn btn-secondary btn-sm"[^>]*disabled>Inherit<\/button>/,
    );
    expect(modelRow).toContain("Already inherited from Global.");
    expect(modelRow).not.toContain(">Clear<");

    const globalPage = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    const searchRow = rowMarkup(globalPage.body, "setting-web-search");
    expect(searchRow).toMatch(/<button class="btn btn-danger btn-sm"[^>]*disabled>Clear<\/button>/);
    expect(searchRow).toContain("Already cleared at this scope.");
    expect(searchRow).toContain("Clearing here disables this setting for every application.");
    expect(rowMarkup(globalPage.body, "setting-llm-model")).not.toContain(">Inherit<");
  });

  it("renders provider clear through the shared dialog with the provider field", async () => {
    const f = fixture();
    f.settings.setProviderKey("global", {}, "deepseek", "sk-provider", "owner");
    const response = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    const providerRow = rowMarkup(response.body, "provider-deepseek");
    expect(providerRow).toContain('name="provider" value="deepseek"');
    expect(providerRow).toMatch(/data-confirm-clear[^>]*data-setting-label="deepseek key"/);
    expect(providerRow).toContain(">Change key<");
    expect(response.body).toContain('id="settings-clear-dialog"');
    expect(response.body).toContain('id="settings-clear-form"');
    expect(response.body).not.toMatch(/<form[^>]*data-settings-form[^>]*id="settings-clear-form"/);
  });

  it("wraps warnings for fragment swaps and gives the clear dialog an error slot", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain('<div id="settings-warnings">');
    const formStart = response.body.indexOf('id="settings-clear-form"');
    expect(formStart).toBeGreaterThan(-1);
    const formEnd = response.body.indexOf("</form>", formStart);
    expect(formEnd).toBeGreaterThan(formStart);
    expect(response.body.slice(formStart, formEnd)).toContain("data-settings-error");
    expect(response.body.slice(formStart, formEnd)).toContain("data-no-busy");
  });

  it("renders one compact warnings block when resolution reports warnings", async () => {
    const f = fixture({ hostAuth: {} });
    writeFileSync(path.join(f.dir, "host-auth.json"), "{not json");
    const response = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    expect(response.body).toContain('class="settings-warning"');
    expect(response.body).toContain("host auth file is not valid JSON; using empty auth");
    expect(response.body).not.toContain(">Warnings</h2>");
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
  it("restarts a running app without calling stopApp", async () => {
    const f = fixture();
    const manager = fakeManager({ restart: () => true });
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
    expect(manager.restarted).toEqual(["p1:web"]);
    expect(manager.stopped).toEqual([]);
  });

  it("reports a stopped app without error", async () => {
    const f = fixture();
    f.deps.manager = fakeManager({ restart: () => false });
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

  it("returns 502 for a failed restart and a browser error notice", async () => {
    const f = fixture();
    const manager = fakeManager();
    manager.beginRestart = () => ({
      accepted: true,
      completion: Promise.reject(new Error("runtime delete failed")),
    });
    f.deps.manager = manager;
    const api = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1" },
        headers: auth(f.token),
      }),
    );
    expect(api.status).toBe(502);
    expect(JSON.parse(api.body)).toEqual({ error: "restart failed" });

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
    expect(browser.headers?.location).toContain("Restart+failed.");
    expect(manager.stopped).toEqual([]);
  });

  it("returns the shared 409 body when a deployment lock blocks restart", async () => {
    const f = fixture();
    const manager = fakeManager();
    f.deps.deploymentLock = {
      assertUnlocked: () => {
        throw new DeploymentInProgressError("restart", { phase: "switching" });
      },
    } as unknown as HttpDeps["deploymentLock"];
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
    expect(response.status).toBe(409);
    expect(response.headers?.["retry-after"]).toBe("30");
    expect(JSON.parse(response.body)).toEqual({
      error: "deployment_in_progress",
      message: "deployment in progress: switching",
      retryAfter: 30,
    });
    expect(manager.restarted).toEqual([]);
    expect(manager.stopped).toEqual([]);
  });

  it("returns 202 for an accepted async restart without waiting for completion", async () => {
    const f = fixture();
    const manager = fakeManager();
    let completed = false;
    manager.beginRestart = (app: { id: string }) => {
      manager.restarted.push(app.id);
      return {
        accepted: true,
        completion: new Promise<boolean>((resolve) => {
          setTimeout(() => {
            completed = true;
            resolve(true);
          }, 50);
        }),
      };
    };
    f.deps.manager = manager;
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: true, appId: "p1:web" });
    expect(completed).toBe(false);
    expect(manager.restarted).toEqual(["p1:web"]);
  });

  it("returns 409 restart_in_progress for a duplicate sync or async claim", async () => {
    const f = fixture();
    const manager = fakeManager();
    manager.beginRestart = () => ({ accepted: false });
    f.deps.manager = manager;

    for (const query of [{ project: "p1" }, { project: "p1", async: "1" }]) {
      const response = await handleSettings(
        f.deps,
        request({
          method: "POST",
          path: "/api/apps/web/restart",
          query,
          headers: auth(f.token),
        }),
      );
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toEqual({ error: "restart_in_progress" });
    }
  });

  it("checks the deployment lock before an async claim", async () => {
    const f = fixture();
    const manager = fakeManager();
    let claimed = false;
    manager.beginRestart = () => {
      claimed = true;
      return { accepted: true, completion: Promise.resolve(true) };
    };
    f.deps.manager = manager;
    f.deps.deploymentLock = {
      assertUnlocked: () => {
        throw new DeploymentInProgressError("restart");
      },
    } as unknown as HttpDeps["deploymentLock"];

    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: "deployment_in_progress" });
    expect(claimed).toBe(false);
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

    const manager = fakeManager({ restart: () => true });
    f.deps.manager = manager;
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
    expect(manager.restarted).toEqual(["p1:web"]);
    expect(manager.stopped).toEqual([]);
  });

  it("rejects a cross-site restart before preflight or a claim", async () => {
    const f = fixture();
    const manager = fakeManager();
    f.deps.manager = manager;

    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1" },
        headers: auth(f.token),
        origin: "https://evil.example",
        host: "localhost",
      }),
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "cross-site request rejected",
      code: "cross_site_request",
    });
    expect(manager.preflighted).toEqual([]);
    expect(manager.restarted).toEqual([]);
  });

  it("returns not_running for a stopped app without taking a claim", async () => {
    const f = fixture();
    const manager = fakeManager({ preflight: () => false });
    let claimed = false;
    manager.beginRestart = () => {
      claimed = true;
      return { accepted: true, completion: Promise.resolve(true) };
    };
    f.deps.manager = manager;

    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ restarted: false, reason: "not_running" });
    expect(manager.preflighted).toEqual(["p1:web"]);
    expect(claimed).toBe(false);
    expect(manager.restarted).toEqual([]);
  });

  it("maps a typed image failure before any claim or 202", async () => {
    const f = fixture();
    const manager = fakeManager({
      preflightError: new ImageNotReadyError(
        imageStateView({ appId: "p1:web", state: "not_ready" }),
      ),
    });
    let claimed = false;
    manager.beginRestart = () => {
      claimed = true;
      return { accepted: true, completion: Promise.resolve(true) };
    };
    f.deps.manager = manager;

    for (const query of [{ project: "p1" }, { project: "p1", async: "1" }]) {
      const response = await handleSettings(
        f.deps,
        request({
          method: "POST",
          path: "/api/apps/web/restart",
          query,
          headers: auth(f.token),
        }),
      );
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toEqual({
        error: "image_not_ready",
        code: "image_not_ready",
        message: "application image is not ready (not_ready)",
        appId: "p1:web",
        state: "not_ready",
        imageStatus: "missing",
        buildConfigured: true,
      });
    }

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
    expect(browser.headers?.location).toContain("application+image+is+not+ready");
    expect(claimed).toBe(false);
  });

  it("maps an unavailable default image to 503 before a claim", async () => {
    const f = fixture();
    const manager = fakeManager({
      preflightError: new DefaultImageUnavailableError(
        imageStateView({
          appId: "p1:web",
          buildConfigured: false,
          state: "unknown",
        }),
      ),
    });
    let claimed = false;
    manager.beginRestart = () => {
      claimed = true;
      return { accepted: true, completion: Promise.resolve(true) };
    };
    f.deps.manager = manager;

    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/apps/web/restart",
        query: { project: "p1", async: "1" },
        headers: auth(f.token),
      }),
    );

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "default_image_unavailable",
      code: "default_image_unavailable",
      message: "the default agent image is unavailable",
      appId: "p1:web",
      state: "unknown",
    });
    expect(claimed).toBe(false);
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

  it("returns git and restart fragments for git credential mutations", async () => {
    const f = fixture();
    const secret = "sentinel-fragment-git-token";
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/git",
        headers: auth(f.token, {
          "content-type": "application/json",
          "x-hanse-fragment": "settings",
        }),
        body: JSON.stringify({
          scope: "global",
          kind: "https",
          action: "set",
          value: { hosts: ["github.com"], username: "x-access-token", token: secret },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers?.location).toBeUndefined();
    const payload = JSON.parse(response.body) as FragmentPayload;
    expect(payload.ok).toBe(true);
    expect(payload.changed).toEqual(["git", "restart"]);
    expect(payload.sections.git).toContain('id="settings-git"');
    expect(payload.sections.git).not.toContain(secret);
    expect(payload.sections.agent).toBeUndefined();
    expect(response.body).not.toContain(secret);
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

  it("renders the merged git credential ids and data attributes inside setting rows", async () => {
    const f = fixture({ runSshKeygen: fakeSshKeygen() });
    f.settings.setGitAuth("global", {}, "ssh", { privateKey: VALID_SSH_KEY }, "owner");
    f.settings.setGitAuth(
      "global",
      {},
      "https",
      { hosts: ["github.com"], username: "x-access-token", token: "token" },
      "owner",
    );
    const page = await handleSettings(
      f.deps,
      request({ path: "/projects/p1/apps/web/settings", headers: htmlAuth(f.token) }),
    );
    for (const id of [
      "git",
      "git-title",
      "git-identity-name",
      "git-identity-email",
      "git-ssh",
      "git-https",
      "git-ssh-public-key",
      "git-ssh-fingerprint",
      "git-https-allowed-hosts",
      "git-https-username-value",
      "git-ssh-private-key",
      "git-ssh-known-hosts",
      "git-https-hosts",
      "git-https-username",
      "git-https-token",
      "git-ssh-test-remote",
      "git-https-test-remote",
    ]) {
      expect(page.body).toContain(`id="${id}"`);
    }
    for (const attribute of [
      "data-git-auth",
      "data-git-test",
      "data-git-error",
      "data-git-test-result",
      "data-git-test-summary",
      "data-git-test-warnings",
      "data-git-test-error",
    ]) {
      expect(page.body).toContain(attribute);
    }
    expect(page.body).toContain("Git credential changes require JavaScript.");
    const sshRow = rowMarkup(page.body, "setting-git-ssh");
    expect(sshRow).toContain(">SSH credential<");
    expect(sshRow).toContain("data-git-auth");
    expect(sshRow).toContain("data-git-test");
    expect(sshRow).toContain("Scope details");
    expect(sshRow).not.toContain("data-settings-form");
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

describe("custom model providers settings", () => {
  function providerPost(
    f: Fixture,
    values: Record<string, string>,
    headers: Record<string, string> = {},
  ): ReturnType<typeof handleSettings> {
    return handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/model-providers",
        headers: auth(f.token, {
          "content-type": "application/x-www-form-urlencoded",
          "x-hanse-fragment": "settings",
          ...headers,
        }),
        body: form(values),
      }),
    );
  }

  function createProvider(
    f: Fixture,
    overrides: Record<string, string> = {},
  ): ReturnType<typeof handleSettings> {
    return providerPost(f, {
      action: "create",
      id: "llm-lan",
      name: "LLM LAN",
      baseUrl: "http://gateway:4000/v1",
      models: "deepseek | 1000000 | 64000 | DeepSeek",
      return_to: "/settings#custom-providers",
      ...overrides,
    });
  }

  it("registers the route and renders the global block", async () => {
    const f = fixture();
    expect(isSettingsRoute("GET", "/api/settings/model-providers")).toBe(true);
    expect(isSettingsRoute("POST", "/api/settings/model-providers")).toBe(true);
    const response = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain('id="custom-providers"');
    expect(response.body).toContain("No custom providers yet.");
    expect(response.body).toContain('action="/api/settings/model-providers"');
  });

  it("renders a hint instead of the form on project and app settings", async () => {
    const f = fixture();
    for (const path of ["/projects/p1/settings", "/projects/p1/apps/web/settings"]) {
      const response = await handleSettings(f.deps, request({ path, headers: htmlAuth(f.token) }));
      expect(response.status).toBe(200);
      expect(response.body).toContain("Custom model providers are global");
      expect(response.body).not.toContain('id="custom-provider-new-id"');
    }
  });

  it("creates a provider from the form and refreshes the agent section", async () => {
    const f = fixture();
    const response = await createProvider(f);
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as {
      changed: string[];
      sections: Record<string, string>;
    };
    expect(data.changed).toEqual(["agent", "restart", "warnings"]);
    expect(data.sections.agent).toContain("llm-lan");
    expect(data.sections.agent).toContain("DeepSeek");
    expect(data.sections.agent).toContain("provider-llm-lan");
    expect(f.modelProviders.list()).toHaveLength(1);
    expect(f.modelProviders.get("llm-lan")?.models[0]).toEqual({
      id: "deepseek",
      name: "DeepSeek",
      limit: { context: 1000000, output: 64000 },
    });
  });

  it("updates and deletes a provider from the form", async () => {
    const f = fixture();
    f.modelProviders.create(
      {
        id: "llm-lan",
        name: "LLM LAN",
        baseUrl: "http://gateway:4000/v1",
        models: [{ id: "deepseek", limit: { context: 1000, output: 100 } }],
      },
      "operator",
    );
    const updated = await providerPost(f, {
      action: "update",
      id: "llm-lan",
      name: "Renamed",
      baseUrl: "https://gateway:4000/v1",
      models: "deepseek | 2000 | 200 | DeepSeek",
      return_to: "/settings#custom-providers",
    });
    expect(updated.status).toBe(200);
    expect(f.modelProviders.get("llm-lan")?.name).toBe("Renamed");
    expect(f.modelProviders.get("llm-lan")?.baseUrl).toBe("https://gateway:4000/v1");

    const deleted = await providerPost(f, {
      action: "update",
      id: "llm-lan",
      name: "Renamed",
      baseUrl: "https://gateway:4000/v1",
      models: "deepseek | 2000 | 200",
      delete: "1",
      return_to: "/settings#custom-providers",
    });
    expect(deleted.status).toBe(200);
    expect(f.modelProviders.list()).toEqual([]);
  });

  it("rejects invalid input, duplicate ids, and in-use deletes", async () => {
    const f = fixture();
    const invalid = await createProvider(f, { baseUrl: "ftp://gateway:4000/v1" });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({ code: "VALIDATION" });
    expect(f.modelProviders.list()).toEqual([]);

    expect((await createProvider(f)).status).toBe(200);
    const duplicate = await createProvider(f);
    expect(duplicate.status).toBe(409);
    expect(JSON.parse(duplicate.body)).toMatchObject({ code: "provider_exists" });

    f.settings.set("global", {}, "llm.model", "llm-lan/deepseek", "owner");
    const inUse = await providerPost(f, {
      action: "delete",
      id: "llm-lan",
      return_to: "/settings#custom-providers",
    });
    expect(inUse.status).toBe(409);
    expect(JSON.parse(inUse.body)).toMatchObject({
      code: "provider_in_use",
      references: [{ scope: "global", projectId: "", appKey: "" }],
    });
    expect(f.modelProviders.list()).toHaveLength(1);
  });

  it("rejects agent principals and cross-site mutations", async () => {
    const f = fixture();
    const agent = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/model-providers",
        headers: auth(f.agentToken, {
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: form({
          action: "create",
          id: "llm-lan",
          baseUrl: "http://gateway:4000/v1",
          models: "deepseek | 1 | 1",
        }),
      }),
    );
    expect(agent.status).toBe(403);

    const crossSite = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/model-providers",
        headers: auth(f.token, {
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: form({
          action: "create",
          id: "llm-lan",
          baseUrl: "http://gateway:4000/v1",
          models: "deepseek | 1 | 1",
        }),
        origin: "http://evil.example",
        host: "hanse.local",
      }),
    );
    expect(crossSite.status).toBe(403);
    expect(JSON.parse(crossSite.body)).toMatchObject({ code: "cross_site_request" });
    expect(f.modelProviders.list()).toEqual([]);
  });

  it("returns warnings and model suggestions without exposing keys", async () => {
    const f = fixture();
    f.settings.setProviderKey("global", {}, "llm-lan", "sentinel-key-value", "owner");
    f.modelProviders.create(
      {
        id: "llm-lan",
        name: "LLM LAN",
        baseUrl: "http://127.0.0.1:4000/v1",
        models: [{ id: "deepseek", limit: { context: 1000, output: 100 } }],
      },
      "operator",
    );

    const page = await handleSettings(
      f.deps,
      request({ path: "/settings", headers: htmlAuth(f.token) }),
    );
    expect(page.status).toBe(200);
    expect(page.body).toContain('list="model-options"');
    expect(page.body).toContain('value="llm-lan/deepseek"');
    expect(page.body).toContain("loopback base URL");
    expect(page.body).toContain("provider-key row or host auth");
    expect(page.body).not.toContain("sentinel-key-value");

    const response = await handleSettings(
      f.deps,
      request({
        method: "GET",
        path: "/api/settings/model-providers",
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as {
      providers: unknown[];
      warnings: Record<string, string[]>;
    };
    expect(data.providers).toHaveLength(1);
    expect(data.warnings["llm-lan"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("loopback"),
        expect.stringContaining("provider-key row or host auth"),
      ]),
    );
    expect(response.body).not.toContain("sentinel-key-value");
  });

  it("returns 503 when the provider service is not configured", async () => {
    const f = fixture();
    delete f.deps.modelProviders;
    const response = await handleSettings(
      f.deps,
      request({
        method: "GET",
        path: "/api/settings/model-providers",
        headers: auth(f.token),
      }),
    );
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "model_providers_not_configured",
    });
  });

  it("redirects a no-JavaScript browser form to the custom block", async () => {
    const f = fixture();
    const response = await handleSettings(
      f.deps,
      request({
        method: "POST",
        path: "/api/settings/model-providers",
        headers: auth(f.token, {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: form({
          action: "create",
          id: "llm-lan",
          name: "LLM LAN",
          baseUrl: "http://gateway:4000/v1",
          models: "deepseek | 1000 | 100",
          return_to: "/settings#custom-providers",
        }),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("/settings");
    expect(response.headers?.location).toContain("#custom-providers");
    expect(f.modelProviders.list()).toHaveLength(1);
  });
});
