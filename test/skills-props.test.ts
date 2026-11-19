import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { buildSite } from "../src/http/dashboard.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { buildSettingsProps, SETTINGS_SECTION_KEYS } from "../src/http/props/settings.js";
import {
  buildSkillCreateProps,
  buildSkillDetailProps,
  buildSkillsInventoryProps,
} from "../src/http/props/skills.js";
import { handleUiApi, maybeServeSpa } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import { mintAgentToken } from "../src/mcp/agent-tokens.js";
import { SettingsService } from "../src/settings/index.js";
import {
  type EffectiveSkill,
  type ResolvedSkills,
  SkillService,
  type SkillSource,
  type SkillSummary,
  type SkillWarning,
} from "../src/skills/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
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
  if (originalDevUrl === undefined) delete process.env.HANSE_UI_DEV_URL;
  else process.env.HANSE_UI_DEV_URL = originalDevUrl;
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  skills: SkillService;
  settings: SettingsService;
  humanToken: string;
  agentCookieToken: string;
  agentBearerToken: string;
  appDir: string;
  log: { warn: ReturnType<typeof vi.fn> };
}

function fixture(options: { pending?: boolean } = {}): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-skills-props-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  const projectRoot = path.join(workspace, "p1");
  const appDir = path.join(projectRoot, "apps", "web");
  mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(path.join(projectRoot, "apps", "api"), { recursive: true });
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Alpha','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p1:web','p1','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p1:api','p1','api','apps/api','app','AGENTS.md',?)",
  ).run(now);
  const service = new CoordinatorService(db, "p1");
  const skills = new SkillService({ db });
  const settings = new SettingsService({ db, secretKey: randomBytes(32) });
  const human = createPrincipal(db, { kind: "human", name: "alice" });
  const agentPrincipal = createPrincipal(db, { kind: "agent", name: "bot" });
  const agentBearerToken = mintAgentToken(db, "p1:web");
  const log = { warn: vi.fn() };
  const deps: HttpDeps = {
    db,
    workspaceRoot: workspace,
    git: new GitService({ workspaceRoot: workspace }),
    skills,
    settings,
    agentsHome: path.join(dir, "agents"),
    baselinePlugins: [],
    logger: { debug: vi.fn(), info: vi.fn(), warn: log.warn, error: vi.fn() },
    ...(options.pending === true
      ? { manager: { pendingRestart: () => ({ pending: true, reasons: ["skills"] }) } }
      : {}),
    getProjects: () => [
      {
        id: "p1",
        name: "Alpha",
        rootPath: projectRoot,
        workspaceRoot: workspace,
        service,
      },
    ],
  };
  return {
    db,
    deps,
    skills,
    settings,
    humanToken: human.token,
    agentCookieToken: agentPrincipal.token,
    agentBearerToken,
    appDir,
    log,
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
  return {
    method: "GET",
    path: pathname,
    headers: { "x-hanse-ui-version": "2", ...headers },
    ...(query === undefined ? {} : { query }),
  };
}

function json<T>(response: ReturnType<typeof handleUiApi>): T {
  return JSON.parse(response?.body ?? "{}") as T;
}

function enable(f: Fixture): void {
  process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
  f.log.warn.mockClear();
}

function boot(markup: string): {
  route: { id: string };
  props: Record<string, unknown>;
  chrome: Record<string, unknown>;
} {
  const match = /<script id="hanse-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(
    markup,
  );
  return JSON.parse(match?.[1] ?? "{}") as {
    route: { id: string };
    props: Record<string, unknown>;
    chrome: Record<string, unknown>;
  };
}

function stubSource(resolved: ResolvedSkills, truncated?: number): SkillSource {
  return {
    capture: () => {
      throw new Error("capture is not used");
    },
    resolve: () => resolved,
    preview: () => ({
      resolved,
      warnings: resolved.warnings,
      ...(truncated === undefined ? {} : { truncated }),
    }),
    hash: () => undefined,
    probe: () => {
      throw new Error("probe is not used");
    },
    apply: () => {
      throw new Error("apply is not used");
    },
  };
}

const EXTERNAL_PUBLISHED_AT = "2026-11-11T10:00:00.000Z";

function externalSkill(overrides: Partial<EffectiveSkill> = {}): EffectiveSkill {
  return {
    id: null,
    name: "external-skill",
    description: "External description",
    content: "",
    license: null,
    compatibility: null,
    metadata: {},
    references: [{ path: "references/guide.md", size: 5 }],
    source: null,
    shadows: [],
    shadowedExternal: false,
    mode: "external",
    origin: {
      sourceId: "source-1",
      sourceName: "Hub One",
      bucket: "default",
      revision: "rev-9",
      snapshotId: "snapshot-9",
      publishedAt: EXTERNAL_PUBLISHED_AT,
    },
    externalKey: "source-1:default:external-skill",
    fileCount: 2,
    updatedAt: EXTERNAL_PUBLISHED_AT,
    updatedBy: "source:hub",
    ...overrides,
  };
}

function managedEffective(overrides: Partial<EffectiveSkill> = {}): EffectiveSkill {
  return {
    id: 1,
    name: "managed-skill",
    description: "Managed description",
    content: "body",
    license: null,
    compatibility: null,
    metadata: {},
    references: [],
    source: "global",
    shadows: [],
    shadowedExternal: false,
    mode: "managed",
    origin: null,
    externalKey: null,
    fileCount: 1,
    updatedAt: "2026-11-01T10:00:00.000Z",
    updatedBy: "owner",
    ...overrides,
  };
}

function managedSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: 1,
    scope: "global",
    projectId: "",
    appKey: "",
    name: "managed-skill",
    description: "Managed description",
    content: "body",
    license: null,
    compatibility: null,
    metadata: {},
    references: [],
    fileCount: 0,
    enabled: true,
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    updatedBy: "owner",
    storedIssues: [],
    origin: "local",
    forkedFromSourceId: null,
    forkedFromName: null,
    forkedFromRevision: null,
    ...overrides,
  };
}

function resolvedSkills(overrides: Partial<ResolvedSkills> = {}): ResolvedSkills {
  return {
    scope: "global",
    effective: [],
    rows: [],
    disabled: [],
    warnings: [],
    ...overrides,
  };
}

describe("skills props", () => {
  it("characterizes inventory rows, scope hrefs, filters, and counts", () => {
    const f = fixture();
    f.skills.create(
      "global",
      {},
      { name: "shared", description: "Global shared", content: "global body" },
      "owner",
    );
    f.skills.create(
      "global",
      {},
      { name: "global-only", description: "Global only", content: "global body" },
      "owner",
    );
    f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "project-only", description: "Project only", content: "project body" },
      "owner",
    );
    f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "shared", description: "Project override", content: "project body" },
      "owner",
    );
    const tombstone = f.skills.create(
      "app",
      { projectId: "p1", appKey: "web" },
      { name: "global-only", description: "Tombstone", content: "hidden", enabled: false },
      "owner",
    );

    const props = buildSkillsInventoryProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      scope: "project",
      target: { projectId: "p1" },
      filter: "all",
      search: "",
    });
    expect(props).toBeDefined();
    if (props === undefined) return;
    expect(props.scope).toMatchObject({
      scope: "project",
      scopeLabel: "Project",
      projectId: "p1",
      projectName: "Alpha",
      href: "/projects/p1/skills",
      createHref: "/skills/new?scope=project&project=p1",
      nav: {
        globalHref: "/skills",
        projectHref: "/projects/p1/skills",
        appHref: null,
        currentScope: "project",
      },
    });
    expect(props.filters.map((entry) => entry.value)).toEqual([
      "all",
      "defined",
      "inherited",
      "external",
      "disabled",
      "invalid",
    ]);
    expect(props.filters[0]).toMatchObject({
      label: "All",
      href: "/projects/p1/skills",
      current: true,
    });
    expect(props.createHref).toBe("/skills/new?scope=project&project=p1");
    expect(props.counts).toEqual({
      enabled: 2,
      inherited: 1,
      external: 0,
      disabled: 0,
      invalid: 0,
    });
    const shared = props.rows.find((row) => row.name === "shared");
    expect(shared).toMatchObject({
      scope: "project",
      state: "enabled",
      stateLabel: "Enabled here",
      enabled: true,
      overridden: true,
      shadowed: false,
      shadows: ["global"],
      originText: "Overrides Global",
      href: expect.stringMatching(/^\/skills\/\d+\?from=/),
    });
    const inherited = props.rows.find((row) => row.name === "global-only");
    expect(inherited).toMatchObject({
      scope: "global",
      state: "inherited",
      stateLabel: "Inherited",
      enabled: true,
      originText: "Inherited from Global",
    });
    expect(inherited?.actionLabel).toBe("Open global-only");

    const appProps = buildSkillsInventoryProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      scope: "app",
      target: { projectId: "p1", appKey: "web" },
      filter: "all",
      search: "",
    });
    expect(appProps?.scope.scope).toBe("app");
    expect(appProps?.rows.find((row) => row.name === "global-only")).toMatchObject({
      state: "disabled",
      stateLabel: "Disabled here",
    });

    const projectProps = buildSkillsInventoryProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      scope: "project",
      target: { projectId: "p1" },
      filter: "disabled",
      search: "",
    });
    expect(projectProps?.empty).toMatchObject({
      kind: "filter",
      title: "No skills match this filter",
      actionLabel: "Show all skills",
    });
    expect(tombstone.id).toBeGreaterThan(0);
  });

  it("marks a disabled scoped row as hidden at the application scope", () => {
    const f = fixture();
    f.skills.create(
      "global",
      {},
      { name: "global-only", description: "Global only", content: "global body" },
      "owner",
    );
    f.skills.create(
      "app",
      { projectId: "p1", appKey: "web" },
      { name: "global-only", description: "Tombstone", content: "hidden", enabled: false },
      "owner",
    );
    const props = buildSkillsInventoryProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      scope: "app",
      target: { projectId: "p1", appKey: "web" },
      filter: "all",
      search: "",
    });
    const row = props?.rows.find((entry) => entry.name === "global-only");
    expect(row).toMatchObject({
      state: "disabled",
      stateLabel: "Disabled here",
      enabled: false,
      originText: "Inherited from Global",
    });
  });

  it("builds new-skill props with target fields, defaults, and help text", () => {
    const f = fixture();
    const props = buildSkillCreateProps({
      site: buildSite(f.deps),
      scope: "app",
      target: { projectId: "p1", appKey: "web" },
    });
    expect(props.create).toBe(true);
    expect(props.values).toMatchObject({
      name: "",
      description: "",
      content: "",
      enabled: true,
      bundle: {
        license: null,
        compatibility: null,
        metadata: {},
        metadataRaw: null,
        references: [],
      },
    });
    expect(props.form).toMatchObject({
      action: "/api/skills",
      mode: "create",
      name: "",
      target: {
        scope: "app",
        projectId: "p1",
        appKey: "web",
        returnTo: "/projects/p1/apps/web/skills",
      },
      saveLabel: "Create skill",
      discardLabel: "Discard",
    });
    expect(props.form?.nameField).toMatchObject({
      value: "",
      required: true,
      hint: "Lowercase letters, digits, and single hyphens.",
    });
    expect(props.actions.override).toBeNull();
    expect(props.danger).toBeNull();
    expect(props.files).toEqual([]);
    expect(props.row).toMatchObject({ createdAt: null, updatedBy: null });
    expect(props.breadcrumb.at(-1)).toEqual({ label: "New skill" });
    expect(props.title).toBe("New skill");
  });

  it("builds detail props for an editable app override with bundle and references", () => {
    const f = fixture();
    const row = f.skills.create(
      "app",
      { projectId: "p1", appKey: "web" },
      {
        name: "detail-skill",
        description: "Detail description",
        content: "# Body\n\nText.",
        license: "MIT",
        compatibility: "Node >= 20",
        metadata: { role: "engineer", version: "1.2.3" },
        references: [{ path: "references/guide.md", content: "Guide body" }],
      },
      "owner",
    );
    const props = buildSkillDetailProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      row,
    });
    expect(props.create).toBe(false);
    expect(props.state).toMatchObject({
      name: "editable",
      label: "Enabled here",
      editable: true,
      contextScope: "app",
    });
    expect(props.visibility).toMatchObject({
      enabled: true,
      overridden: false,
      shadowed: false,
    });
    expect(props.row).toMatchObject({ id: row.id, name: "detail-skill", scope: "app" });
    expect(props.values.bundle).toMatchObject({
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { role: "engineer", version: "1.2.3" },
    });
    expect(props.values.bundle.references).toEqual([
      { path: "references/guide.md", content: "Guide body", size: 10 },
    ]);
    expect(props.values.content).toBe("# Body\n\nText.");
    expect(props.form).toMatchObject({
      action: `/api/skills/${row.id}`,
      mode: "update",
      saveLabel: "Save changes",
      discardLabel: "Discard changes",
    });
    expect(props.form?.bundleSnapshot).not.toContain("metadataRaw");
    expect(props.header.backHref).toBeNull();
    expect(props.actions).toMatchObject({
      override: null,
      disable: null,
      revert: null,
    });
    expect(props.danger).toMatchObject({
      action: `/api/skills/${row.id}/delete`,
      label: "Delete skill",
      expectedName: "detail-skill",
    });
    expect(props.scope.href).toBe("/projects/p1/apps/web/skills");
    expect(props.scope.nav.appHref).toBe("/projects/p1/apps/web/skills");
  });

  it("characterizes inherited, shadowed, hidden, and invalid detail states", () => {
    const f = fixture();
    const global = f.skills.create(
      "global",
      {},
      { name: "shared", description: "Global shared", content: "global body" },
      "owner",
    );
    const project = f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "shared", description: "Project shared", content: "project body" },
      "owner",
    );
    const tombstone = f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "shared-hidden", description: "Project hidden", content: "hidden", enabled: false },
      "owner",
    );
    f.skills.create(
      "global",
      {},
      { name: "shared-hidden", description: "Global hidden", content: "global hidden" },
      "owner",
    );

    const shadowed = buildSkillDetailProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      row: global,
      from: "/projects/p1/skills",
    });
    expect(shadowed.state).toMatchObject({ name: "shadowed", label: "Shadowed" });
    expect(shadowed.visibility).toMatchObject({ overridden: true, shadowed: true });
    expect(shadowed.actions.openEffective?.href).toContain(`/skills/${project.id}?from=`);

    const inherited = buildSkillDetailProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      row: global,
      from: "/projects/p1/apps/web/skills",
    });
    expect(inherited.state).toMatchObject({ name: "shadowed" });

    const hidden = buildSkillDetailProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      row: global,
      context: { scope: "project", target: { projectId: "p1" } },
    });
    expect(hidden.state.name).toBe("shadowed");

    const hiddenTombstone = buildSkillDetailProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      row: f.skills.get(tombstone.id) as typeof tombstone,
      context: {
        scope: "project",
        target: { projectId: "p1" },
      },
    });
    expect(hiddenTombstone.state).toMatchObject({ name: "tombstone", label: "Disabled here" });
    expect(hiddenTombstone.actions.revert).toBeNull();
    expect(hiddenTombstone.danger?.label).toBe("Revert to inherited");
  });

  it("surfaces stored issues and repair anchors without leaking metadata raw", () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "broken", description: "Broken", content: "body" },
      "owner",
    );
    f.db.pragma("ignore_check_constraints = ON");
    try {
      f.db.prepare("UPDATE skills SET metadata_json = ? WHERE id = ?").run("{not json", row.id);
    } finally {
      f.db.pragma("ignore_check_constraints = OFF");
    }
    const fresh = f.skills.get(row.id);
    expect(fresh).toBeDefined();
    if (fresh === undefined) return;
    const props = buildSkillDetailProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      row: fresh,
    });
    expect(props.state.name).toBe("invalid-owned");
    expect(props.issues).toEqual([
      {
        code: "invalid_skill_metadata",
        message: expect.stringContaining("The stored metadata is not valid JSON"),
        anchor: "#skill-metadata-raw",
      },
    ]);
    expect(props.values.bundle.metadataRaw).toBe("{not json");
  });

  it("includes the restart banner entries for a stale running app", () => {
    const f = fixture({ pending: true });
    const row = f.skills.create(
      "global",
      {},
      { name: "pending", description: "Pending", content: "body" },
      "owner",
    );
    const props = buildSkillDetailProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      row,
    });
    expect(props.restart).toMatchObject({ kind: "required" });
    expect(props.restart?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: "p1", appKey: "web", returnTo: `/skills/${row.id}` }),
      ]),
    );
  });
});

describe("external inventory props", () => {
  it("projects external rows with a structured origin and excludes them from inherited", () => {
    const f = fixture();
    const external = externalSkill();
    const inherited = managedEffective({ id: 2, name: "managed-inherited" });
    const resolved = resolvedSkills({ effective: [inherited, external] });
    const source = stubSource(resolved);
    const build = (
      filter: Parameters<typeof buildSkillsInventoryProps>[0]["filter"],
      search = "",
    ) =>
      buildSkillsInventoryProps({
        deps: f.deps,
        site: buildSite(f.deps),
        skills: source,
        scope: "global",
        target: {},
        filter,
        search,
      });

    const all = build("all");
    expect(all?.counts).toEqual({ enabled: 0, inherited: 1, external: 1, disabled: 0, invalid: 0 });
    const row = all?.rows.find((entry) => entry.name === "external-skill");
    expect(row).toMatchObject({
      id: null,
      primaryId: null,
      href: null,
      mode: "external",
      externalKey: "source-1:default:external-skill",
      state: "inherited",
      fileCount: 2,
      origin: {
        sourceId: "source-1",
        sourceName: "Hub One",
        bucket: "default",
        revision: "rev-9",
        snapshotId: "snapshot-9",
        publishedAt: EXTERNAL_PUBLISHED_AT,
      },
    });
    expect(row?.originText).toBe("Hub · Hub One");

    expect(build("external")?.rows.map((entry) => entry.name)).toEqual(["external-skill"]);
    expect(build("inherited")?.rows.map((entry) => entry.name)).toEqual(["managed-inherited"]);
    expect(build("all", "hub one")?.rows.map((entry) => entry.name)).toEqual(["external-skill"]);
    expect(build("all", "default")?.rows.map((entry) => entry.name)).toEqual(["external-skill"]);
    expect(build("all", "no-match")?.rows).toEqual([]);
  });

  it("uses a scoped row's own file count and the effective count only for effective-only rows", () => {
    const f = fixture();
    const effective = managedEffective({ id: 5, name: "files", fileCount: 3 });
    const summary = managedSummary({
      id: 5,
      name: "files",
      fileCount: 4,
      references: [{ path: "references/a.md", size: 1 }],
    });
    const effectiveOnly = managedEffective({ id: 6, name: "wider", fileCount: 2 });
    const props = buildSkillsInventoryProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: stubSource(
        resolvedSkills({ effective: [effective, effectiveOnly], rows: [summary] }),
      ),
      scope: "global",
      target: {},
      filter: "all",
      search: "",
    });
    const row = props?.rows.find((entry) => entry.name === "files");
    expect(row).toMatchObject({ mode: "managed", fileCount: 4, references: 1, origin: null });
    const inherited = props?.rows.find((entry) => entry.name === "wider");
    expect(inherited).toMatchObject({
      mode: "managed",
      state: "inherited",
      fileCount: 2,
    });
  });

  it("builds attention from all rows, ordered and capped", () => {
    const f = fixture();
    const resolved = resolvedSkills({
      scope: "app",
      rows: [
        managedSummary({
          id: 1,
          name: "bad",
          scope: "app",
          storedIssues: [{ code: "invalid_skill_metadata", detail: "bad json" }],
        }),
        managedSummary({
          id: 2,
          name: "bad2",
          scope: "app",
          storedIssues: [{ code: "invalid_skill_metadata", detail: "other" }],
        }),
        managedSummary({ id: 3, name: "clash", scope: "app" }),
        managedSummary({ id: 4, name: "tomb", scope: "app", enabled: false }),
        managedSummary({ id: 5, name: "muted", scope: "app", enabled: false }),
        managedSummary({ id: 6, name: "fine", scope: "app" }),
      ],
      disabled: [
        { id: 4, name: "tomb", source: "global", disabledBy: "app" },
        { id: 5, name: "muted", source: null, disabledBy: "app" },
      ],
      warnings: [{ code: "skill_collision", name: "clash", root: "/repo" }],
    });
    const source = stubSource(resolved, 4);
    const build = (
      filter: Parameters<typeof buildSkillsInventoryProps>[0]["filter"],
      search = "",
    ) =>
      buildSkillsInventoryProps({
        deps: f.deps,
        site: buildSite(f.deps),
        skills: source,
        scope: "app",
        target: { projectId: "p1", appKey: "web" },
        filter,
        search,
      });

    const all = build("all");
    expect(all?.attention).toMatchObject({
      count: 4,
      omitted: 1,
      truncated: 4,
      active: false,
      href: "/projects/p1/apps/web/skills?filter=attention",
      clearHref: "/projects/p1/apps/web/skills",
    });
    expect(all?.attention.items.map((item) => [item.name, item.tone])).toEqual([
      ["bad", "invalid"],
      ["bad2", "invalid"],
      ["clash", "collision"],
    ]);
    expect(all?.attention.items[0]?.reason).toContain("not valid JSON");
    expect(all?.attention.items[2]?.reason).toContain("also exists at");
    expect(all?.filters).toHaveLength(6);
    expect(all?.filters.map((entry) => entry.value)).not.toContain("attention");

    const only = build("attention");
    expect(only?.rows.map((entry) => entry.name)).toEqual(["bad", "bad2", "clash", "tomb"]);
    expect(only?.attention).toMatchObject({ count: 4, active: true });
    expect(only?.allCount).toBe(6);
    expect(only?.matchedCount).toBe(4);

    const searched = build("attention", "bad");
    expect(searched?.attention.href).toBe("/projects/p1/apps/web/skills?filter=attention&q=bad");
    expect(searched?.attention.clearHref).toBe("/projects/p1/apps/web/skills?q=bad");
    expect(searched?.matchedCount).toBe(2);
  });

  it("projects content-free files and row timestamps in the workspace props", () => {
    const f = fixture();
    const row = f.skills.create(
      "app",
      { projectId: "p1", appKey: "web" },
      {
        name: "files-skill",
        description: "Files",
        content: "body",
        files: [{ path: "scripts/run.sh", text: "echo hi", executable: true }],
      },
      "owner",
    );
    const props = buildSkillDetailProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: f.skills,
      row,
    });
    expect(props.files).toEqual([{ path: "scripts/run.sh", size: 7, executable: true }]);
    expect(props.files[0]).not.toHaveProperty("content");
    expect(props.row).toMatchObject({ createdAt: row.createdAt, updatedBy: "owner" });
  });

  it("carries source names in warnings and in the managed collision list", () => {
    const f = fixture();
    const winner = managedEffective({ id: 7, name: "shadow", description: "local" });
    const summary = managedSummary({ id: 7, name: "shadow", description: "local" });
    const warnings: SkillWarning[] = [
      {
        code: "skill_source_conflict",
        name: "shadow",
        sourceName: "Hub One",
        sourceSlug: "hub",
      },
      {
        code: "skill_source_stale",
        sourceName: "Hub One",
        sourceSlug: "hub",
        lastSuccessAt: "2026-11-10T00:00:00.000Z",
      },
      {
        code: "skill_source_quarantined",
        name: "bad",
        root: "source-1",
        sourceName: "Hub One",
        sourceSlug: "hub",
      },
    ];
    const props = buildSkillsInventoryProps({
      deps: f.deps,
      site: buildSite(f.deps),
      skills: stubSource(resolvedSkills({ effective: [winner], rows: [summary], warnings })),
      scope: "global",
      target: {},
      filter: "all",
      search: "",
    });
    const row = props?.rows.find((entry) => entry.name === "shadow");
    expect(row?.collisions).toEqual([
      expect.objectContaining({
        code: "skill_source_conflict",
        sourceName: "Hub One",
        sourceSlug: "hub",
        text: '"shadow" is also provided by Hub One but this local skill wins.',
      }),
    ]);
    expect(props?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "skill_source_conflict",
          text: '"shadow" is also provided by Hub One but this local skill wins.',
        }),
        expect.objectContaining({
          code: "skill_source_stale",
          text: "Hub One has not synced since 2026-11-10T00:00:00.000Z.",
        }),
        expect.objectContaining({
          code: "skill_source_quarantined",
          text: '"bad" from Hub One was quarantined and is not available.',
        }),
      ]),
    );
  });

  it("provides the Skill sources settings section label", () => {
    const f = fixture();
    expect(SETTINGS_SECTION_KEYS).toContain("sources");
    const props = buildSettingsProps({
      deps: f.deps,
      site: buildSite(f.deps),
      scope: "global",
      target: {},
    });
    expect(props?.labels.sections.sources).toBe("Skill sources");
    expect(props?.labels.nav.sections.sources).toBe("Skill sources");
  });
});

describe("/api/ui/skills endpoints", () => {
  it("applies the cookie-only auth envelope to inventory and detail", () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "one", description: "One", content: "body" },
      "owner",
    );
    for (const pathname of ["/api/ui/skills", `/api/ui/skills/${row.id}`]) {
      const anonymous = handleUiApi(f.deps, request(pathname, {}));
      expect(anonymous?.status, pathname).toBe(401);
      expect(anonymous?.headers?.["cache-control"], pathname).toBe("no-store");
      expect(json(anonymous), pathname).toEqual({
        error: "sign in required",
        code: "unauthenticated",
      });

      const bearer = handleUiApi(
        f.deps,
        request(pathname, { authorization: `Bearer ${f.humanToken}` }),
      );
      expect(bearer?.status, pathname).toBe(403);
      expect(json(bearer), pathname).toEqual({
        error: "cookie sign-in required",
        code: "cookie_required",
      });

      const agent = handleUiApi(
        f.deps,
        request(pathname, {
          authorization: `Bearer ${f.agentBearerToken}`,
          cookie: `hanse_token=${encodeURIComponent(f.humanToken)}`,
        }),
      );
      expect(agent?.status, pathname).toBe(403);
      expect(json(agent), pathname).toEqual({
        error: "agent tokens may only call the MCP endpoint",
      });

      const anonymousCookie = handleUiApi(f.deps, request(pathname, cookie(f.agentCookieToken)));
      expect(anonymousCookie?.status, pathname).toBe(401);
    }
  });

  it("reads the inventory through effectiveSkills but keeps managed detail", () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "managed-one", description: "Managed", content: "body" },
      "owner",
    );
    f.deps.effectiveSkills = stubSource(
      resolvedSkills({ effective: [externalSkill()], warnings: [] }),
    );
    const inventory = handleUiApi(f.deps, request("/api/ui/skills", cookie(f.humanToken)));
    expect(inventory?.status).toBe(200);
    expect(json<{ rows: Array<{ name: string; mode: string }> }>(inventory).rows).toEqual([
      expect.objectContaining({ name: "external-skill", mode: "external" }),
    ]);

    const detail = handleUiApi(f.deps, request(`/api/ui/skills/${row.id}`, cookie(f.humanToken)));
    expect(detail?.status).toBe(200);
    expect(json<Record<string, unknown>>(detail).name).toBe("managed-one");
  });

  it("returns inventory props plus chrome and validates the requested scope", () => {
    const f = fixture();
    f.skills.create(
      "global",
      {},
      { name: "alpha", description: "Alpha", content: "body" },
      "owner",
    );
    const global = handleUiApi(f.deps, request("/api/ui/skills", cookie(f.humanToken)));
    expect(global).toMatchObject({ status: 200 });
    expect(global?.headers?.["cache-control"]).toBe("no-store");
    const payload = json<{
      rows: Array<{ name: string; state: string }>;
      counts: Record<string, number>;
      scope: Record<string, unknown>;
      chrome: Record<string, unknown>;
    }>(global);
    expect(payload.rows).toEqual([expect.objectContaining({ name: "alpha", state: "enabled" })]);
    expect(payload.counts).toEqual({
      enabled: 1,
      inherited: 0,
      external: 0,
      disabled: 0,
      invalid: 0,
    });
    expect(payload.scope).toMatchObject({ scope: "global", href: "/skills" });
    expect(payload.chrome).toMatchObject({ title: "Skills", active: "skills" });

    const project = handleUiApi(
      f.deps,
      request("/api/ui/skills", cookie(f.humanToken), { scope: "project", project: "p1" }),
    );
    expect(project).toMatchObject({ status: 200 });
    expect(json<{ scope: Record<string, unknown> }>(project).scope).toMatchObject({
      scope: "project",
      projectId: "p1",
    });

    const app = handleUiApi(
      f.deps,
      request("/api/ui/skills", cookie(f.humanToken), {
        scope: "app",
        project: "p1",
        app: "web",
      }),
    );
    expect(app).toMatchObject({ status: 200 });
    expect(json<{ chrome: Record<string, unknown> }>(app).chrome).toMatchObject({
      title: "Skills",
      active: "skills",
      activeProjectId: "p1",
    });
  });

  it("returns 400 for invalid scope/target combinations", () => {
    const f = fixture();
    for (const query of [
      { scope: "bogus" },
      { scope: "global", project: "p1" },
      { scope: "project" },
      { scope: "app", project: "p1" },
      { scope: "app", app: "web" },
    ]) {
      const response = handleUiApi(f.deps, request("/api/ui/skills", cookie(f.humanToken), query));
      expect(response?.status, JSON.stringify(query)).toBe(400);
      expect(json(response), JSON.stringify(query)).toMatchObject({
        code: "invalid_scope_target",
      });
      expect(response?.headers?.["cache-control"]).toBe("no-store");
    }
  });

  it("returns 404 for an unknown project, app, or skill", () => {
    const f = fixture();
    for (const query of [
      { scope: "project", project: "missing" },
      { scope: "app", project: "p1", app: "missing" },
    ]) {
      const response = handleUiApi(f.deps, request("/api/ui/skills", cookie(f.humanToken), query));
      expect(response?.status, JSON.stringify(query)).toBe(404);
      expect(response?.headers?.["cache-control"]).toBe("no-store");
    }
    for (const pathname of ["/api/ui/skills/9999", "/api/ui/skills/not-a-number"]) {
      const response = handleUiApi(f.deps, request(pathname, cookie(f.humanToken)));
      expect(response?.status, pathname).toBe(404);
      expect(response?.headers?.["cache-control"], pathname).toBe("no-store");
    }
  });

  it("returns detail props with source, references, visibility, and actions", () => {
    const f = fixture();
    const row = f.skills.create(
      "app",
      { projectId: "p1", appKey: "web" },
      {
        name: "workspace",
        description: "Workspace",
        content: "# Body",
        metadata: { version: "1.0.0" },
        references: [{ path: "references/a.md", content: "A" }],
      },
      "owner",
    );
    const response = handleUiApi(
      f.deps,
      request(`/api/ui/skills/${row.id}`, cookie(f.humanToken), {
        from: "/projects/p1/apps/web/skills",
      }),
    );
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    const payload = json<Record<string, unknown>>(response);
    expect(payload).toMatchObject({
      create: false,
      id: row.id,
      name: "workspace",
      title: "workspace",
      state: { name: "editable", label: "Enabled here" },
      visibility: { enabled: true, overridden: false, shadowed: false },
      values: {
        content: "# Body",
        bundle: {
          metadata: { version: "1.0.0" },
          references: [{ path: "references/a.md", content: "A", size: 1 }],
        },
      },
      chrome: { title: "workspace", active: "skills" },
    });
    expect(payload.actions).toMatchObject({
      target: {
        scope: "app",
        projectId: "p1",
        appKey: "web",
        returnTo: "/projects/p1/apps/web/skills",
      },
    });
  });

  it("never leaks settings/provider/git sentinels through skills props, endpoints, or boot", () => {
    const f = fixture();
    const providerSecret = "sentinel-skills-provider-key";
    const gitSecret = "sentinel-skills-git-token";
    const settingSecret = "sentinel-skills-setting-value";
    f.settings.setProviderKey("global", {}, "deepseek", providerSecret, "owner");
    f.settings.setGitAuth(
      "global",
      {},
      "https",
      { hosts: ["github.com"], username: "x-access-token", token: gitSecret },
      "owner",
    );
    f.settings.set("global", {}, "git.user.name", settingSecret, "owner");
    const row = f.skills.create(
      "global",
      {},
      { name: "visible", description: "Visible skill", content: "visible body" },
      "owner",
    );

    for (const pathname of ["/api/ui/skills", `/api/ui/skills/${row.id}`]) {
      const response = handleUiApi(f.deps, request(pathname, cookie(f.humanToken)));
      expect(response?.status, pathname).toBe(200);
      expect(response?.body, pathname).not.toContain(providerSecret);
      expect(response?.body, pathname).not.toContain(gitSecret);
      expect(response?.body, pathname).not.toContain(settingSecret);
    }
    expect(handleUiApi(f.deps, request("/api/ui/skills", cookie(f.humanToken)))?.body).toContain(
      "visible",
    );

    enable(f);
    for (const pathname of [
      "/skills",
      "/projects/p1/skills",
      "/projects/p1/apps/web/skills",
      "/skills/new",
      `/skills/${row.id}`,
    ]) {
      const page = maybeServeSpa(
        f.deps,
        request(
          pathname,
          { ...cookie(f.humanToken), accept: "text/html" },
          pathname === "/skills/new" ? { scope: "global" } : undefined,
        ),
      );
      expect(page?.status, pathname).toBe(200);
      expect(page?.body, pathname).not.toContain(providerSecret);
      expect(page?.body, pathname).not.toContain(gitSecret);
      expect(page?.body, pathname).not.toContain(settingSecret);
      const payload = boot(page?.body ?? "");
      expect(payload.route.id, pathname).toMatch(/^skills-/);
      expect(JSON.stringify(payload.props), pathname).not.toContain(providerSecret);
      expect(JSON.stringify(payload.props), pathname).not.toContain(gitSecret);
      expect(JSON.stringify(payload.props), pathname).not.toContain(settingSecret);
    }
  });

  it("boots all five skills routes with props and chrome after cutover", () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "boot", description: "Boot", content: "body" },
      "owner",
    );
    enable(f);
    const pages: Array<[string, string, Record<string, string> | undefined]> = [
      ["/skills", "skills-global", undefined],
      ["/projects/p1/skills", "skills-project", undefined],
      ["/projects/p1/apps/web/skills", "skills-app", undefined],
      ["/skills/new", "skills-new", { scope: "global" }],
      [`/skills/${row.id}`, "skills-detail", undefined],
    ];
    for (const [pathname, id, query] of pages) {
      const response = maybeServeSpa(
        f.deps,
        request(pathname, { ...cookie(f.humanToken), accept: "text/html" }, query),
      );
      expect(response?.status, pathname).toBe(200);
      const payload = boot(response?.body ?? "");
      expect(payload.route.id, pathname).toBe(id);
      expect(payload.chrome, pathname).toMatchObject({ active: "skills" });
      if (id === "skills-detail") {
        expect(payload.props.name).toBe("boot");
      }
      if (id === "skills-new") {
        expect(payload.props.create).toBe(true);
      }
    }
  });
});
