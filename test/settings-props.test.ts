import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import type { RunSshKeygen } from "../src/git/credentials.js";
import { GitService } from "../src/git/service.js";
import { buildSite } from "../src/http/dashboard.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { buildSettingsProps } from "../src/http/props/settings.js";
import { handleUiApi, maybeServeSpa } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import { mintAgentToken } from "../src/mcp/agent-tokens.js";
import { ModelProviderService } from "../src/model-providers/index.js";
import { SettingsService } from "../src/settings/index.js";
import { ROUTES } from "../src/shared/routes.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const originalLegacy = process.env.HANSE_UI_LEGACY;
const originalAllowlist = process.env.HANSE_UI_SPA_ROUTES;
const originalDevUrl = process.env.HANSE_UI_DEV_URL;

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalLegacy === undefined) delete process.env.HANSE_UI_LEGACY;
  else process.env.HANSE_UI_LEGACY = originalLegacy;
  if (originalAllowlist === undefined) delete process.env.HANSE_UI_SPA_ROUTES;
  else process.env.HANSE_UI_SPA_ROUTES = originalAllowlist;
  if (originalDevUrl === undefined) delete process.env.HANSE_UI_DEV_URL;
  else process.env.HANSE_UI_DEV_URL = originalDevUrl;
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  settings: SettingsService;
  modelProviders: ModelProviderService;
  humanToken: string;
  agentCookieToken: string;
  agentBearerToken: string;
}

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

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-settings-props-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Alpha','main','/workspace/p',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:web','p','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  const service = new CoordinatorService(db, "p");
  const modelProviders = new ModelProviderService({ db });
  const settings = new SettingsService({
    db,
    secretKey: randomBytes(32),
    providerIds: () => modelProviders.list().map((provider) => provider.id),
    runSshKeygen: fakeSshKeygen(),
  });
  const human = createPrincipal(db, { kind: "human", name: "alice" });
  const agent = createPrincipal(db, { kind: "agent", name: "bot" });
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/workspace",
    git: new GitService({ workspaceRoot: "/workspace" }),
    settings,
    modelProviders,
    getProjects: () => [
      {
        id: "p",
        name: "Alpha",
        rootPath: "/workspace/p",
        workspaceRoot: "/workspace",
        service,
      },
    ],
  };
  return {
    db,
    deps,
    settings,
    modelProviders,
    humanToken: human.token,
    agentCookieToken: agent.token,
    agentBearerToken: mintAgentToken(db, "p:web"),
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

function enable(): void {
  delete process.env.HANSE_UI_LEGACY;
  process.env.HANSE_UI_SPA_ROUTES = ROUTES.map((route) => route.id).join(",");
  process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
}

function body<T>(response: ReturnType<typeof handleUiApi>): T {
  return JSON.parse(response?.body ?? "{}") as T;
}

interface Boot {
  route: { id: string };
  props: { scope?: { scope?: string }; rows?: { model?: { effectiveText?: string } } };
}

function boot(markup: string): Boot {
  const match = /<script id="hanse-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(
    markup,
  );
  return JSON.parse(match?.[1] ?? "{}") as Boot;
}

describe("settings props", () => {
  it("builds global rows with defaults, controls, and navigation", () => {
    const f = fixture();
    const props = buildSettingsProps({
      deps: f.deps,
      site: buildSite(f.deps),
      scope: "global",
      target: {},
    });
    expect(props).toBeDefined();
    if (props === undefined) return;
    expect(props.scope).toMatchObject({
      scope: "global",
      scopeLabel: "Global",
      href: "/settings",
      settingsHref: "/settings",
      skillsHref: "/skills",
      projectId: null,
      appKey: null,
    });
    expect(props.scope.hrefs).toEqual({ global: "/settings", project: null, app: null });
    expect(props.scope.projects).toEqual([
      expect.objectContaining({
        projectId: "p",
        href: "/projects/p/settings",
        apps: [
          expect.objectContaining({
            appKey: "web",
            href: "/projects/p/apps/web/settings",
          }),
        ],
      }),
    ]);
    expect(props.rows.model.id).toBe("setting-llm-model");
    expect(props.rows.model.effective).toMatchObject({
      state: "default",
      source: "default",
      text: "deepseek/deepseek-flash",
    });
    expect(props.rows.model.text).toMatchObject({
      value: "",
      placeholder: "Default: deepseek/deepseek-flash",
      required: true,
    });
    expect(props.rows.webSearch.driver?.placeholder?.label).toBe("Choose a driver");
    expect(props.rows.contextEnabled.select?.options).toEqual([
      { value: "true", label: "On", selected: false, disabled: false },
      { value: "false", label: "Off", selected: false, disabled: false },
    ]);
    expect(props.rows.contextPercent.effectiveText).toBe("80%");
    expect(props.restart.restartRequired).toBe(false);
  });

  it("tracks inherited, overridden, and cleared states per scope", () => {
    const f = fixture();
    f.settings.set("global", {}, "llm.model", "global/model", "owner");
    f.settings.set("project", { projectId: "p" }, "llm.model", "project/model", "owner");
    f.settings.set("global", {}, "web.search", { driver: "builtin" }, "owner");
    f.settings.clear("app", { projectId: "p", appKey: "web" }, "web.search", "owner");

    const site = buildSite(f.deps);
    const project = buildSettingsProps({
      deps: f.deps,
      site,
      scope: "project",
      target: { projectId: "p" },
    });
    expect(project?.rows.model.own).toEqual({ state: "set", value: "project/model" });
    expect(project?.rows.model.effectiveText).toBe("project/model");
    expect(project?.rows.model.effective.source).toBe("project");
    expect(project?.rows.webSearch.effective.source).toBe("global");
    expect(project?.rows.webSearch.inheritedNote).toBe(
      "This scope inherits builtin from Global. Saving creates an override.",
    );

    const app = buildSettingsProps({
      deps: f.deps,
      site,
      scope: "app",
      target: { projectId: "p", appKey: "web" },
    });
    expect(app?.rows.model.own).toEqual({ state: "absent", value: null });
    expect(app?.rows.model.text).toMatchObject({
      value: "",
      placeholder: "Inherited: project/model",
    });
    expect(app?.rows.model.effective.source).toBe("project");
    expect(app?.rows.webSearch.own.state).toBe("cleared");
    expect(app?.rows.webSearch.effective).toMatchObject({
      state: "cleared",
      source: "app",
      text: "Cleared",
    });
    expect(app?.rows.webSearch.actions.clear).toMatchObject({
      enabled: false,
      reason: "Already cleared at this scope.",
    });
    expect(app?.rows.webSearch.scopeDetails).toEqual([
      {
        scope: "global",
        label: "Global",
        state: "set",
        stateLabel: "Set",
        valueText: '{"driver":"builtin"}',
      },
      {
        scope: "project",
        label: "Project",
        state: "absent",
        stateLabel: "Inherited",
        valueText: null,
      },
      {
        scope: "app",
        label: "Application",
        state: "cleared",
        stateLabel: "Cleared",
        valueText: null,
      },
    ]);
  });

  it("masks provider keys and git credentials", () => {
    const f = fixture();
    const providerSecret = "sentinel-provider-key";
    const gitSecret = "sentinel-git-token";
    const sshPrivateKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nsentinel-private-body\n-----END OPENSSH PRIVATE KEY-----";
    f.settings.setProviderKey("global", {}, "deepseek", providerSecret, "owner");
    f.modelProviders.create(
      {
        id: "llm-lan",
        name: "LLM LAN",
        baseUrl: "http://gateway.example:4000/v1",
        models: [{ id: "deepseek", limit: { context: 1000000, output: 64000 } }],
      },
      "owner",
    );
    f.settings.setProviderKey("global", {}, "llm-lan", "sentinel-custom-provider-key", "owner");
    f.settings.setGitAuth(
      "global",
      {},
      "https",
      { hosts: ["github.com"], username: "x-access-token", token: gitSecret },
      "owner",
    );
    f.settings.setGitAuth("global", {}, "ssh", { privateKey: sshPrivateKey }, "owner");

    const props = buildSettingsProps({
      deps: f.deps,
      site: buildSite(f.deps),
      scope: "global",
      target: {},
    });
    expect(props).toBeDefined();
    if (props === undefined) return;
    expect(props.providers[0]).toMatchObject({
      provider: "deepseek",
      state: "set",
      configured: true,
      usable: true,
      masked: "Not shown",
    });
    expect(props.modelProviders.providers).toEqual([
      expect.objectContaining({
        id: "llm-lan",
        name: "LLM LAN",
        key: expect.objectContaining({
          state: "set",
          masked: "Not shown",
        }),
      }),
    ]);
    expect(props.git.https).toMatchObject({
      state: "set",
      configured: true,
      hasSecret: true,
      masked: "Not shown",
      effectiveText: "github.com",
    });
    expect(props.git.ssh).toMatchObject({
      state: "set",
      configured: true,
      hasSecret: true,
      masked: "Not shown",
      effectiveText: "ssh-ed25519 AAAAC3NzaFake fake@test",
    });
    expect(props.git.https.details).toEqual({
      publicKey: null,
      fingerprint: null,
      hasKnownHosts: null,
      hosts: ["github.com"],
      username: "x-access-token",
      error: null,
    });
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain(providerSecret);
    expect(serialized).not.toContain("sentinel-custom-provider-key");
    expect(serialized).not.toContain(gitSecret);
    expect(serialized).not.toContain("sentinel-private-body");
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("cipher");
    expect(serialized).not.toContain("sealed");
  });

  it("returns undefined for an unknown project or app", () => {
    const f = fixture();
    const site = buildSite(f.deps);
    expect(
      buildSettingsProps({ deps: f.deps, site, scope: "project", target: { projectId: "nope" } }),
    ).toBeUndefined();
    expect(
      buildSettingsProps({
        deps: f.deps,
        site,
        scope: "app",
        target: { projectId: "p", appKey: "nope" },
      }),
    ).toBeUndefined();
  });
});

describe("GET /api/ui/settings", () => {
  it("returns the cookie-only auth envelope", () => {
    const f = fixture();
    const anonymous = handleUiApi(f.deps, request("/api/ui/settings", {}, { scope: "global" }));
    expect(anonymous).toMatchObject({ status: 401 });
    expect(anonymous?.headers?.["cache-control"]).toBe("no-store");
    expect(body(anonymous)).toEqual({ error: "sign in required", code: "unauthenticated" });

    const bearer = handleUiApi(
      f.deps,
      request("/api/ui/settings", { authorization: `Bearer ${f.humanToken}` }, { scope: "global" }),
    );
    expect(bearer).toMatchObject({ status: 403 });
    expect(body(bearer)).toEqual({ error: "cookie sign-in required", code: "cookie_required" });

    const agent = handleUiApi(
      f.deps,
      request(
        "/api/ui/settings",
        { authorization: `Bearer ${f.agentBearerToken}`, ...cookie(f.humanToken) },
        { scope: "global" },
      ),
    );
    expect(agent).toMatchObject({ status: 403 });
    expect(body(agent)).toEqual({ error: "agent tokens may only call the MCP endpoint" });
  });

  it("returns props plus chrome for every scope", () => {
    const f = fixture();
    f.settings.set("global", {}, "llm.model", "global/model", "owner");
    f.settings.set("project", { projectId: "p" }, "llm.model", "project/model", "owner");

    const global = handleUiApi(
      f.deps,
      request("/api/ui/settings", cookie(f.humanToken), { scope: "global" }),
    );
    expect(global).toMatchObject({ status: 200 });
    expect(global?.headers?.["cache-control"]).toBe("no-store");
    const globalProps = body<{
      rows: { model: { effectiveText: string } };
      chrome: { title: string; active: string };
    }>(global);
    expect(globalProps.rows.model.effectiveText).toBe("global/model");
    expect(globalProps.chrome).toMatchObject({ title: "Settings", active: "settings" });

    const project = handleUiApi(
      f.deps,
      request("/api/ui/settings", cookie(f.humanToken), {
        scope: "project",
        project: "p",
      }),
    );
    const projectProps = body<{
      scope: { scope: string; projectId: string; projectName: string };
      rows: { model: { effectiveText: string } };
      chrome: { activeProjectId?: string };
    }>(project);
    expect(projectProps.scope).toMatchObject({
      scope: "project",
      projectId: "p",
      projectName: "Alpha",
    });
    expect(projectProps.rows.model.effectiveText).toBe("project/model");
    expect(projectProps.chrome.activeProjectId).toBe("p");

    const app = handleUiApi(
      f.deps,
      request("/api/ui/settings", cookie(f.humanToken), {
        scope: "app",
        project: "p",
        app: "web",
      }),
    );
    const appProps = body<{
      scope: { scope: string; appKey: string; appId: string };
      git: { ssh: { allowTest: boolean } };
    }>(app);
    expect(appProps.scope).toMatchObject({ scope: "app", appKey: "web", appId: "p:web" });
    expect(appProps.git.ssh.allowTest).toBe(true);
  });

  it("validates scope and target like the legacy page", () => {
    const f = fixture();
    const missingScope = handleUiApi(f.deps, request("/api/ui/settings", cookie(f.humanToken), {}));
    expect(missingScope).toMatchObject({ status: 400 });
    expect(body<{ error: string }>(missingScope).error).toContain("scope must be");

    const missingProject = handleUiApi(
      f.deps,
      request("/api/ui/settings", cookie(f.humanToken), { scope: "project" }),
    );
    expect(missingProject).toMatchObject({ status: 400 });

    const missingApp = handleUiApi(
      f.deps,
      request("/api/ui/settings", cookie(f.humanToken), { scope: "app", project: "p" }),
    );
    expect(missingApp).toMatchObject({ status: 400 });

    const unknownProject = handleUiApi(
      f.deps,
      request("/api/ui/settings", cookie(f.humanToken), {
        scope: "project",
        project: "nope",
      }),
    );
    expect(unknownProject).toMatchObject({ status: 404 });
    expect(unknownProject?.headers?.["cache-control"]).toBe("no-store");

    const unknownApp = handleUiApi(
      f.deps,
      request("/api/ui/settings", cookie(f.humanToken), {
        scope: "app",
        project: "p",
        app: "nope",
      }),
    );
    expect(unknownApp).toMatchObject({ status: 404 });

    const globalIgnoresTarget = handleUiApi(
      f.deps,
      request("/api/ui/settings", cookie(f.humanToken), {
        scope: "global",
        project: "nope",
        app: "also-nope",
      }),
    );
    expect(globalIgnoresTarget).toMatchObject({ status: 200 });
  });

  it("boots settings props for a settings document without secrets", () => {
    const f = fixture();
    const providerSecret = "sentinel-boot-provider-key";
    f.settings.setProviderKey("global", {}, "deepseek", providerSecret, "owner");
    enable();
    for (const [pathname, scope] of [
      ["/settings", "global"],
      ["/projects/p/settings", "project"],
      ["/projects/p/apps/web/settings", "app"],
    ] as const) {
      const response = maybeServeSpa(
        f.deps,
        request(pathname, { ...cookie(f.humanToken), accept: "text/html" }),
      );
      expect(response?.status, pathname).toBe(200);
      const payload = boot(response?.body ?? "");
      expect(payload.props.scope?.scope, pathname).toBe(scope);
      expect(payload.route.id, pathname).toBe(`settings-${scope}`);
      expect(response?.body, pathname).not.toContain(providerSecret);
    }
  });
});
