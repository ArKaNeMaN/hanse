import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { GitStatus } from "../git/service.js";
import { isMasterProject, masterChatHref } from "../master/constants.js";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import { SettingsValidationError } from "../settings/index.js";
import type { SettingsScope, SettingsTarget } from "../settings/types.js";
import { setBounded } from "../shared/bounded-cache.js";
import {
  isPublicRoute,
  matchPage,
  type PageMatch,
  type RouteId,
  routeById,
  routeKey,
} from "../shared/routes.js";
import { SkillService, type SkillTarget } from "../skills/index.js";
import { findApp } from "./apps.js";
import { humanFromCookie } from "./auth.js";
import { buildSite, operatorProjects, type SiteModel } from "./dashboard.js";
import {
  agentTokenFor,
  type HttpDeps,
  type HttpRequest,
  type HttpResponse,
  safeDecode,
} from "./handler.js";
import { isHtmlPageRequest } from "./page-request.js";
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
import { staticErrorResponse } from "./static-error.js";
import {
  type Crumb,
  documentPage,
  ideBase,
  initials,
  type NavProject,
  type Notice,
  type ShellOptions,
  safeLocalPath,
  spaShell,
} from "./ui.js";
import { requireUiVersion } from "./ui-version.js";

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
    setBounded(manifestCache, root, readUiManifest(root, options.logger), MAX_CACHE_ENTRIES);
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

export interface ChromeData {
  readonly title: string;
  readonly active: ShellOptions["active"];
  readonly activeProjectId?: string;
  readonly breadcrumb: readonly Crumb[];
  readonly projects: readonly NavProject[];
  readonly masterHref: string;
  readonly pendingCount: number;
  readonly sshPendingCount: number;
  readonly settingsHref?: string;
  readonly skillsHref?: string;
}

export interface BootOperator {
  readonly name: string;
  readonly initials: string;
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
    case "login":
      return { title: "Sign in", breadcrumb: [{ label: "Sign in" }] };
    case "not-found":
      return { title: "Page not found", breadcrumb: [{ label: "Not found" }] };
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
  const projects: NavProject[] = site.projects
    .filter((entry) => !isMasterProject(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      appCount: entry.apps.length,
    }));
  const scoped = scopedHrefs(projectId, appKey);
  return {
    title,
    active,
    ...(project === undefined ? {} : { activeProjectId: project.id }),
    breadcrumb,
    projects,
    masterHref: masterChatHref(),
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
  readonly route: PageMatch;
  readonly props: unknown;
  readonly chrome: ChromeData;
  readonly routeKey: string;
  readonly operator?: BootOperator;
  readonly topbar?: SpaTopbar;
  readonly pageClass?: string;
  readonly bodyClass?: string;
  readonly viewport?: string;
  readonly notice?: Notice;
  readonly manifest?: UiManifest;
  readonly devUrl?: string;
  readonly override?: "not-found" | "chat-no-apps";
}

export function renderSpaDocument(input: SpaDocumentInput): string {
  const topbar = input.topbar ?? { ideHref: ideBase() };
  const boot = {
    route: input.route,
    props: input.props,
    chrome: input.chrome,
    routeKey: input.routeKey,
    ...(input.operator === undefined ? {} : { operator: input.operator }),
    topbar,
    ...(input.notice === undefined ? {} : { notice: input.notice }),
    ...(input.override === undefined ? {} : { override: input.override }),
  };
  const moduleScripts =
    input.devUrl !== undefined
      ? devModuleUrls(input.devUrl)
      : input.manifest === undefined
        ? []
        : [input.manifest.entry];
  return spaShell({
    ...(input.pageClass === undefined ? {} : { pageClass: input.pageClass }),
    ...(input.bodyClass === undefined ? {} : { bodyClass: input.bodyClass }),
    ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
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

function pageRequestPath(request: HttpRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    params.set(key, value);
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
      location: `/login?next=${encodeURIComponent(safeLocalPath(pageRequestPath(request), "/"))}`,
    },
  };
}

function loginNext(request: HttpRequest): string {
  const target = safeLocalPath(request.query?.next, "/");
  return target === "/login" || target.startsWith("/login?") ? "/" : target;
}

/**
 * Public SPA login document.
 *
 * The document is a static shell; Vue owns the login form and requires JavaScript.
 */
function renderLoginSpaDocument(input: {
  readonly match: PageMatch;
  readonly next: string;
  readonly routeKey: string;
  readonly manifest?: UiManifest;
  readonly devUrl?: string;
}): HttpResponse {
  const boot = {
    route: input.match,
    props: { next: input.next },
    chrome: {
      title: "Sign in",
      active: "none",
      breadcrumb: [],
      projects: [],
      masterHref: masterChatHref(),
      pendingCount: 0,
      sshPendingCount: 0,
    },
    routeKey: input.routeKey,
    topbar: { ideHref: ideBase() },
  };
  const moduleScripts =
    input.devUrl !== undefined
      ? devModuleUrls(input.devUrl)
      : input.manifest === undefined
        ? []
        : [input.manifest.entry];
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: { "cache-control": "no-store" },
    body: documentPage({
      title: "Sign in - hanse",
      ...(input.manifest === undefined ? {} : { styles: [...input.manifest.css] }),
      moduleScripts,
      bootJson: `<script id="hanse-boot" type="application/json">${serializeBoot(boot)}</script>`,
      body: `<main class="cover chart-ground" id="main"></main>
    <noscript><p class="caption">Sign-in requires JavaScript.</p></noscript>
    <div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="false"></div>`,
    }),
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
 * Chat boot props. Records the operator host only when the request carries a host. Missing
 * app/project returns null; `maybeServeSpa` owns the retired-route redirect/404.
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

interface WorkspaceShellInput {
  readonly pageClass: string;
  readonly bodyClass: string;
  readonly viewport?: string;
  readonly title: string;
  readonly breadcrumb: readonly Crumb[];
  readonly projectId: string;
  readonly appKey: string;
  readonly topbar: SpaTopbar;
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
  return jsonResponse(
    403,
    { error: "agent tokens may only call the MCP endpoint" },
    { "cache-control": "no-store" },
  );
}

function staticError(status: number, title: string, message: string): HttpResponse {
  return staticErrorResponse({
    status,
    title,
    message,
    action: { href: "/", label: "Open overview" },
  });
}

function staticBuildMissing(): HttpResponse {
  return staticErrorResponse({
    status: 503,
    title: "Interface unavailable",
    message: "This deployment has no SPA build. Redeploy the image with the UI build included.",
    action: { href: "/", label: "Reload overview" },
  });
}

function serveNotFound(
  deps: HttpDeps,
  request: HttpRequest,
  principal: { name: string },
  input: { site?: SiteModel; manifest?: UiManifest; devUrl?: string },
): HttpResponse {
  const site = input.site ?? buildSite(deps);
  const route: PageMatch = { id: "not-found", params: {} };
  const chrome = chromeFor(site, route, {
    title: "Page not found",
    breadcrumb: [{ label: "Not found" }],
  });
  return htmlResponse(
    404,
    renderSpaDocument({
      route,
      props: {},
      chrome,
      routeKey: routeKey(route.id, route.params, request.query ?? {}),
      operator: { name: principal.name, initials: initials(principal.name) },
      override: "not-found",
      ...(input.devUrl === undefined ? {} : { devUrl: input.devUrl }),
      ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
    }),
  );
}

function serveChatNoApps(
  site: SiteModel,
  request: HttpRequest,
  principal: { name: string },
  input: { manifest?: UiManifest; devUrl?: string },
): HttpResponse {
  const route: PageMatch = { id: "chat", params: {} };
  const chrome = chromeFor(site, route, {
    title: "Chat",
    breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Chat" }],
  });
  return htmlResponse(
    200,
    renderSpaDocument({
      route,
      props: { noApps: true },
      chrome,
      routeKey: routeKey(route.id, route.params, request.query ?? {}),
      operator: { name: principal.name, initials: initials(principal.name) },
      override: "chat-no-apps",
      ...(input.devUrl === undefined ? {} : { devUrl: input.devUrl }),
      ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
    }),
  );
}

function firstOperatorApp(
  site: SiteModel,
): { project: { id: string }; app: { appKey: string } } | undefined {
  return operatorProjects(site).flatMap((project) =>
    project.apps.map((app) => ({ project, app })),
  )[0];
}

/**
 * Single page-dispatch point for the SPA. Every known page route is always served by the SPA;
 * unknown page-like paths get a Vue 404. Returns undefined only for non-page requests.
 */
export function maybeServeSpa(deps: HttpDeps, request: HttpRequest): HttpResponse | undefined {
  if (!isHtmlPageRequest(request)) {
    return undefined;
  }

  const presented = agentTokenFor(request);
  if (presented !== undefined && verifyAgentToken(deps.db, presented) !== undefined) {
    return agentForbidden();
  }

  const match = matchPage(request.path);
  const devUrl = uiDevUrl();
  const manifest =
    devUrl === undefined
      ? loadUiManifest({ ...(deps.logger === undefined ? {} : { logger: deps.logger }) })
      : undefined;
  const uiAvailable = devUrl !== undefined || manifest !== undefined;
  const principal = humanFromCookie(deps, request);

  if (match === undefined) {
    if (!uiAvailable) {
      return staticError(404, "Page not found", "Nothing is moored here.");
    }
    if (principal === undefined) {
      return loginRedirect(request);
    }
    return serveNotFound(deps, request, principal, {
      ...(devUrl === undefined ? {} : { devUrl }),
      ...(manifest === undefined ? {} : { manifest }),
    });
  }

  if (isPublicRoute(match.id)) {
    const next = loginNext(request);
    if (principal !== undefined) {
      return redirectTo(next);
    }
    if (!uiAvailable) {
      return staticBuildMissing();
    }
    return renderLoginSpaDocument({
      match,
      next,
      routeKey: routeKey(match.id, match.params, request.query ?? {}),
      ...(devUrl === undefined ? {} : { devUrl }),
      ...(manifest === undefined ? {} : { manifest }),
    });
  }

  if (!uiAvailable) {
    return staticBuildMissing();
  }
  if (principal === undefined) {
    return loginRedirect(request);
  }

  const site = buildSite(deps);
  if (match.id === "chat") {
    const { appKey } = workspaceApp(request);
    if (appKey.length === 0) {
      const first = firstOperatorApp(site);
      if (first === undefined) {
        return serveChatNoApps(site, request, principal, {
          ...(devUrl === undefined ? {} : { devUrl }),
          ...(manifest === undefined ? {} : { manifest }),
        });
      }
      return redirectTo(
        `/chat?app=${encodeURIComponent(first.app.appKey)}&project=${encodeURIComponent(first.project.id)}`,
      );
    }
  }

  const props = pagePropsFor(deps, site, match, request);
  if (props === null) {
    return serveNotFound(deps, request, principal, {
      site,
      ...(devUrl === undefined ? {} : { devUrl }),
      ...(manifest === undefined ? {} : { manifest }),
    });
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
      route: match,
      props,
      chrome: data,
      routeKey: routeKey(match.id, match.params, request.query ?? {}),
      operator: { name: principal.name, initials: initials(principal.name) },
      ...(workspace === undefined
        ? {}
        : {
            topbar: workspace.topbar,
            pageClass: workspace.pageClass,
            bodyClass: workspace.bodyClass,
            ...(workspace.viewport === undefined ? {} : { viewport: workspace.viewport }),
          }),
      ...(notice === undefined ? {} : { notice }),
      ...(devUrl === undefined ? {} : { devUrl }),
      ...(manifest === undefined ? {} : { manifest }),
    }),
  };
}

function htmlResponse(status: number, body: string): HttpResponse {
  return {
    status,
    contentType: "text/html; charset=utf-8",
    body,
    headers: { "cache-control": "no-store" },
  };
}

function redirectTo(location: string): HttpResponse {
  return {
    status: 302,
    contentType: "text/plain; charset=utf-8",
    body: "",
    headers: { location },
  };
}

const UI_API_PATHS = new Set([
  "/api/ui/projects",
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
  if (request.path === "/api/ui/auth") {
    const authFailure = authorizeUiRead(deps, request);
    if (authFailure !== undefined) {
      return authFailure;
    }
    return {
      status: 204,
      contentType: "text/plain; charset=utf-8",
      body: "",
      headers: { "cache-control": "no-store" },
    };
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
  const versionFailure = requireUiVersion(request);
  if (versionFailure !== undefined) {
    return versionFailure;
  }

  const site = buildSite(deps);

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
    });
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
    });
    return jsonResponse(200, { ...props, chrome }, { "cache-control": "no-store" });
  }

  if (request.path === "/api/ui/overview") {
    const match: PageMatch = { id: "overview", params: {} };
    return jsonResponse(
      200,
      { ...buildOverviewProps(site), chrome: chromeFor(site, match) },
      { "cache-control": "no-store" },
    );
  }

  if (request.path === "/api/ui/handoffs") {
    const match: PageMatch = { id: "handoffs", params: {} };
    return jsonResponse(
      200,
      {
        ...buildHandoffsProps(site, request.query?.filter, request.query?.q),
        chrome: chromeFor(site, match),
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
        chrome: chromeFor(site, match),
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
      { ...props, chrome: chromeFor(site, match) },
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
      { ...props, chrome: chromeFor(site, match) },
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
      { ...props, chrome: chromeFor(site, match, skillsChromeHint(match, props)) },
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
      { ...props, chrome: chromeFor(site, match) },
      { "cache-control": "no-store" },
    );
  }

  const match = matchPage("/projects");
  if (match === undefined) {
    return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
  }
  const chrome = chromeFor(site, match);
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
  const versionFailure = requireUiVersion(request);
  if (versionFailure !== undefined) {
    return versionFailure;
  }

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
    { ...props, chrome: chromeFor(site, match) },
    { "cache-control": "no-store" },
  );
}
