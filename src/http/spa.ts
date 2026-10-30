import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { GitStatus } from "../git/service.js";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import { SettingsValidationError } from "../settings/index.js";
import type { SettingsScope, SettingsTarget } from "../settings/types.js";
import {
  isSpaRoute,
  matchPage,
  type PageMatch,
  parseSpaAllowlist,
  ROUTES,
  type RouteId,
  routeById,
} from "../shared/routes.js";
import { SkillService, type SkillTarget } from "../skills/index.js";
import { findApp } from "./apps.js";
import { humanFromCookie } from "./auth.js";
import { buildSite, type SiteModel } from "./dashboard.js";
import {
  agentTokenFor,
  type HttpDeps,
  type HttpRequest,
  type HttpResponse,
  safeDecode,
} from "./handler.js";
import { buildAppProps } from "./props/app.js";
import { buildChatProps, type ChatProps } from "./props/chat.js";
import { buildHandoffsProps } from "./props/handoffs.js";
import { buildOverviewProps } from "./props/overview.js";
import { buildProjectProps } from "./props/project.js";
import { buildProjectsProps } from "./props/projects.js";
import { buildSettingsProps, parseSettingsTarget, type SettingsProps } from "./props/settings.js";
import {
  buildSkillCreateProps,
  buildSkillDetailProps,
  buildSkillsInventoryProps,
  createTargetFromQuery,
  inventoryTargetFromQuery,
  parseInventoryFilter,
  SkillsTargetError,
  type SkillWorkspaceProps,
  targetExists,
} from "./props/skills.js";
import { buildSshProps, resolveSshScope } from "./props/ssh.js";
import { buildTerminalProps, type TerminalProps } from "./props/terminal.js";
import {
  appShell,
  type Crumb,
  escapeHtml,
  icon,
  ideBase,
  type NavProject,
  type Notice,
  renderBreadcrumbInner,
  renderSidebarNavInner,
  type ShellOptions,
  safeLocalPath,
} from "./ui.js";

const UI_BASE = "/assets/ui/";
const MANIFEST_DIR = ".vite";
const MANIFEST_FILE = "manifest.json";
const MAX_CACHE_ENTRIES = 64;

export interface UiManifest {
  readonly entry: string;
  readonly css: readonly string[];
  readonly files: readonly string[];
}

export interface UiManifestOptions {
  readonly assetsRoot?: string;
  readonly logger?: Pick<NonNullable<HttpDeps["logger"]>, "warn">;
}

const reportedManifests = new Set<string>();
const manifestCache = new Map<string, UiManifest | undefined>();

function assetsRoot(): string {
  const configured = process.env.HANSE_ASSETS?.trim();
  return configured === undefined || configured.length === 0
    ? path.join(process.cwd(), "assets")
    : configured;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportInvalid(
  key: string,
  logger: UiManifestOptions["logger"],
  reason: string,
): undefined {
  if (!reportedManifests.has(key)) {
    reportedManifests.add(key);
    if (reportedManifests.size > MAX_CACHE_ENTRIES) {
      const oldest = reportedManifests.values().next().value;
      if (oldest !== undefined) {
        reportedManifests.delete(oldest);
      }
    }
    logger?.warn("ui.manifest_invalid", { reason });
  }
  return undefined;
}

function resolveInside(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    return undefined;
  }
  try {
    const realRoot = realpathSync(normalizedRoot);
    const realResolved = realpathSync(resolved);
    if (realResolved !== realRoot && !realResolved.startsWith(`${realRoot}${path.sep}`)) {
      return undefined;
    }
    return statSync(realResolved).isFile() ? realResolved : undefined;
  } catch {
    return undefined;
  }
}

function toUrl(relative: string): string {
  return `${UI_BASE}${relative.split(path.sep).join("/")}`;
}

function findEntry(manifest: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const [key, value] of Object.entries(manifest)) {
    if (!isRecord(value) || value.isEntry !== true) {
      continue;
    }
    const src = typeof value.src === "string" ? value.src : "";
    if (
      key === "main.ts" ||
      key.endsWith("/main.ts") ||
      src === "main.ts" ||
      src.endsWith("/main.ts")
    ) {
      return value;
    }
  }
  return undefined;
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return value as string[];
}

function readUiManifest(root: string, logger: UiManifestOptions["logger"]): UiManifest | undefined {
  const uiDir = path.join(root, "ui");
  const manifestPath = path.join(uiDir, MANIFEST_DIR, MANIFEST_FILE);

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return reportInvalid(manifestPath, logger, "missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reportInvalid(manifestPath, logger, "invalid_json");
  }
  if (!isRecord(parsed)) {
    return reportInvalid(manifestPath, logger, "invalid_shape");
  }

  const entry = findEntry(parsed);
  if (entry === undefined || typeof entry.file !== "string" || entry.file.length === 0) {
    return reportInvalid(manifestPath, logger, "missing_entry");
  }

  for (const value of Object.values(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    for (const field of ["imports", "dynamicImports"]) {
      const references = strings(value[field]);
      if (references === undefined) {
        return reportInvalid(manifestPath, logger, "invalid_imports");
      }
      for (const reference of references) {
        if (!(reference in parsed)) {
          return reportInvalid(manifestPath, logger, "missing_import");
        }
      }
    }
  }

  const files = new Set<string>();
  for (const value of Object.values(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    const declared = [
      ...(typeof value.file === "string" ? [value.file] : []),
      ...(strings(value.css) ?? []),
      ...(strings(value.assets) ?? []),
    ];
    for (const relative of declared) {
      if (resolveInside(uiDir, relative) === undefined) {
        return reportInvalid(manifestPath, logger, "missing_file");
      }
      files.add(relative);
    }
  }

  const entryFile = entry.file;
  if (!files.has(entryFile)) {
    return reportInvalid(manifestPath, logger, "missing_entry_file");
  }
  const css = strings(entry.css);
  if (css === undefined) {
    return reportInvalid(manifestPath, logger, "invalid_css");
  }

  return {
    entry: toUrl(entryFile),
    css: css.map(toUrl),
    files: [...files].map(toUrl),
  };
}

/** Load and validate `assets/ui/.vite/manifest.json` once; undefined means "serve legacy". */
export function loadUiManifest(options: UiManifestOptions = {}): UiManifest | undefined {
  const root = path.resolve(options.assetsRoot ?? assetsRoot());
  if (!manifestCache.has(root)) {
    manifestCache.set(root, readUiManifest(root, options.logger));
  }
  return manifestCache.get(root);
}

/** Vite dev server base URL, normalized without a trailing slash. */
export function uiDevUrl(): string | undefined {
  const raw = process.env.HANSE_UI_DEV_URL?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  return raw.replace(/\/+$/, "");
}

export function devModuleUrls(devUrl: string): string[] {
  const base = devUrl.replace(/\/+$/, "");
  return [`${base}/assets/ui/@vite/client`, `${base}/assets/ui/main.ts`];
}

/** JSON serializer for the boot payload; `<` is escaped so it cannot close the script element. */
export function serializeBoot(value: unknown): string {
  const json = JSON.stringify(value);
  return (json === undefined ? "null" : json).replace(/</g, "\\u003c");
}

export interface ChromeProps {
  readonly sidebarNav: string;
  readonly breadcrumb: string;
  readonly title: string;
  readonly active: ShellOptions["active"];
  readonly activeProjectId?: string;
  readonly pendingCount: number;
  readonly sshPendingCount: number;
}

export interface ChromeData {
  readonly chrome: ChromeProps;
  readonly title: string;
  readonly active: ShellOptions["active"];
  readonly activeProjectId?: string;
  readonly breadcrumb: Crumb[];
  readonly projects: NavProject[];
  readonly pendingCount: number;
  readonly sshPendingCount: number;
  readonly settingsHref?: string;
  readonly skillsHref?: string;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function scopedHrefs(
  projectId: string | undefined,
  appKey: string | undefined,
): { settings?: string; skills?: string } {
  if (projectId === undefined) {
    return {};
  }
  const base = `/projects/${encoded(projectId)}`;
  if (appKey === undefined) {
    return { settings: `${base}/settings`, skills: `${base}/skills` };
  }
  const appBase = `${base}/apps/${encoded(appKey)}`;
  return { settings: `${appBase}/settings`, skills: `${appBase}/skills` };
}

interface RouteChrome {
  readonly title: string;
  readonly breadcrumb: Crumb[];
}

function routeChrome(
  routeId: RouteId,
  projectId: string | undefined,
  projectName: string | undefined,
  appKey: string | undefined,
): RouteChrome {
  const project: Crumb =
    projectName === undefined
      ? { label: "Project" }
      : projectId === undefined
        ? { label: projectName }
        : { label: projectName, href: `/projects/${encoded(projectId)}` };
  const workbench = { label: "Workbench", href: "/" };
  const projects = { label: "Projects", href: "/projects" };
  switch (routeId) {
    case "overview":
      return { title: "Fleet overview", breadcrumb: [workbench, { label: "Overview" }] };
    case "projects":
      return { title: "Projects", breadcrumb: [workbench, { label: "Projects" }] };
    case "project":
      return {
        title: projectName ?? "Project",
        breadcrumb: [{ label: "Projects", href: "/projects" }, { label: projectName ?? "Project" }],
      };
    case "handoffs":
      return { title: "Handoffs", breadcrumb: [workbench, { label: "Handoffs" }] };
    case "ssh":
      return { title: "SSH", breadcrumb: [workbench, { label: "SSH" }] };
    case "settings-global":
      return { title: "Settings", breadcrumb: [workbench, { label: "Settings" }] };
    case "settings-project":
      return {
        title: "Settings",
        breadcrumb: [projects, project, { label: "Settings" }],
      };
    case "settings-app":
      return {
        title: "Settings",
        breadcrumb: [projects, project, { label: appKey ?? "Application" }, { label: "Settings" }],
      };
    case "skills-global":
      return { title: "Skills", breadcrumb: [workbench, { label: "Skills" }] };
    case "skills-project":
      return {
        title: "Skills",
        breadcrumb: [projects, project, { label: "Skills" }],
      };
    case "skills-app":
      return {
        title: "Skills",
        breadcrumb: [projects, project, { label: appKey ?? "Application" }, { label: "Skills" }],
      };
    case "skills-new":
      return {
        title: "New skill",
        breadcrumb: [{ label: "Skills", href: "/skills" }, { label: "New skill" }],
      };
    case "skills-detail":
      return {
        title: "Skill",
        breadcrumb: [{ label: "Skills", href: "/skills" }, { label: "Skill" }],
      };
    case "app":
      return {
        title: appKey ?? "Application",
        breadcrumb: [projects, project, { label: appKey ?? "Application" }],
      };
    case "chat":
      return {
        title: appKey === undefined ? "Chat" : `${appKey} chat`,
        breadcrumb: [
          projects,
          project,
          {
            label: appKey ?? "Application",
            ...(projectId === undefined || appKey === undefined
              ? {}
              : { href: `/projects/${encoded(projectId)}/apps/${encoded(appKey)}` }),
          },
          { label: "Chat" },
        ],
      };
    case "terminal":
      return {
        title: appKey === undefined ? "Terminal" : `${appKey} terminal`,
        breadcrumb: [
          projects,
          project,
          {
            label: appKey ?? "Application",
            ...(projectId === undefined || appKey === undefined
              ? {}
              : { href: `/projects/${encoded(projectId)}/apps/${encoded(appKey)}` }),
          },
          { label: "Terminal" },
        ],
      };
  }
}

const PROJECT_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
  "project",
  "settings-project",
  "settings-app",
  "skills-project",
  "skills-app",
  "app",
]);
const APP_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>(["settings-app", "skills-app", "app"]);

export interface ChromeScopeHint {
  readonly projectId?: string;
  readonly appKey?: string;
  readonly title?: string;
  readonly breadcrumb?: readonly Crumb[];
}

export function chromeFor(
  site: SiteModel,
  match: PageMatch,
  hint: ChromeScopeHint = {},
): ChromeData {
  const definition = routeById(match.id);
  const projectId = hint.projectId ?? (PROJECT_ROUTES.has(match.id) ? match.params.id : undefined);
  const project =
    projectId === undefined
      ? undefined
      : site.projects.find((candidate) => candidate.id === projectId);
  const appKey = hint.appKey ?? (APP_ROUTES.has(match.id) ? match.params.app : undefined);
  const chromeRoute = routeChrome(match.id, projectId, project?.name, appKey);
  const title = hint.title ?? chromeRoute.title;
  const breadcrumb = hint.breadcrumb === undefined ? chromeRoute.breadcrumb : [...hint.breadcrumb];
  const active = definition?.nav ?? "none";
  const projects: NavProject[] = site.projects.map((entry) => ({
    id: entry.id,
    name: entry.name,
    appCount: entry.apps.length,
  }));
  const scoped = scopedHrefs(projectId, appKey);
  const chrome: ChromeProps = {
    sidebarNav: renderSidebarNavInner({
      active,
      ...(project === undefined ? {} : { activeProjectId: project.id }),
      projects,
      pendingCount: site.pendingCount,
      sshPendingCount: site.sshPendingCount,
      ...(scoped.settings === undefined ? {} : { settingsHref: scoped.settings }),
      ...(scoped.skills === undefined ? {} : { skillsHref: scoped.skills }),
    }),
    breadcrumb: renderBreadcrumbInner(breadcrumb),
    title,
    active,
    ...(project === undefined ? {} : { activeProjectId: project.id }),
    pendingCount: site.pendingCount,
    sshPendingCount: site.sshPendingCount,
  };
  return {
    chrome,
    title,
    active,
    ...(project === undefined ? {} : { activeProjectId: project.id }),
    breadcrumb,
    projects,
    pendingCount: site.pendingCount,
    sshPendingCount: site.sshPendingCount,
    ...(scoped.settings === undefined ? {} : { settingsHref: scoped.settings }),
    ...(scoped.skills === undefined ? {} : { skillsHref: scoped.skills }),
  };
}

/** Derive the scoped chrome for the skills new/detail pages from their page props. */
function skillsChromeHint(match: PageMatch, props: unknown): ChromeScopeHint {
  if (match.id !== "skills-new" && match.id !== "skills-detail") {
    return {};
  }
  if (typeof props !== "object" || props === null) {
    return {};
  }
  const candidate = props as {
    title?: unknown;
    breadcrumb?: unknown;
    scope?: { projectId?: unknown; appKey?: unknown };
  };
  const scope = candidate.scope;
  return {
    ...(typeof scope?.projectId === "string" ? { projectId: scope.projectId } : {}),
    ...(typeof scope?.appKey === "string" ? { appKey: scope.appKey } : {}),
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(Array.isArray(candidate.breadcrumb)
      ? { breadcrumb: candidate.breadcrumb as readonly Crumb[] }
      : {}),
  };
}

export interface SpaTopbar {
  readonly ideHref: string;
  readonly needsInputCount?: number;
  readonly policyVisible?: boolean;
  readonly contextToggle?: boolean;
}

export interface SpaDocumentInput {
  readonly title: string;
  readonly active: ShellOptions["active"];
  readonly activeProjectId?: string;
  readonly breadcrumb: Crumb[];
  readonly projects: NavProject[];
  readonly pendingCount: number;
  readonly sshPendingCount?: number;
  readonly operatorName: string;
  readonly settingsHref?: string;
  readonly skillsHref?: string;
  readonly route: PageMatch;
  readonly props: unknown;
  readonly chrome: ChromeProps;
  readonly spaRoutes: readonly RouteId[];
  readonly topbar?: SpaTopbar;
  readonly pageClass?: string;
  readonly bodyClass?: string;
  readonly viewport?: string;
  readonly topbarActions?: string;
  readonly notice?: Notice;
  readonly manifest?: UiManifest;
  readonly devUrl?: string;
}

export function renderSpaDocument(input: SpaDocumentInput): string {
  const topbar = input.topbar ?? { ideHref: ideBase() };
  const boot = {
    route: input.route,
    props: input.props,
    chrome: input.chrome,
    spaRoutes: input.spaRoutes,
    topbar,
    ...(input.notice === undefined ? {} : { notice: input.notice }),
  };
  const moduleScripts =
    input.devUrl !== undefined
      ? devModuleUrls(input.devUrl)
      : input.manifest === undefined
        ? []
        : [input.manifest.entry];
  const fallback = `<div class="ui-fallback" id="ui-fallback" data-ui-fallback>
      <p class="overline">Interface</p>
      <h2 class="h3">The new interface did not load.</h2>
      <p class="body">Reload the page, or switch to the classic interface.</p>
      <a class="btn btn-secondary btn-sm" href="?legacy=1">Use the classic interface</a>
    </div>`;
  return appShell({
    title: input.title,
    active: input.active,
    ...(input.activeProjectId === undefined ? {} : { activeProjectId: input.activeProjectId }),
    breadcrumb: input.breadcrumb,
    projects: input.projects,
    pendingCount: input.pendingCount,
    ...(input.sshPendingCount === undefined ? {} : { sshPendingCount: input.sshPendingCount }),
    operatorName: input.operatorName,
    ...(input.settingsHref === undefined ? {} : { settingsHref: input.settingsHref }),
    ...(input.skillsHref === undefined ? {} : { skillsHref: input.skillsHref }),
    header: "",
    body: fallback,
    contentScript: false,
    ...(input.pageClass === undefined ? {} : { pageClass: input.pageClass }),
    ...(input.bodyClass === undefined ? {} : { bodyClass: input.bodyClass }),
    ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
    ...(input.topbarActions === undefined ? {} : { topbarActions: input.topbarActions }),
    ...(input.manifest === undefined ? {} : { styles: [...input.manifest.css] }),
    moduleScripts,
    bootJson: `<script id="hanse-boot" type="application/json">${serializeBoot(boot)}</script>`,
  });
}

function noticeFromQuery(request: HttpRequest): Notice | undefined {
  const message = request.query?.notice;
  if (message === undefined || message.trim().length === 0) {
    return undefined;
  }
  return { message, tone: request.query?.tone === "error" ? "error" : "success" };
}

function pagePath(request: HttpRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (key !== "legacy") {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query.length === 0 ? request.path : `${request.path}?${query}`;
}

function loginRedirect(request: HttpRequest): HttpResponse {
  return {
    status: 302,
    contentType: "text/plain; charset=utf-8",
    body: "",
    headers: {
      location: `/login?next=${encodeURIComponent(safeLocalPath(pagePath(request), "/"))}`,
    },
  };
}

function jsonResponse(
  status: number,
  value: unknown,
  headers?: Record<string, string>,
): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    ...(headers === undefined ? {} : { headers }),
  };
}

function logUnknownRoutes(deps: HttpDeps): void {
  const raw = process.env.HANSE_UI_SPA_ROUTES;
  if (raw === undefined || raw.trim().length === 0) {
    return;
  }
  for (const id of parseSpaAllowlist(raw).unknown) {
    deps.logger?.warn("ui.unknown_route", { id });
  }
}

function settingsScopeForMatch(match: PageMatch): {
  scope: SettingsScope;
  target: SettingsTarget;
} {
  if (match.id === "settings-project") {
    return { scope: "project", target: { projectId: match.params.id ?? "" } };
  }
  if (match.id === "settings-app") {
    return {
      scope: "app",
      target: { projectId: match.params.id ?? "", appKey: match.params.app ?? "" },
    };
  }
  return { scope: "global", target: {} };
}

function settingsPropsForMatch(
  deps: HttpDeps,
  site: SiteModel,
  match: PageMatch,
  request: HttpRequest,
): SettingsProps | undefined {
  if (deps.settings === undefined) {
    return undefined;
  }
  const { scope, target } = settingsScopeForMatch(match);
  return buildSettingsProps({
    deps,
    site,
    scope,
    target,
    notice: noticeFromQuery(request) ?? null,
  });
}

function skillsServiceFor(deps: HttpDeps): SkillService | undefined {
  if (deps.skills !== undefined) {
    return deps.skills;
  }
  try {
    return new SkillService({ db: deps.db });
  } catch {
    return undefined;
  }
}

function skillsTargetForMatch(
  match: PageMatch,
): { scope: "global" | "project" | "app"; target: SkillTarget } | undefined {
  if (match.id === "skills-global") {
    return { scope: "global", target: {} };
  }
  if (match.id === "skills-project") {
    return { scope: "project", target: { projectId: match.params.id ?? "" } };
  }
  if (match.id === "skills-app") {
    return {
      scope: "app",
      target: { projectId: match.params.id ?? "", appKey: match.params.app ?? "" },
    };
  }
  return undefined;
}

function parseSkillId(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function skillsInventoryPropsForMatch(
  deps: HttpDeps,
  site: SiteModel,
  match: PageMatch,
  request: HttpRequest,
): ReturnType<typeof buildSkillsInventoryProps> {
  const scopeTarget = skillsTargetForMatch(match);
  const skills = skillsServiceFor(deps);
  if (scopeTarget === undefined || skills === undefined) {
    return undefined;
  }
  return buildSkillsInventoryProps({
    deps,
    site,
    skills,
    scope: scopeTarget.scope,
    target: scopeTarget.target,
    filter: parseInventoryFilter(request.query?.filter),
    search: (request.query?.q ?? "").trim(),
  });
}

function skillCreatePropsFor(
  deps: HttpDeps,
  site: SiteModel,
  request: HttpRequest,
): SkillWorkspaceProps | null {
  let scopeTarget: { scope: "global" | "project" | "app"; target: SkillTarget };
  try {
    scopeTarget = createTargetFromQuery(request.query ?? {});
  } catch (error) {
    if (error instanceof SkillsTargetError) {
      return null;
    }
    throw error;
  }
  if (!targetExists(deps, scopeTarget.scope, scopeTarget.target)) {
    return null;
  }
  return buildSkillCreateProps({
    site,
    scope: scopeTarget.scope,
    target: scopeTarget.target,
  });
}

function skillDetailPropsFor(
  deps: HttpDeps,
  site: SiteModel,
  match: PageMatch,
  request: HttpRequest,
): SkillWorkspaceProps | null {
  const skills = skillsServiceFor(deps);
  const id = parseSkillId(match.params.id);
  if (skills === undefined || id === undefined) {
    return null;
  }
  const row = skills.get(id);
  if (row === undefined) {
    return null;
  }
  return buildSkillDetailProps({
    deps,
    site,
    skills,
    row,
    ...(request.query?.from === undefined ? {} : { from: request.query.from }),
  });
}

function pagePropsFor(
  deps: HttpDeps,
  site: SiteModel,
  match: PageMatch,
  request: HttpRequest,
): unknown {
  if (match.id === "projects") {
    return buildProjectsProps(site, request.query?.q);
  }
  if (match.id === "overview") {
    return buildOverviewProps(site);
  }
  if (match.id === "project") {
    return buildProjectProps(site, match.params.id ?? "") ?? null;
  }
  if (match.id === "app") {
    return (
      buildAppProps({
        site,
        projectId: match.params.id ?? "",
        appKey: match.params.app ?? "",
        runtimeConfigured: deps.manager !== undefined,
        ...(deps.ssh === undefined ? {} : { ssh: deps.ssh }),
        ...(deps.manager === undefined
          ? {}
          : {
              profileWarnings: deps.manager.profileWarnings(
                `${match.params.id ?? ""}:${match.params.app ?? ""}`,
              ),
            }),
      }) ?? null
    );
  }
  if (match.id === "handoffs") {
    return buildHandoffsProps(site, request.query?.filter, request.query?.q);
  }
  if (match.id === "ssh") {
    if (deps.ssh === undefined) {
      return {};
    }
    return buildSshProps({
      ssh: deps.ssh,
      site,
      scope: resolveSshScope(deps, request.query),
    });
  }
  if (
    match.id === "settings-global" ||
    match.id === "settings-project" ||
    match.id === "settings-app"
  ) {
    const props = settingsPropsForMatch(deps, site, match, request);
    return props ?? null;
  }
  if (match.id === "skills-global" || match.id === "skills-project" || match.id === "skills-app") {
    return skillsInventoryPropsForMatch(deps, site, match, request) ?? null;
  }
  if (match.id === "skills-new") {
    return skillCreatePropsFor(deps, site, request);
  }
  if (match.id === "skills-detail") {
    return skillDetailPropsFor(deps, site, match, request);
  }
  if (match.id === "chat") {
    return chatPropsFor(deps, site, request);
  }
  if (match.id === "terminal") {
    return terminalPropsFor(site, request);
  }
  return {};
}

function workspaceApp(request: HttpRequest): { projectId?: string; appKey: string } {
  const projectId = request.query?.project?.trim();
  return {
    ...(projectId === undefined || projectId.length === 0 ? {} : { projectId }),
    appKey: request.query?.app?.trim() ?? "",
  };
}

/**
 * Chat boot props. Records the operator host only when the request carries a host, matching the
 * legacy `GET /chat` guard. Missing app/project returns null so the legacy redirect/404 stays in
 * force until Stage 9.
 */
function chatPropsFor(deps: HttpDeps, site: SiteModel, request: HttpRequest): ChatProps | null {
  const { projectId, appKey } = workspaceApp(request);
  if (appKey.length === 0) {
    return null;
  }
  const found = findApp(deps, projectId, appKey);
  if (found === undefined) {
    return null;
  }
  if (request.host !== undefined) {
    deps.previews?.recordOperatorHost(found.app.id, request.host);
  }
  const previews = deps.previews?.views(found.app.id) ?? [];
  return (
    buildChatProps({
      site,
      projectId: found.project.id,
      appKey: found.app.appKey,
      previews,
    }) ?? null
  );
}

function terminalPropsFor(site: SiteModel, request: HttpRequest): TerminalProps | null {
  const { projectId, appKey } = workspaceApp(request);
  if (projectId === undefined || appKey.length === 0) {
    return null;
  }
  return buildTerminalProps({ site, projectId, appKey }) ?? null;
}

/** Server first-paint topbar markup for the chat control set; terminal/default use appShell's IDE action. */
function renderChatTopbarActions(topbar: SpaTopbar): string {
  if (topbar.contextToggle !== true) {
    return `<a class="btn btn-ghost btn-icon" href="${escapeHtml(topbar.ideHref)}" target="_blank" rel="noreferrer" aria-label="Open application in IDE" title="Open in IDE">${icon("external")}</a>`;
  }
  const count = topbar.needsInputCount ?? 0;
  return `<button class="btn btn-ghost btn-sm chat-input-needed" id="chat-input-needed" type="button" aria-haspopup="dialog" aria-controls="chat-queue" aria-expanded="false" aria-label="No requests need input"${count === 0 ? " hidden" : ""}>${icon("message")}<span class="chat-input-needed__count" id="chat-input-needed-count" aria-hidden="true">${count}</span></button><button class="btn btn-ghost btn-sm policy-chip" id="chat-policy-chip" type="button" aria-controls="chat-policy-warning" aria-expanded="false"${topbar.policyVisible === true ? "" : " hidden"}>${icon("alert-triangle")}<span id="chat-policy-chip-label">Policy warning</span></button><button class="btn btn-ghost btn-icon chat-context-toggle" type="button" data-chat-context-toggle aria-controls="chat-context" aria-expanded="false" aria-label="Open context panel" title="Context panel">${icon("panel-right")}</button><a class="btn btn-ghost btn-icon" href="${escapeHtml(topbar.ideHref)}" target="_blank" rel="noreferrer" aria-label="Open application in IDE" title="Open in IDE">${icon("external")}</a>`;
}

interface WorkspaceShellInput {
  readonly pageClass: string;
  readonly bodyClass: string;
  readonly viewport?: string;
  readonly title: string;
  readonly breadcrumb: readonly Crumb[];
  readonly projectId: string;
  readonly appKey: string;
  readonly topbar: SpaTopbar;
  readonly topbarActions?: string;
}

function workspaceShellFor(match: PageMatch, props: unknown): WorkspaceShellInput | undefined {
  if (match.id === "chat") {
    const chat = props as ChatProps;
    return {
      pageClass: "page--chat",
      bodyClass: "page__body--chat",
      viewport: "width=device-width, initial-scale=1, interactive-widget=resizes-content",
      title: chat.title,
      breadcrumb: chat.breadcrumb,
      projectId: chat.app.projectId,
      appKey: chat.app.appKey,
      topbar: chat.topbar,
      topbarActions: renderChatTopbarActions(chat.topbar),
    };
  }
  if (match.id === "terminal") {
    const terminal = props as TerminalProps;
    return {
      pageClass: "page--terminal",
      bodyClass: "page__body--terminal",
      title: terminal.title,
      breadcrumb: terminal.breadcrumb,
      projectId: terminal.app.projectId,
      appKey: terminal.app.appKey,
      topbar: terminal.topbar,
    };
  }
  return undefined;
}

function agentForbidden(): HttpResponse {
  return jsonResponse(403, { error: "agent tokens may only call the MCP endpoint" });
}

/**
 * Single page-dispatch point for the SPA. Returns undefined to let the legacy renderer handle the
 * request: non-HTML, non-page, disabled, `?legacy=1`, or an invalid/missing manifest.
 */
export function maybeServeSpa(deps: HttpDeps, request: HttpRequest): HttpResponse | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return undefined;
  }
  const accept = request.headers.accept ?? "";
  if (!accept.includes("text/html") && !accept.includes("application/xhtml+xml")) {
    return undefined;
  }
  const match = matchPage(request.path);
  if (match === undefined) {
    return undefined;
  }

  const presented = agentTokenFor(request);
  if (presented !== undefined && verifyAgentToken(deps.db, presented) !== undefined) {
    return agentForbidden();
  }
  if (request.query?.legacy === "1") {
    return undefined;
  }

  logUnknownRoutes(deps);
  const devUrl = uiDevUrl();
  const spaRoutes = ROUTES.filter((route) => isSpaRoute(route.id, { manifestValid: true })).map(
    (route) => route.id,
  );
  if (!spaRoutes.includes(match.id)) {
    return undefined;
  }
  const manifest =
    devUrl === undefined
      ? loadUiManifest({ ...(deps.logger === undefined ? {} : { logger: deps.logger }) })
      : undefined;
  if (devUrl === undefined && manifest === undefined) {
    return undefined;
  }

  const principal = humanFromCookie(deps, request);
  if (principal === undefined) {
    return loginRedirect(request);
  }

  const site = buildSite(deps);
  const props = pagePropsFor(deps, site, match, request);
  if ((match.id === "chat" || match.id === "terminal") && props === null) {
    return undefined;
  }
  const workspace = workspaceShellFor(match, props);
  const data = chromeFor(
    site,
    match,
    workspace === undefined
      ? skillsChromeHint(match, props)
      : {
          title: workspace.title,
          breadcrumb: workspace.breadcrumb,
          projectId: workspace.projectId,
          appKey: workspace.appKey,
        },
  );
  const notice = noticeFromQuery(request);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: { "cache-control": "no-store" },
    body: renderSpaDocument({
      title: data.title,
      active: data.active,
      ...(data.activeProjectId === undefined ? {} : { activeProjectId: data.activeProjectId }),
      breadcrumb: data.breadcrumb,
      projects: data.projects,
      pendingCount: data.pendingCount,
      sshPendingCount: data.sshPendingCount,
      operatorName: principal.name,
      ...(data.settingsHref === undefined ? {} : { settingsHref: data.settingsHref }),
      ...(data.skillsHref === undefined ? {} : { skillsHref: data.skillsHref }),
      route: match,
      props,
      chrome: data.chrome,
      spaRoutes,
      ...(workspace === undefined
        ? {}
        : {
            topbar: workspace.topbar,
            pageClass: workspace.pageClass,
            bodyClass: workspace.bodyClass,
            ...(workspace.viewport === undefined ? {} : { viewport: workspace.viewport }),
            ...(workspace.topbarActions === undefined
              ? {}
              : { topbarActions: workspace.topbarActions }),
          }),
      ...(notice === undefined ? {} : { notice }),
      ...(devUrl === undefined ? {} : { devUrl }),
      ...(manifest === undefined ? {} : { manifest }),
    }),
  };
}

const UI_API_PATHS = new Set([
  "/api/ui/projects",
  "/api/ui/chrome",
  "/api/ui/overview",
  "/api/ui/handoffs",
  "/api/ui/ssh",
  "/api/ui/settings",
  "/api/ui/skills",
  "/api/ui/chat",
  "/api/ui/terminal",
]);
const UI_SKILL_PATH = /^\/api\/ui\/skills\/([^/]+)$/;
const UI_PROJECT_PATH = /^\/api\/ui\/projects\/([^/]+)$/;
const UI_APP_PATH = /^\/api\/ui\/apps\/([^/]+)$/;

function uiProjectId(pathname: string): string | undefined {
  const match = UI_PROJECT_PATH.exec(pathname);
  const raw = match?.[1];
  return raw === undefined ? undefined : safeDecode(raw);
}

function uiSkillPath(pathname: string): string | undefined {
  const match = UI_SKILL_PATH.exec(pathname);
  const raw = match?.[1];
  return raw === undefined ? undefined : safeDecode(raw);
}

function uiAppKey(pathname: string): string | undefined {
  const match = UI_APP_PATH.exec(pathname);
  const raw = match?.[1];
  return raw === undefined ? undefined : safeDecode(raw);
}

/** True for the async application-detail endpoint so the server can await it separately. */
export function isAppUiPath(pathname: string): boolean {
  return UI_APP_PATH.test(pathname);
}

/** Shared cookie-only auth envelope for `/api/ui/*`: agent tokens and human bearers are rejected. */
function authorizeUiRead(deps: HttpDeps, request: HttpRequest): HttpResponse | undefined {
  const presented = agentTokenFor(request);
  if (presented !== undefined && verifyAgentToken(deps.db, presented) !== undefined) {
    return agentForbidden();
  }
  if (humanFromCookie(deps, request) !== undefined) {
    return undefined;
  }
  const authorization = request.headers.authorization?.trim();
  if (authorization !== undefined && authorization.length > 0) {
    return jsonResponse(
      403,
      { error: "cookie sign-in required", code: "cookie_required" },
      {
        "cache-control": "no-store",
      },
    );
  }
  return jsonResponse(
    401,
    { error: "sign in required", code: "unauthenticated" },
    {
      "cache-control": "no-store",
    },
  );
}

/** Cookie-only `/api/ui/*` JSON endpoints. Agent bearer tokens and human bearers are rejected. */
export function handleUiApi(deps: HttpDeps, request: HttpRequest): HttpResponse | undefined {
  if (request.method !== "GET") {
    return undefined;
  }
  const projectId = uiProjectId(request.path);
  const skillPath = uiSkillPath(request.path);
  if (!UI_API_PATHS.has(request.path) && projectId === undefined && skillPath === undefined) {
    return undefined;
  }
  const authFailure = authorizeUiRead(deps, request);
  if (authFailure !== undefined) {
    return authFailure;
  }

  logUnknownRoutes(deps);
  const site = buildSite(deps);

  if (request.path === "/api/ui/chrome") {
    const pathname = safeLocalPath(request.query?.path, "/");
    const match = matchPage(pathname);
    if (match === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    const projectId = request.query?.project?.trim();
    const appKey = request.query?.app?.trim();
    const hint = {
      ...(projectId === undefined || projectId.length === 0 ? {} : { projectId }),
      ...(appKey === undefined || appKey.length === 0 ? {} : { appKey }),
    };
    return jsonResponse(200, chromeFor(site, match, hint).chrome, {
      "cache-control": "no-store",
    });
  }

  if (request.path === "/api/ui/chat") {
    const projectId = request.query?.project?.trim();
    const appKey = request.query?.app?.trim() ?? "";
    const found =
      appKey.length === 0
        ? undefined
        : findApp(
            deps,
            projectId === undefined || projectId.length === 0 ? undefined : projectId,
            appKey,
          );
    if (found === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    if (request.host !== undefined) {
      deps.previews?.recordOperatorHost(found.app.id, request.host);
    }
    const previews = deps.previews?.views(found.app.id) ?? [];
    const props = buildChatProps({
      site,
      projectId: found.project.id,
      appKey: found.app.appKey,
      previews,
    });
    if (props === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    const match: PageMatch = { id: "chat", params: {} };
    const chrome = chromeFor(site, match, {
      projectId: props.app.projectId,
      appKey: props.app.appKey,
      title: props.title,
      breadcrumb: props.breadcrumb,
    }).chrome;
    return jsonResponse(200, { ...props, chrome }, { "cache-control": "no-store" });
  }

  if (request.path === "/api/ui/terminal") {
    const projectId = request.query?.project?.trim() ?? "";
    const appKey = request.query?.app?.trim() ?? "";
    const props =
      projectId.length === 0 || appKey.length === 0
        ? undefined
        : buildTerminalProps({ site, projectId, appKey });
    if (props === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    const match: PageMatch = { id: "terminal", params: {} };
    const chrome = chromeFor(site, match, {
      projectId: props.app.projectId,
      appKey: props.app.appKey,
      title: props.title,
      breadcrumb: props.breadcrumb,
    }).chrome;
    return jsonResponse(200, { ...props, chrome }, { "cache-control": "no-store" });
  }

  if (request.path === "/api/ui/overview") {
    const match: PageMatch = { id: "overview", params: {} };
    return jsonResponse(
      200,
      { ...buildOverviewProps(site), chrome: chromeFor(site, match).chrome },
      { "cache-control": "no-store" },
    );
  }

  if (request.path === "/api/ui/handoffs") {
    const match: PageMatch = { id: "handoffs", params: {} };
    return jsonResponse(
      200,
      {
        ...buildHandoffsProps(site, request.query?.filter, request.query?.q),
        chrome: chromeFor(site, match).chrome,
      },
      { "cache-control": "no-store" },
    );
  }

  if (request.path === "/api/ui/ssh") {
    if (deps.ssh === undefined) {
      return jsonResponse(503, { error: "ssh_unavailable" }, { "cache-control": "no-store" });
    }
    const match: PageMatch = { id: "ssh", params: {} };
    return jsonResponse(
      200,
      {
        ...buildSshProps({
          ssh: deps.ssh,
          site,
          scope: resolveSshScope(deps, request.query),
        }),
        chrome: chromeFor(site, match).chrome,
      },
      { "cache-control": "no-store" },
    );
  }

  if (request.path === "/api/ui/settings") {
    if (deps.settings === undefined) {
      return jsonResponse(
        503,
        { error: "settings are not configured" },
        { "cache-control": "no-store" },
      );
    }
    let scope: SettingsScope;
    let target: SettingsTarget;
    try {
      ({ scope, target } = parseSettingsTarget(request.query ?? {}));
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return jsonResponse(400, { error: error.message }, { "cache-control": "no-store" });
      }
      throw error;
    }
    const props = buildSettingsProps({
      deps,
      site,
      scope,
      target,
      notice: noticeFromQuery(request) ?? null,
    });
    if (props === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    const match: PageMatch = {
      id:
        scope === "global"
          ? "settings-global"
          : scope === "project"
            ? "settings-project"
            : "settings-app",
      params: {
        ...(scope === "global" ? {} : { id: target.projectId ?? "" }),
        ...(scope === "app" ? { app: target.appKey ?? "" } : {}),
      },
    };
    return jsonResponse(
      200,
      { ...props, chrome: chromeFor(site, match).chrome },
      { "cache-control": "no-store" },
    );
  }

  if (request.path === "/api/ui/skills") {
    const skills = skillsServiceFor(deps);
    if (skills === undefined) {
      return jsonResponse(
        503,
        { error: "skills are not available", code: "skills_unavailable" },
        { "cache-control": "no-store" },
      );
    }
    let scope: "global" | "project" | "app";
    let target: SkillTarget;
    try {
      ({ scope, target } = inventoryTargetFromQuery(request.query ?? {}));
    } catch (error) {
      if (error instanceof SkillsTargetError) {
        return jsonResponse(
          400,
          { error: error.message, code: error.code },
          { "cache-control": "no-store" },
        );
      }
      throw error;
    }
    const props = buildSkillsInventoryProps({
      deps,
      site,
      skills,
      scope,
      target,
      filter: parseInventoryFilter(request.query?.filter),
      search: (request.query?.q ?? "").trim(),
    });
    if (props === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    const match: PageMatch = {
      id:
        scope === "global"
          ? "skills-global"
          : scope === "project"
            ? "skills-project"
            : "skills-app",
      params: {
        ...(scope === "global" ? {} : { id: target.projectId ?? "" }),
        ...(scope === "app" ? { app: target.appKey ?? "" } : {}),
      },
    };
    return jsonResponse(
      200,
      { ...props, chrome: chromeFor(site, match).chrome },
      { "cache-control": "no-store" },
    );
  }

  if (skillPath !== undefined) {
    const skillId = parseSkillId(skillPath);
    if (skillId === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    const skills = skillsServiceFor(deps);
    if (skills === undefined) {
      return jsonResponse(
        503,
        { error: "skills are not available", code: "skills_unavailable" },
        { "cache-control": "no-store" },
      );
    }
    const row = skills.get(skillId);
    if (row === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    const props = buildSkillDetailProps({
      deps,
      site,
      skills,
      row,
      ...(request.query?.from === undefined ? {} : { from: request.query.from }),
    });
    const match: PageMatch = { id: "skills-detail", params: { id: String(skillId) } };
    return jsonResponse(
      200,
      { ...props, chrome: chromeFor(site, match, skillsChromeHint(match, props)).chrome },
      { "cache-control": "no-store" },
    );
  }

  if (projectId !== undefined) {
    const props = buildProjectProps(site, projectId);
    if (props === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    const match: PageMatch = { id: "project", params: { id: projectId } };
    return jsonResponse(
      200,
      { ...props, chrome: chromeFor(site, match).chrome },
      { "cache-control": "no-store" },
    );
  }

  const match = matchPage("/projects");
  if (match === undefined) {
    return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
  }
  const chrome = chromeFor(site, match).chrome;
  return jsonResponse(
    200,
    { ...buildProjectsProps(site, request.query?.q), chrome },
    { "cache-control": "no-store" },
  );
}

/**
 * `GET /api/ui/apps/:app?project=` - cookie-only application detail read endpoint.
 *
 * The legacy page hydrates git through `git.js`; the SPA endpoint reads the same status once on
 * the server so boot props and a refresh return one shape. This is a read: it never fetches,
 * commits, pushes, builds, restarts, or writes anything.
 */
export async function handleAppUiApi(
  deps: HttpDeps,
  request: HttpRequest,
): Promise<HttpResponse | undefined> {
  if (request.method !== "GET") {
    return undefined;
  }
  const appKey = uiAppKey(request.path);
  if (appKey === undefined) {
    return undefined;
  }
  const authFailure = authorizeUiRead(deps, request);
  if (authFailure !== undefined) {
    return authFailure;
  }

  logUnknownRoutes(deps);
  const site = buildSite(deps);
  const projectId = request.query?.project ?? "";
  const input = {
    site,
    projectId,
    appKey,
    runtimeConfigured: deps.manager !== undefined,
    ...(deps.ssh === undefined ? {} : { ssh: deps.ssh }),
    ...(deps.manager === undefined
      ? {}
      : { profileWarnings: deps.manager.profileWarnings(`${projectId}:${appKey}`) }),
  };
  const base = buildAppProps(input);
  if (base === undefined) {
    return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
  }

  let gitStatus: GitStatus | null = null;
  let gitError: string | null = null;
  try {
    gitStatus = await deps.git.statusFor(
      base.identity.rootPath,
      base.identity.folder,
      base.identity.id,
    );
  } catch (error) {
    gitError =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.message
        : "Repository status is unavailable.";
  }
  const props = buildAppProps({ ...input, gitStatus, gitError }) ?? base;
  const match: PageMatch = { id: "app", params: { id: projectId, app: appKey } };
  return jsonResponse(
    200,
    { ...props, chrome: chromeFor(site, match).chrome },
    { "cache-control": "no-store" },
  );
}
