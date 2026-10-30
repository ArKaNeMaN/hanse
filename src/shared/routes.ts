/**
 * Shared page-route manifest for the coordinator.
 *
 * This module is imported by the server and, later, by the Vite client, so it must stay pure:
 * no `node:*` imports, no filesystem access, and no framework dependency. Environment flags are
 * read through `process.env` only when they exist; `?legacy=1` is handled by the page dispatcher.
 */

export type RouteId =
  | "projects"
  | "overview"
  | "project"
  | "handoffs"
  | "ssh"
  | "settings-global"
  | "settings-project"
  | "settings-app"
  | "skills-global"
  | "skills-project"
  | "skills-app"
  | "skills-new"
  | "skills-detail"
  | "app"
  | "terminal"
  | "chat";

export type NavId =
  | "overview"
  | "projects"
  | "project"
  | "handoffs"
  | "settings"
  | "skills"
  | "ssh"
  | "none";

export interface RouteDefinition {
  readonly id: RouteId;
  readonly path: string;
  readonly nav: NavId;
  readonly label: string;
  /** Registry cutover flag. Phase 1A keeps every route legacy. */
  readonly spa: boolean;
  /** True once the legacy renderer is retired and the SPA is always served (Stage 9). */
  readonly legacyRetired?: boolean;
}

export interface PageMatch {
  readonly id: RouteId;
  readonly params: Readonly<Record<string, string>>;
}

export interface UiRouteEnv {
  readonly legacy?: string;
  readonly spaRoutes?: string;
}

export interface SpaRouteOptions {
  readonly env?: UiRouteEnv;
  /** False when the UI manifest is missing, invalid, or partial. */
  readonly manifestValid?: boolean;
}

const ROUTE_DEFINITIONS: readonly RouteDefinition[] = [
  {
    id: "projects",
    path: "/projects",
    nav: "projects",
    label: "Projects",
    spa: true,
  },
  {
    id: "overview",
    path: "/",
    nav: "overview",
    label: "Overview",
    spa: true,
  },
  {
    id: "handoffs",
    path: "/handoffs",
    nav: "handoffs",
    label: "Handoffs",
    spa: true,
  },
  {
    id: "ssh",
    path: "/ssh",
    nav: "ssh",
    label: "SSH",
    spa: true,
  },
  {
    id: "settings-global",
    path: "/settings",
    nav: "settings",
    label: "Settings",
    spa: true,
  },
  {
    id: "skills-global",
    path: "/skills",
    nav: "skills",
    label: "Skills",
    spa: true,
  },
  {
    id: "skills-new",
    path: "/skills/new",
    nav: "skills",
    label: "New skill",
    spa: true,
  },
  {
    id: "skills-detail",
    path: "/skills/:id",
    nav: "skills",
    label: "Skill",
    spa: true,
  },
  {
    id: "settings-project",
    path: "/projects/:id/settings",
    nav: "settings",
    label: "Settings",
    spa: true,
  },
  {
    id: "settings-app",
    path: "/projects/:id/apps/:app/settings",
    nav: "settings",
    label: "Settings",
    spa: true,
  },
  {
    id: "skills-project",
    path: "/projects/:id/skills",
    nav: "skills",
    label: "Skills",
    spa: true,
  },
  {
    id: "skills-app",
    path: "/projects/:id/apps/:app/skills",
    nav: "skills",
    label: "Skills",
    spa: true,
  },
  {
    id: "app",
    path: "/projects/:id/apps/:app",
    nav: "project",
    label: "Application",
    spa: true,
  },
  {
    id: "project",
    path: "/projects/:id",
    nav: "project",
    label: "Project",
    spa: true,
  },
  {
    id: "terminal",
    path: "/terminal",
    nav: "project",
    label: "Terminal",
    spa: false,
    legacyRetired: false,
  },
  {
    id: "chat",
    path: "/chat",
    nav: "none",
    label: "Chat",
    spa: false,
    legacyRetired: false,
  },
];

export const ROUTES: readonly RouteDefinition[] = ROUTE_DEFINITIONS;

const ROUTE_BY_ID = new Map<RouteId, RouteDefinition>(
  ROUTE_DEFINITIONS.map((route) => [route.id, route]),
);

const PARAM_PATTERN = /:([A-Za-z][A-Za-z0-9_]*)/g;

interface CompiledRoute {
  readonly route: RouteDefinition;
  readonly pattern: RegExp;
  readonly params: readonly string[];
}

function compile(route: RouteDefinition): CompiledRoute {
  const params: string[] = [];
  const source = route.path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(PARAM_PATTERN, (_match, name: string) => {
      params.push(name);
      return "([^/]+)";
    });
  return { route, pattern: new RegExp(`^${source}$`), params };
}

// Static segments are listed before dynamic ones, and longer dynamic paths before shorter ones,
// so `/skills/new` wins over `/skills/:id` and `/projects/:id/settings` before `/projects/:id`.
const COMPILED: readonly CompiledRoute[] = ROUTE_DEFINITIONS.map(compile);

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Match a page pathname. Static `/chat` and `/terminal` are page routes; `/api/*`, `/ide`,
 * `/preview`, `/assets/*`, and terminal upgrades remain unmatched.
 */
export function matchPage(pathname: string): PageMatch | undefined {
  for (const compiled of COMPILED) {
    const match = compiled.pattern.exec(pathname);
    if (match === null) {
      continue;
    }
    const params: Record<string, string> = {};
    compiled.params.forEach((name, index) => {
      params[name] = decodeParam(match[index + 1] ?? "");
    });
    return { id: compiled.route.id, params };
  }
  return undefined;
}

export function routeById(id: RouteId): RouteDefinition | undefined {
  return ROUTE_BY_ID.get(id);
}

export interface SpaAllowlist {
  readonly ids: ReadonlySet<RouteId>;
  readonly unknown: readonly string[];
}

/** Parse `HANSE_UI_SPA_ROUTES`. Unknown ids are returned separately so the server can log them. */
export function parseSpaAllowlist(value: string): SpaAllowlist {
  const ids = new Set<RouteId>();
  const unknown: string[] = [];
  for (const raw of value.split(",")) {
    const id = raw.trim();
    if (id.length === 0) {
      continue;
    }
    if (ROUTE_BY_ID.has(id as RouteId)) {
      ids.add(id as RouteId);
    } else {
      unknown.push(id);
    }
  }
  return { ids, unknown };
}

function environment(): UiRouteEnv {
  if (typeof process === "undefined" || process.env === undefined) {
    return {};
  }
  return {
    legacy: process.env.HANSE_UI_LEGACY,
    spaRoutes: process.env.HANSE_UI_SPA_ROUTES,
  };
}

/**
 * Resolve whether a route is served by the SPA.
 *
 * Precedence: `HANSE_UI_LEGACY=1` > manifest validity > `HANSE_UI_SPA_ROUTES` > registry `spa`.
 * An unset allowlist falls through to the registry flag; an empty string disables every route; a
 * comma list enables only the listed ids (unknown ids are ignored). `?legacy=1` is handled by the
 * page dispatcher, not here.
 */
export function isSpaRoute(id: RouteId, options: SpaRouteOptions = {}): boolean {
  const route = ROUTE_BY_ID.get(id);
  if (route === undefined) {
    return false;
  }
  const env = options.env ?? environment();
  if (env.legacy?.trim() === "1") {
    return false;
  }
  if (options.manifestValid === false) {
    return false;
  }
  const allowlist = env.spaRoutes;
  if (allowlist === undefined) {
    return route.spa;
  }
  if (allowlist.trim().length === 0) {
    return false;
  }
  return parseSpaAllowlist(allowlist).ids.has(id);
}

export function isSpaPath(pathname: string, options: SpaRouteOptions = {}): boolean {
  const match = matchPage(pathname);
  return match !== undefined && isSpaRoute(match.id, options);
}

/** True once the route always serves the SPA and ignores the legacy rollback flags. */
export function isLegacyRetired(id: RouteId): boolean {
  return ROUTE_BY_ID.get(id)?.legacyRetired === true;
}

/**
 * Membership check against the resolved boot route set. The client uses this instead of
 * `isSpaPath()` because `process.env` is not available in the browser.
 */
export function isSpaPathIn(
  pathname: string,
  ids: ReadonlySet<RouteId> | readonly RouteId[],
): boolean {
  const match = matchPage(pathname);
  if (match === undefined) {
    return false;
  }
  return ids instanceof Set ? ids.has(match.id) : (ids as readonly RouteId[]).includes(match.id);
}
