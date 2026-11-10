import { type PageMatch, routeById } from "../src/shared/routes.js";

/** The active navigation id emitted by `ChromeData`; kept structural to avoid importing server code. */
export type NavActive =
  | "overview"
  | "projects"
  | "project"
  | "handoffs"
  | "skills"
  | "settings"
  | "ssh"
  | "none";

const NAV_ACTIVE: ReadonlySet<string> = new Set<NavActive>([
  "overview",
  "projects",
  "project",
  "handoffs",
  "skills",
  "settings",
  "ssh",
  "none",
]);

export interface ChromeCrumb {
  readonly label: string;
  readonly href?: string;
}

export interface ChromeProject {
  readonly id: string;
  readonly name: string;
  readonly appCount: number;
}

export interface ChromeData {
  readonly title: string;
  readonly active: NavActive;
  readonly activeProjectId?: string;
  readonly breadcrumb: readonly ChromeCrumb[];
  readonly projects: readonly ChromeProject[];
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

export type BootOverride = "not-found" | "chat-no-apps";

export interface BootPayload {
  readonly route: PageMatch;
  readonly props: unknown;
  readonly chrome: ChromeData;
  readonly routeKey: string;
  readonly operator?: BootOperator;
  readonly topbar: BootTopbar;
  readonly notice?: BootNotice;
  readonly override?: BootOverride;
}

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

function isCrumb(value: unknown): value is ChromeCrumb {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    (value.href === undefined || typeof value.href === "string")
  );
}

function isProject(value: unknown): value is ChromeProject {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.appCount === "number"
  );
}

function isChrome(value: unknown): value is ChromeData {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.active === "string" &&
    NAV_ACTIVE.has(value.active) &&
    (value.activeProjectId === undefined || typeof value.activeProjectId === "string") &&
    Array.isArray(value.breadcrumb) &&
    value.breadcrumb.every(isCrumb) &&
    Array.isArray(value.projects) &&
    value.projects.every(isProject) &&
    typeof value.masterHref === "string" &&
    typeof value.pendingCount === "number" &&
    typeof value.sshPendingCount === "number" &&
    (value.settingsHref === undefined || typeof value.settingsHref === "string") &&
    (value.skillsHref === undefined || typeof value.skillsHref === "string")
  );
}

function isOperator(value: unknown): value is BootOperator {
  return isRecord(value) && typeof value.name === "string" && typeof value.initials === "string";
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
  if (typeof parsed.routeKey !== "string" || parsed.routeKey.length === 0) {
    return undefined;
  }
  if (parsed.operator !== undefined && !isOperator(parsed.operator)) {
    return undefined;
  }
  if (parsed.notice !== undefined && !isNotice(parsed.notice)) {
    return undefined;
  }
  if (!isTopbar(parsed.topbar)) {
    return undefined;
  }
  const override = parsed.override;
  if (override !== undefined && override !== "not-found" && override !== "chat-no-apps") {
    return undefined;
  }
  if (routeById(parsed.route.id as PageMatch["id"]) === undefined) {
    return undefined;
  }
  const route: PageMatch = {
    id: parsed.route.id as PageMatch["id"],
    params: parsed.route.params,
  };
  if (override === "chat-no-apps" && route.id !== "chat") {
    return undefined;
  }
  return {
    route,
    props: parsed.props ?? {},
    chrome: parsed.chrome,
    routeKey: parsed.routeKey,
    ...(parsed.operator === undefined ? {} : { operator: parsed.operator }),
    topbar: parsed.topbar,
    ...(parsed.notice === undefined ? {} : { notice: parsed.notice }),
    ...(override === undefined ? {} : { override }),
  };
}
