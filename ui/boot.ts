import { type PageMatch, ROUTES, type RouteId, routeById } from "../src/shared/routes.js";

/** The active navigation id emitted by `appShell()`; kept structural to avoid importing server code. */
export type NavActive =
  | "overview"
  | "projects"
  | "project"
  | "handoffs"
  | "skills"
  | "settings"
  | "ssh"
  | "none";

export interface BootChrome {
  readonly sidebarNav: string;
  readonly breadcrumb: string;
  readonly title: string;
  readonly active: NavActive;
  readonly pendingCount: number;
  readonly sshPendingCount: number;
}

export interface BootNotice {
  readonly message: string;
  readonly tone: "success" | "error";
}

/** Server first-paint topbar seed; no counters beyond the zeroed chat fallback. */
export interface BootTopbar {
  readonly ideHref: string;
  readonly needsInputCount?: number;
  readonly policyVisible?: boolean;
  readonly contextToggle?: boolean;
}

export interface BootPayload {
  readonly route: PageMatch;
  readonly props: unknown;
  readonly chrome: BootChrome;
  readonly spaRoutes: readonly RouteId[];
  readonly topbar: BootTopbar;
  readonly notice?: BootNotice;
}

const KNOWN_ROUTE_IDS = new Set<RouteId>(ROUTES.map((route) => route.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoute(value: unknown): value is PageMatch {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.params) &&
    Object.values(value.params).every((entry) => typeof entry === "string")
  );
}

function isChrome(value: unknown): value is BootChrome {
  return (
    isRecord(value) &&
    typeof value.sidebarNav === "string" &&
    typeof value.breadcrumb === "string" &&
    typeof value.title === "string" &&
    typeof value.active === "string" &&
    typeof value.pendingCount === "number" &&
    typeof value.sshPendingCount === "number"
  );
}

function isTopbar(value: unknown): value is BootTopbar {
  return (
    isRecord(value) &&
    typeof value.ideHref === "string" &&
    (value.needsInputCount === undefined || typeof value.needsInputCount === "number") &&
    (value.policyVisible === undefined || typeof value.policyVisible === "boolean") &&
    (value.contextToggle === undefined || typeof value.contextToggle === "boolean")
  );
}

function readSpaRoutes(value: unknown): RouteId[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids: RouteId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    if (KNOWN_ROUTE_IDS.has(entry as RouteId)) {
      ids.push(entry as RouteId);
    }
  }
  return ids;
}

function isNotice(value: unknown): value is BootNotice {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    (value.tone === "success" || value.tone === "error")
  );
}

/**
 * Read the server-provided boot payload. The JSON is untrusted input from the document, so the
 * shape is validated before anything reaches the router or the stores. `<` is escaped by the
 * server serializer, which is why `textContent` is enough to read it.
 */
export function readBoot(doc: Document = document): BootPayload | undefined {
  const element = doc.getElementById("hanse-boot");
  if (element === null) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(element.textContent ?? "");
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || !isRoute(parsed.route) || !isChrome(parsed.chrome)) {
    return undefined;
  }
  if (parsed.notice !== undefined && !isNotice(parsed.notice)) {
    return undefined;
  }
  if (!isTopbar(parsed.topbar)) {
    return undefined;
  }
  const spaRoutes = readSpaRoutes(parsed.spaRoutes);
  if (spaRoutes === undefined) {
    return undefined;
  }
  if (routeById(parsed.route.id as RouteId) === undefined) {
    return undefined;
  }
  const route: PageMatch = {
    id: parsed.route.id as RouteId,
    params: parsed.route.params,
  };
  // Fail closed: never route to a page the server did not enable for this document.
  if (!spaRoutes.includes(route.id)) {
    return undefined;
  }
  return {
    route,
    props: parsed.props ?? {},
    chrome: parsed.chrome,
    spaRoutes,
    topbar: parsed.topbar,
    ...(parsed.notice === undefined ? {} : { notice: parsed.notice }),
  };
}
