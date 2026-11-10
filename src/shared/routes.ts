/**
 * Shared page-route manifest for the coordinator.
 *
 * This module is imported by the server and the Vite client, so it must stay pure: no `node:*`
 * imports, no filesystem access, and no framework dependency.
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
  | "chat"
  | "login"
  | "not-found";

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
  /** True for a page served without an authenticated session, such as the login page. */
  readonly public?: boolean;
  /** Synthetic routes are valid boot ids but never match a request path. */
  readonly synthetic?: boolean;
}

export interface PageMatch {
  readonly id: RouteId;
  readonly params: Readonly<Record<string, string>>;
}

const ROUTE_DEFINITIONS: readonly RouteDefinition[] = [
  {
    id: "projects",
    path: "/projects",
    nav: "projects",
    label: "Projects",
  },
  {
    id: "overview",
    path: "/",
    nav: "overview",
    label: "Overview",
  },
  {
    id: "handoffs",
    path: "/handoffs",
    nav: "handoffs",
    label: "Handoffs",
  },
  {
    id: "ssh",
    path: "/ssh",
    nav: "ssh",
    label: "SSH",
  },
  {
    id: "settings-global",
    path: "/settings",
    nav: "settings",
    label: "Settings",
  },
  {
    id: "skills-global",
    path: "/skills",
    nav: "skills",
    label: "Skills",
  },
  {
    id: "skills-new",
    path: "/skills/new",
    nav: "skills",
    label: "New skill",
  },
  {
    id: "skills-detail",
    path: "/skills/:id",
    nav: "skills",
    label: "Skill",
  },
  {
    id: "settings-project",
    path: "/projects/:id/settings",
    nav: "settings",
    label: "Settings",
  },
  {
    id: "settings-app",
    path: "/projects/:id/apps/:app/settings",
    nav: "settings",
    label: "Settings",
  },
  {
    id: "skills-project",
    path: "/projects/:id/skills",
    nav: "skills",
    label: "Skills",
  },
  {
    id: "skills-app",
    path: "/projects/:id/apps/:app/skills",
    nav: "skills",
    label: "Skills",
  },
  {
    id: "app",
    path: "/projects/:id/apps/:app",
    nav: "project",
    label: "Application",
  },
  {
    id: "project",
    path: "/projects/:id",
    nav: "project",
    label: "Project",
  },
  {
    id: "terminal",
    path: "/terminal",
    nav: "project",
    label: "Terminal",
  },
  {
    id: "chat",
    path: "/chat",
    nav: "none",
    label: "Chat",
  },
  {
    id: "login",
    path: "/login",
    nav: "none",
    label: "Sign in",
    public: true,
  },
  {
    id: "not-found",
    path: "*",
    nav: "none",
    label: "Page not found",
    synthetic: true,
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
// Synthetic definitions (the boot-only `not-found` id) are deliberately excluded.
const COMPILED: readonly CompiledRoute[] = ROUTE_DEFINITIONS.filter(
  (route) => route.synthetic !== true,
).map(compile);

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

type RouteQueryValue = string | string[] | null | undefined;

/**
 * Query keys that do not affect chrome or page identity: `notice`/`tone` (toast presentation) and
 * `session` (chat selection).
 */
const EXCLUDED_ROUTE_KEYS: ReadonlySet<string> = new Set(["notice", "tone", "session"]);

function lastQueryValue(value: RouteQueryValue): string | null | undefined {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/**
 * Build a stable identity string for a page route.
 *
 * The canonical form is shared by the server and the client so they cannot drift: param and query
 * keys are sorted, a repeated query key takes its last value (matching the server's
 * `Object.fromEntries(url.searchParams)`), `null`/`undefined` are dropped while an empty string is
 * kept, and the excluded keys above are ignored. The normalized entries are serialized with
 * `JSON.stringify`.
 */
export function routeKey(
  id: RouteId,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, RouteQueryValue>>,
): string {
  const normalize = (
    entries: readonly (readonly [string, string | null | undefined])[],
  ): [string, string][] => {
    const normalized: [string, string][] = [];
    for (const [key, value] of entries) {
      if (value === null || value === undefined || EXCLUDED_ROUTE_KEYS.has(key)) {
        continue;
      }
      normalized.push([key, value]);
    }
    normalized.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return normalized;
  };

  const normalizedParams = normalize(Object.entries(params));
  const normalizedQuery = normalize(
    Object.entries(query).map(([key, value]): [string, string | null | undefined] => [
      key,
      lastQueryValue(value),
    ]),
  );
  return JSON.stringify([id, normalizedParams, normalizedQuery]);
}

/** True for a page that is served without an authenticated session. */
export function isPublicRoute(id: RouteId): boolean {
  return ROUTE_BY_ID.get(id)?.public === true;
}

/**
 * True for a pathname that can be a page request. Known page routes always win, even when a param
 * looks like a file extension (for example an app key such as `my.app`).
 */
export function isPagePath(pathname: string): boolean {
  if (matchPage(pathname) !== undefined) {
    return true;
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  if (pathname === "/assets" || pathname.startsWith("/assets/")) return false;
  if (pathname === "/ide" || pathname.startsWith("/ide/")) return false;
  if (pathname === "/preview" || pathname.startsWith("/preview/")) return false;
  if (pathname === "/internal" || pathname.startsWith("/internal/")) return false;
  if (pathname === "/healthz" || pathname.startsWith("/healthz/")) return false;
  if (pathname === "/readyz" || pathname.startsWith("/readyz/")) return false;
  if (/\.[A-Za-z0-9]+$/.test(pathname)) return false;
  return true;
}
