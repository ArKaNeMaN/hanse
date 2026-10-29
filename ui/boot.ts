import type { PageMatch, RouteId } from "../src/shared/routes.js";

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

export interface BootPayload {
  readonly route: PageMatch;
  readonly props: unknown;
  readonly chrome: BootChrome;
  readonly notice?: BootNotice;
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

  const route: PageMatch = {
    id: parsed.route.id as RouteId,
    params: parsed.route.params,
  };
  return {
    route,
    props: parsed.props ?? {},
    chrome: parsed.chrome,
    ...(parsed.notice === undefined ? {} : { notice: parsed.notice }),
  };
}
