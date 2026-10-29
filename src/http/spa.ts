import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import {
  isSpaRoute,
  matchPage,
  type PageMatch,
  parseSpaAllowlist,
  type RouteId,
  routeById,
} from "../shared/routes.js";
import { humanFromCookie } from "./auth.js";
import { buildSite, type SiteModel } from "./dashboard.js";
import {
  agentTokenFor,
  type HttpDeps,
  type HttpRequest,
  type HttpResponse,
  safeDecode,
} from "./handler.js";
import { buildHandoffsProps } from "./props/handoffs.js";
import { buildOverviewProps } from "./props/overview.js";
import { buildProjectProps } from "./props/project.js";
import { buildProjectsProps } from "./props/projects.js";
import { buildSshProps, resolveSshScope } from "./props/ssh.js";
import {
  appShell,
  type Crumb,
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

export function chromeFor(site: SiteModel, match: PageMatch): ChromeData {
  const definition = routeById(match.id);
  const projectId = PROJECT_ROUTES.has(match.id) ? match.params.id : undefined;
  const project =
    projectId === undefined
      ? undefined
      : site.projects.find((candidate) => candidate.id === projectId);
  const appKey = APP_ROUTES.has(match.id) ? match.params.app : undefined;
  const { title, breadcrumb } = routeChrome(match.id, projectId, project?.name, appKey);
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
  readonly notice?: Notice;
  readonly manifest?: UiManifest;
  readonly devUrl?: string;
}

export function renderSpaDocument(input: SpaDocumentInput): string {
  const boot = {
    route: input.route,
    props: input.props,
    chrome: input.chrome,
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
  return {};
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
  if (!isSpaRoute(match.id, { manifestValid: true })) {
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
  const data = chromeFor(site, match);
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
      props: pagePropsFor(deps, site, match, request),
      chrome: data.chrome,
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
]);
const UI_PROJECT_PATH = /^\/api\/ui\/projects\/([^/]+)$/;

function uiProjectId(pathname: string): string | undefined {
  const match = UI_PROJECT_PATH.exec(pathname);
  const raw = match?.[1];
  return raw === undefined ? undefined : safeDecode(raw);
}

/** Cookie-only `/api/ui/*` JSON endpoints. Agent bearer tokens and human bearers are rejected. */
export function handleUiApi(deps: HttpDeps, request: HttpRequest): HttpResponse | undefined {
  if (request.method !== "GET") {
    return undefined;
  }
  const projectId = uiProjectId(request.path);
  if (!UI_API_PATHS.has(request.path) && projectId === undefined) {
    return undefined;
  }
  const presented = agentTokenFor(request);
  if (presented !== undefined && verifyAgentToken(deps.db, presented) !== undefined) {
    return agentForbidden();
  }

  const principal = humanFromCookie(deps, request);
  if (principal === undefined) {
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

  logUnknownRoutes(deps);
  const site = buildSite(deps);

  if (request.path === "/api/ui/chrome") {
    const pathname = safeLocalPath(request.query?.path, "/");
    const match = matchPage(pathname);
    if (match === undefined) {
      return jsonResponse(404, { error: "not found" }, { "cache-control": "no-store" });
    }
    return jsonResponse(200, chromeFor(site, match).chrome, {
      "cache-control": "no-store",
    });
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
