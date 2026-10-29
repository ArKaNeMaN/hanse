import {
  SKILL_LIMITS,
  SkillConflictError,
  type SkillMetadata,
  type SkillReference,
  type SkillRow,
  type SkillScope,
  SkillService,
  type SkillTarget,
  type SkillUpdate,
  SkillValidationError,
} from "../skills/index.js";
import { principalFrom } from "./auth.js";
import {
  buildSite,
  type PageChrome,
  renderErrorPage,
  renderNotFound,
  type SiteModel,
} from "./dashboard.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import {
  type BundleValues,
  buildSkillCreateProps,
  buildSkillDetailProps,
  buildSkillsInventoryProps,
  bundleFromRow,
  createTargetFromQuery,
  parseExplicitTarget,
  parseInventoryFilter,
  previewFor,
  rowPagePath,
  rowTarget,
  type SkillActionLinkProps,
  type SkillActionsProps,
  type SkillDangerProps,
  type SkillFormProps,
  type SkillIssueProps,
  type SkillsInventoryProps,
  SkillsTargetError,
  type SkillTargetFieldsProps,
  type SkillWarningProps,
  type SkillWorkspaceError,
  type SkillWorkspaceProps,
  scopeLabel,
  skillsPagePath,
  targetExists,
  targetFromQuery,
  type WorkspaceValues,
  workspacePath,
} from "./props/skills.js";
import {
  absoluteTime,
  appShell,
  emptyState,
  escapeHtml,
  icon,
  pageHeader,
  safeLocalPath,
} from "./ui.js";

const JSON_HEADERS = { "cache-control": "no-store" };

const KNOWN_METADATA: Array<{
  key: string;
  label: string;
  group: "classification" | "discovery" | "version";
  hint: string;
}> = [
  {
    key: "domain",
    label: "Domain",
    group: "classification",
    hint: "The broad area the skill belongs to, such as engineering or operations.",
  },
  {
    key: "role",
    label: "Role",
    group: "classification",
    hint: "The role the agent plays while using the skill.",
  },
  {
    key: "scope",
    label: "Operating scope",
    group: "classification",
    hint: "What part of the work it covers, such as one repository or a whole project.",
  },
  {
    key: "output-format",
    label: "Output format",
    group: "classification",
    hint: "The expected result shape: mixed, code, report, document, plan, or decision.",
  },
  {
    key: "triggers",
    label: "Triggers",
    group: "discovery",
    hint: "Comma-separated cues that tell the agent when to load the skill.",
  },
  {
    key: "related-skills",
    label: "Related skills",
    group: "discovery",
    hint: "Comma-separated skill names worth loading alongside this one.",
  },
  {
    key: "version",
    label: "Version",
    group: "version",
    hint: "A short version label, such as 1.0.0.",
  },
  {
    key: "author",
    label: "Author",
    group: "version",
    hint: "The person or team responsible for the skill.",
  },
];

const KNOWN_METADATA_KEYS = new Set(KNOWN_METADATA.map((entry) => entry.key));

class SkillsBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsBodyError";
  }
}

class SkillsOverrideError extends Error {
  readonly code = "invalid_override_source";

  constructor() {
    super("invalid_override_source");
    this.name = "SkillsOverrideError";
  }
}

class SkillsConfirmError extends Error {
  readonly code = "confirm_name";
  readonly field = "confirm_name";

  constructor() {
    super("the confirmation name does not match this skill");
    this.name = "SkillsConfirmError";
  }
}

/* ------------------------------------------------------------------------- */
/* Response primitives                                                        */
/* ------------------------------------------------------------------------- */

interface JsonError {
  error: string;
  code: string;
  field?: string;
}

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { ...JSON_HEADERS },
  };
}

function errorJson(status: number, value: JsonError): HttpResponse {
  return json(status, value);
}

function html(status: number, body: string): HttpResponse {
  return {
    status,
    contentType: "text/html; charset=utf-8",
    body,
    headers: { ...JSON_HEADERS },
  };
}

function redirect(location: string): HttpResponse {
  return {
    status: 303,
    contentType: "text/plain",
    body: "",
    headers: { location, ...JSON_HEADERS },
  };
}

/* ------------------------------------------------------------------------- */
/* Request parsing                                                            */
/* ------------------------------------------------------------------------- */

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function wantsHtml(request: HttpRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(source, key);
}

function parseForm(body: string | undefined): Record<string, string> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  if (body === undefined) {
    return fields;
  }
  for (const pair of body.split("&")) {
    const index = pair.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = safeDecode(pair.slice(0, index));
    if (DANGEROUS_KEYS.has(key)) {
      throw new SkillsBodyError("request contains a forbidden field name");
    }
    fields[key] = safeDecode(pair.slice(index + 1));
  }
  return fields;
}

function isJsonRequest(request: HttpRequest): boolean {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    return true;
  }
  return request.body?.trim().startsWith("{") ?? false;
}

function parseObjectBody(request: HttpRequest): Record<string, unknown> {
  if (!isJsonRequest(request)) {
    return parseForm(request.body);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body ?? "");
  } catch {
    throw new SkillsBodyError("invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillsBodyError("request body must be a JSON object");
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new SkillsBodyError("request contains a forbidden field name");
    }
  }
  return parsed as Record<string, unknown>;
}

function jsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillValidationError(`${label} must be valid JSON`, label);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillValidationError(`${label} must be a JSON object`, label);
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new SkillsBodyError("request contains a forbidden field name");
    }
  }
  return record;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function enabledFrom(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === 0) {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "on") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "") {
      return false;
    }
  }
  throw new SkillsBodyError("enabled must be a boolean");
}

function parseId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function requestPath(request: HttpRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    params.set(key, value);
  }
  const query = params.toString();
  return query.length === 0 ? request.path : `${request.path}?${query}`;
}

/* ------------------------------------------------------------------------- */
/* Return paths                                                               */
/* ------------------------------------------------------------------------- */

function safeSkillReturn(value: string | undefined, fallback: string): string {
  const target = safeLocalPath(value, fallback);
  if (target === "/login" || target.startsWith("/login?") || target.startsWith("/login#")) {
    return fallback;
  }
  return target;
}

/* ------------------------------------------------------------------------- */
/* Origin                                                                     */
/* ------------------------------------------------------------------------- */

function originAllowed(request: HttpRequest): boolean {
  const origin = request.origin;
  if (origin === undefined || origin.trim().length === 0) {
    return true;
  }
  const trimmed = origin.trim();
  if (trimmed === "null") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = request.host;
  return host !== undefined && host.length > 0 && parsed.host === host;
}

/* ------------------------------------------------------------------------- */
/* Warning and issue formatting                                               */
/* ------------------------------------------------------------------------- */

function warningList(warnings: readonly SkillWarningProps[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return warnings
    .map(
      (warning) =>
        `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(warning.text)}</p>`,
    )
    .join("");
}

function issueList(issues: readonly SkillIssueProps[]): string {
  if (issues.length === 0) {
    return "";
  }
  const items = issues
    .map((issue) => {
      const link =
        issue.anchor === null
          ? ""
          : ` <a class="small" href="${escapeHtml(issue.anchor)}">Repair</a>`;
      return `<li>${escapeHtml(issue.message)}${link}</li>`;
    })
    .join("");
  return `<section class="settings-warning" role="alert" data-skill-issues>
    <p class="settings-warning__title">${icon("alert-triangle")}Issues</p>
    <ul class="stack--tight">${items}</ul>
  </section>`;
}

function issueGlyph(issues: readonly SkillIssueProps[]): string {
  if (issues.length === 0) {
    return "";
  }
  return `<span class="status" data-state="failed" title="${escapeHtml((issues[0] as SkillIssueProps).message)}">${icon("alert-triangle")}<span class="sr-only">Invalid</span></span>`;
}

/* ------------------------------------------------------------------------- */
/* Page chrome                                                                */
/* ------------------------------------------------------------------------- */

function pageChrome(operatorName: string, request: HttpRequest): PageChrome {
  const message = request.query?.notice;
  const notice =
    message === undefined || message.trim().length === 0
      ? undefined
      : {
          message,
          tone: request.query?.tone === "error" ? ("error" as const) : ("success" as const),
        };
  return { operatorName, notice };
}

function withNotice(location: string, message: string, tone: "success" | "error"): string {
  const hashIndex = location.indexOf("#");
  const hash = hashIndex >= 0 ? location.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? location.slice(0, hashIndex) : location;
  const queryIndex = base.indexOf("?");
  const pathname = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const params = new URLSearchParams(queryIndex >= 0 ? base.slice(queryIndex + 1) : "");
  params.set("notice", message);
  params.set("tone", tone);
  return `${pathname}?${params.toString()}${hash}`;
}

function redirectNotice(
  location: string,
  message: string,
  tone: "success" | "error",
): HttpResponse {
  return redirect(withNotice(location, message, tone));
}

function navProjects(site: SiteModel): Array<{ id: string; name: string; appCount: number }> {
  return site.projects.map((project) => ({
    id: project.id,
    name: project.name,
    appCount: project.apps.length,
  }));
}

/* ------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* ------------------------------------------------------------------------- */

function scopeBadge(scope: SkillScope): string {
  return `<span class="badge">${escapeHtml(scopeLabel(scope))}</span>`;
}

function stateBadge(row: SkillsInventoryProps["rows"][number]): string {
  const tone =
    row.state === "enabled"
      ? "badge-success"
      : row.state === "disabled"
        ? "badge-warning"
        : row.state === "invalid"
          ? "badge-error"
          : "badge-ghost";
  return `<span class="badge ${tone}">${escapeHtml(row.stateLabel)}</span>`;
}

function scopeNav(scope: SkillsInventoryProps["scope"]): string {
  const current = (label: string, short?: string): string =>
    short === undefined
      ? `<span class="settings-nav__link" aria-current="page">${icon("check")}${escapeHtml(label)}</span>`
      : `<span class="settings-nav__link" aria-current="page">${icon("check")}<span class="settings-nav__scope-full">${escapeHtml(label)}</span><span class="settings-nav__scope-short">${escapeHtml(short)}</span></span>`;
  const scopes = scope.options
    .map((option) => {
      if (option.current) {
        return current(option.label, option.shortLabel ?? undefined);
      }
      return option.href === null
        ? ""
        : `<a class="settings-nav__link" href="${escapeHtml(option.href)}">${escapeHtml(option.label)}</a>`;
    })
    .join("");
  return `<nav class="settings-nav" aria-label="${escapeHtml(scope.nav.ariaLabel)}">
    <div class="settings-nav__scopes" role="group" aria-label="${escapeHtml(scope.nav.groupLabel)}">${scopes}</div>
  </nav>`;
}

function inventoryToolbar(props: SkillsInventoryProps): string {
  const filter = props.filter;
  const search = props.search;
  return `<div class="toolbar skill-toolbar" data-skill-inventory-toolbar>
    <form method="get" action="${escapeHtml(search.action)}" role="search" class="cluster">
      <label class="sr-only" for="skill-search">Search skills</label>
      ${search.hiddenFilter === null ? "" : `<input type="hidden" name="filter" value="${escapeHtml(search.hiddenFilter)}" />`}
      <input class="input search-input" id="skill-search" type="search" name="q" value="${escapeHtml(search.query)}" placeholder="Search skills" autocomplete="off" />
      <button class="btn btn-secondary" type="submit">${icon("search")}Search</button>
    </form>
    <div class="segmented" role="group" aria-label="Filter skills">
      ${props.filters
        .map(
          (entry) =>
            `<a class="segmented__item" href="${escapeHtml(entry.href)}"${entry.value === filter ? ' aria-current="page"' : ""}>${escapeHtml(entry.label)}</a>`,
        )
        .join("")}
    </div>
  </div>`;
}

function inventoryTable(props: SkillsInventoryProps): string {
  const body = props.rows
    .map((row) => {
      const secondary =
        row.effectiveHref === null
          ? ""
          : `<a class="small" href="${escapeHtml(row.effectiveHref)}" data-skill-effective-link>Open effective source</a>`;
      const updated = `<span class="mono" title="${escapeHtml(row.updatedAt)}">${escapeHtml(absoluteTime(row.updatedAt))}</span>`;
      const references =
        row.references === 0
          ? '<span class="hint mono">0</span>'
          : `<span class="mono">${row.references}</span>`;
      return `<tr data-skill-name="${escapeHtml(row.name)}" data-skill-state="${row.state}" data-skill-state-label="${escapeHtml(row.stateLabel)}">
        <td class="table__primary" data-label="Skill">
          <a class="mono" href="${escapeHtml(row.href)}">${escapeHtml(row.name)}</a>
          <p class="small">${escapeHtml(row.description)}</p>
          ${secondary}
        </td>
        <td data-label="Origin"><span class="cluster">${scopeBadge(row.originScope)}<span class="small">${escapeHtml(row.originText)}</span></span></td>
        <td data-label="State"><span class="cluster">${stateBadge(row)}${issueGlyph(row.issues)}${row.collisions.length === 0 ? "" : `<span class="status" data-state="awaiting_approval" title="${escapeHtml((row.collisions[0] as SkillWarningProps).text)}">${icon("alert-triangle")}<span class="sr-only">Collision</span></span>`}</span></td>
        <td data-label="References">${references}</td>
        <td data-label="Updated">${updated}</td>
        <td class="table__actions"><a class="btn btn-ghost btn-icon" href="${escapeHtml(row.href)}" aria-label="${escapeHtml(row.actionLabel)}">${icon("chevron-right")}</a></td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap card" data-skill-inventory>
    <table class="table table--stack skill-inventory-table">
      <thead>
        <tr><th scope="col">Skill</th><th scope="col">Origin</th><th scope="col">State</th><th scope="col">References</th><th scope="col">Updated</th><th scope="col"><span class="sr-only">Open</span></th></tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function inventoryEmptyState(empty: SkillsInventoryProps["empty"]): string {
  if (empty === null) {
    return "";
  }
  const action =
    empty.actionIcon === null
      ? `<a class="btn btn-${empty.actionStyle}" href="${escapeHtml(empty.actionHref)}">${escapeHtml(empty.actionLabel)}</a>`
      : `<a class="btn btn-${empty.actionStyle}" href="${escapeHtml(empty.actionHref)}">${icon(empty.actionIcon)}${escapeHtml(empty.actionLabel)}</a>`;
  return emptyState({
    iconName: empty.iconName,
    title: empty.title,
    body: empty.body,
    action,
  });
}

function inventoryRail(props: SkillsInventoryProps): string {
  const warnings = props.warnings;
  const collisionSection =
    warnings.length === 0 && props.truncated === null
      ? ""
      : `<section class="card" aria-labelledby="skills-collisions-title">
          <div class="card__head">
            <h2 class="card__title" id="skills-collisions-title">Skill root warnings</h2>
            <span class="badge">${warnings.length}</span>
          </div>
          <div class="card__body stack--tight">
            ${warningList(warnings)}
            ${props.truncated === null ? "" : `<p class="hint">${props.truncated} more collision warnings omitted.</p>`}
          </div>
        </section>`;
  const pendingSection =
    props.pending.length === 0
      ? ""
      : `<section class="card" aria-labelledby="skills-restart-title" data-skill-restart-rail>
          <div class="card__head">
            <h2 class="card__title" id="skills-restart-title">Restart required</h2>
            <span class="badge">${props.pending.length}</span>
          </div>
          <div class="card__body stack--tight">
            <p class="hint">Skills changed. A restart applies the effective set; it is never automatic.</p>
            ${props.pending
              .map(
                (entry) => `<div class="cluster">
                  <a class="small" href="${escapeHtml(entry.href)}">${escapeHtml(entry.appKey)}</a>
                  <span class="status" data-state="awaiting_approval">${icon("stamp")}Restart required</span>
                  <form method="post" action="${escapeHtml(entry.restartAction)}">
                    <input type="hidden" name="return_to" value="${escapeHtml(entry.returnTo)}" />
                    <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
                  </form>
                </div>`,
              )
              .join("")}
          </div>
        </section>`;
  return `<aside class="rail-stack" aria-label="Skills information">
    <section class="card" aria-labelledby="skills-scope-title">
      <div class="card__head"><h2 class="card__title" id="skills-scope-title">Scope &amp; inheritance</h2></div>
      <div class="card__body stack--tight">
        <p class="small">Skills resolve global &rarr; project &rarr; application. The narrowest row wins by name; a disabled row hides wider skills without deleting them.</p>
        <p class="hint">Repository and plugin skills are outside this hierarchy and may shadow a same-named managed skill.</p>
        <p class="hint">Collisions are reported on an application's Skills page.</p>
      </div>
    </section>
    ${collisionSection}
    <section class="card" aria-labelledby="skills-count-title">
      <div class="card__head"><h2 class="card__title" id="skills-count-title">Summary</h2></div>
      <div class="card__body stack--tight">
        <p class="mono">${props.counts.enabled} enabled &middot; ${props.counts.inherited} inherited</p>
        <p class="mono">${props.counts.disabled} disabled &middot; ${props.counts.invalid} invalid</p>
        <p class="hint">Counts are Hanse-effective at this scope, not every skill on disk.</p>
      </div>
    </section>
    ${pendingSection}
  </aside>`;
}

function renderInventoryPage(options: {
  site: SiteModel;
  chrome: PageChrome;
  props: SkillsInventoryProps;
}): string {
  const props = options.props;
  const header = pageHeader({
    overline: props.overline,
    title: props.title,
    description: props.description,
    meta: [...props.meta],
    actions: `<a class="btn btn-primary" href="${escapeHtml(props.createHref)}">${icon("plus")}${escapeHtml(props.createLabel)}</a>`,
  });
  const content = props.empty === null ? inventoryTable(props) : inventoryEmptyState(props.empty);
  const body = `${scopeNav(props.scope)}
    <div class="workbench-grid section">
      <div class="stack">
        ${inventoryToolbar(props)}
        <p class="hint" data-skill-count>${props.matchedCount} of ${props.allCount} skills at this scope</p>
        ${content}
      </div>
      ${inventoryRail(props)}
    </div>`;
  return appShell({
    title: props.title,
    active: "skills",
    ...(props.scope.projectId === null ? {} : { activeProjectId: props.scope.projectId }),
    breadcrumb: [...props.breadcrumb],
    projects: navProjects(options.site),
    pendingCount: options.site.pendingCount,
    operatorName: options.chrome.operatorName,
    notice: options.chrome.notice,
    header,
    body,
    skillsHref: props.scope.href,
  });
}

/* ------------------------------------------------------------------------- */
/* Workspace models                                                           */
/* ------------------------------------------------------------------------- */

interface ParsedBundle {
  license?: string | null;
  compatibility?: string | null;
  metadata?: SkillMetadata;
  metadataRaw?: string | null;
  references?: SkillReference[];
  /** The browser form could not edit these stored fields without JavaScript. */
  preserveInvalid?: boolean;
}

function detailOf(row: SkillRow): Record<string, unknown> {
  return {
    ...row,
    metadataRaw: row.metadataRaw,
    references: row.references.map((reference) => {
      const content = reference.content;
      return {
        path: reference.path,
        content,
        size: Buffer.byteLength(content, "utf8"),
      };
    }),
  };
}

function mergeBundle(base: BundleValues, parsed: ParsedBundle): BundleValues {
  const metadata = parsed.metadata !== undefined ? parsed.metadata : base.metadata;
  const metadataRaw =
    parsed.metadata !== undefined
      ? null
      : parsed.metadataRaw !== undefined
        ? parsed.metadataRaw
        : base.metadataRaw;
  return {
    license: parsed.license !== undefined ? parsed.license : base.license,
    compatibility: parsed.compatibility !== undefined ? parsed.compatibility : base.compatibility,
    metadata,
    metadataRaw,
    references: parsed.references !== undefined ? parsed.references : base.references,
  };
}

function parseBundlePayload(payload: Record<string, unknown>): ParsedBundle {
  let source: Record<string, unknown> = payload;
  if (hasOwn(payload, "bundle")) {
    const rawBundle = payload.bundle;
    if (typeof rawBundle !== "string") {
      throw new SkillsBodyError("bundle must be a JSON string");
    }
    if (rawBundle.trim().length > 0) {
      source = { ...jsonObject(rawBundle, "bundle") };
    }
    for (const key of ["license", "compatibility", "metadata", "metadataRaw", "references"]) {
      if (hasOwn(payload, key)) {
        source[key] = payload[key];
      }
    }
  }
  const parsed: ParsedBundle = {};
  if (hasOwn(source, "license")) {
    const value = source.license;
    if (value !== null && typeof value !== "string") {
      throw new SkillValidationError("license must be a string or null", "license");
    }
    parsed.license = value;
  }
  if (hasOwn(source, "compatibility")) {
    const value = source.compatibility;
    if (value !== null && typeof value !== "string") {
      throw new SkillValidationError("compatibility must be a string or null", "compatibility");
    }
    parsed.compatibility = value;
  }
  if (hasOwn(source, "metadata")) {
    let value = source.metadata;
    if (typeof value === "string") {
      value = jsonObject(value, "metadata");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new SkillValidationError("metadata must be a plain object", "metadata");
    }
    const metadata: SkillMetadata = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry !== "string") {
        throw new SkillValidationError(`metadata value for ${key} must be a string`, "metadata");
      }
      metadata[key] = entry;
    }
    parsed.metadata = metadata;
  }
  if (hasOwn(source, "metadataRaw")) {
    const value = source.metadataRaw;
    if (value !== null && typeof value !== "string") {
      throw new SkillValidationError("metadataRaw must be a string or null", "metadata");
    }
    parsed.metadataRaw = value;
  }
  if (hasOwn(source, "references")) {
    let value = source.references;
    if (typeof value === "string") {
      if (value.trim().length === 0) {
        value = [];
      } else {
        try {
          value = JSON.parse(value) as unknown;
        } catch {
          throw new SkillValidationError("references must be valid JSON", "references");
        }
      }
    }
    if (!Array.isArray(value)) {
      throw new SkillValidationError("references must be an array", "references");
    }
    const references: SkillReference[] = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new SkillValidationError("each reference must have a path and content", "references");
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== "string" || typeof record.content !== "string") {
        throw new SkillValidationError("each reference must have a path and content", "references");
      }
      if (record.path.trim().length === 0 && record.content.trim().length === 0) {
        continue;
      }
      references.push({ path: record.path, content: record.content });
    }
    parsed.references = references;
  }
  if (source.preserveInvalid === true) {
    parsed.preserveInvalid = true;
  }
  return parsed;
}

function valuesFromCreatePayload(
  payload: Record<string, unknown>,
  parsed: ParsedBundle,
): WorkspaceValues {
  return {
    name: stringValue(payload.name) ?? "",
    description: stringValue(payload.description) ?? "",
    content: stringValue(payload.content) ?? "",
    enabled: enabledFrom(payload.enabled) ?? true,
    bundle: mergeBundle(
      {
        license: null,
        compatibility: null,
        metadata: {},
        metadataRaw: null,
        references: [],
      },
      parsed,
    ),
  };
}

function valuesFromUpdatePayload(
  payload: Record<string, unknown>,
  parsed: ParsedBundle,
  row: SkillRow,
): WorkspaceValues {
  return {
    description: stringValue(payload.description) ?? row.description,
    content: stringValue(payload.content) ?? row.content,
    enabled: enabledFrom(payload.enabled) ?? row.enabled,
    bundle: mergeBundle(bundleFromRow(row), parsed),
  };
}

function updatePatch(payload: Record<string, unknown>, parsed: ParsedBundle): SkillUpdate {
  const patch: SkillUpdate = {};
  if (hasOwn(payload, "description")) {
    const value = payload.description;
    if (typeof value !== "string") {
      throw new SkillValidationError("description must be a string", "description");
    }
    patch.description = value;
  }
  if (hasOwn(payload, "content")) {
    const value = payload.content;
    if (typeof value !== "string") {
      throw new SkillValidationError("content must be a string", "content");
    }
    patch.content = value;
  }
  if (hasOwn(payload, "enabled")) {
    patch.enabled = enabledFrom(payload.enabled);
  }
  if (parsed.license !== undefined) {
    patch.license = parsed.license;
  }
  if (parsed.compatibility !== undefined) {
    patch.compatibility = parsed.compatibility;
  }
  if (parsed.metadata !== undefined) {
    const preservesRaw =
      parsed.metadataRaw !== undefined &&
      parsed.metadataRaw !== null &&
      Object.keys(parsed.metadata).length === 0;
    if (!preservesRaw) {
      patch.metadata = parsed.metadata;
    }
  }
  if (parsed.references !== undefined) {
    patch.references = parsed.references;
  }
  if (Object.keys(patch).length === 0) {
    throw new SkillsBodyError("update requires at least one field");
  }
  return patch;
}

/* ------------------------------------------------------------------------- */
/* Workspace rendering                                                        */
/* ------------------------------------------------------------------------- */

function targetFieldsHtml(target: SkillTargetFieldsProps): string {
  const fields = [
    `<input type="hidden" name="scope" value="${escapeHtml(target.scope)}" />`,
    `<input type="hidden" name="return_to" value="${escapeHtml(target.returnTo)}" />`,
  ];
  if (target.scope !== "global") {
    fields.push(
      `<input type="hidden" name="project" value="${escapeHtml(target.projectId ?? "")}" />`,
    );
  }
  if (target.scope === "app") {
    fields.push(`<input type="hidden" name="app" value="${escapeHtml(target.appKey ?? "")}" />`);
  }
  return fields.join("");
}

function metadataValue(metadata: SkillMetadata, key: string): string {
  return metadata[key] ?? "";
}

function metadataField(options: {
  key: string;
  label: string;
  value: string;
  id: string;
  hint: string;
  error?: string;
  datalist?: string;
}): string {
  const hintId = `${options.id}-hint`;
  const describedBy = fieldDescribedBy(
    hintId,
    options.error === undefined ? undefined : `${options.id}-error`,
  );
  return `<div class="field">
    <label class="label" for="${escapeHtml(options.id)}">${escapeHtml(options.label)}</label>
    <input class="input" id="${escapeHtml(options.id)}" type="text" value="${escapeHtml(options.value)}"${options.datalist === undefined ? "" : ` list="${escapeHtml(options.datalist)}"`} disabled data-skill-metadata-key="${escapeHtml(options.key)}"${describedBy} />
    ${fieldError(options.id, options.error)}
    ${fieldHint(hintId, options.hint)}
  </div>`;
}

function fieldDescribedBy(...ids: Array<string | undefined>): string {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length === 0 ? "" : ` aria-describedby="${escapeHtml(present.join(" "))}"`;
}

function fieldHint(id: string, text: string): string {
  return `<p class="hint" id="${escapeHtml(id)}">${escapeHtml(text)}</p>`;
}

function fieldError(id: string, message: string | undefined): string {
  if (message === undefined) {
    return "";
  }
  return `<p class="field-error" id="${escapeHtml(id)}-error" role="alert">${escapeHtml(message)}</p>`;
}

function errorSummary(error: { message: string } | undefined): string {
  if (error === undefined) {
    return "";
  }
  return `<div class="settings-warning" role="alert" data-skill-form-error><p class="settings-warning__title">${icon("alert-triangle")}${escapeHtml(error.message)}</p></div>`;
}

interface WorkspaceError {
  message: string;
  field?: string;
}

const FIELD_GUIDE_ROWS: Array<{ field: string; write: string; example: string }> = [
  {
    field: "Name",
    write: "A stable lowercase slug set when the skill is created.",
    example: "release-checklist",
  },
  {
    field: "Description",
    write: "One sentence on what the skill does and when to load it.",
    example: "Review a release before it ships.",
  },
  {
    field: "Enabled",
    write: "Whether the skill is active at this context.",
    example: "On",
  },
  {
    field: "Domain",
    write: "The broad area the skill belongs to.",
    example: "engineering",
  },
  {
    field: "Role",
    write: "The role the agent plays while using the skill.",
    example: "reviewer",
  },
  {
    field: "Operating scope",
    write: "What part of the work the skill covers.",
    example: "repository",
  },
  {
    field: "Output format",
    write: "The expected result shape: mixed, code, report, document, plan, or decision.",
    example: "report",
  },
  {
    field: "Triggers",
    write: "Comma-separated cues for when to load the skill.",
    example: "release, ship, cut a version",
  },
  {
    field: "Related skills",
    write: "Comma-separated skill names to load alongside this one.",
    example: "testing, changelog",
  },
  {
    field: "Version",
    write: "A short version label.",
    example: "1.0.0",
  },
  {
    field: "Author",
    write: "The person or team responsible for the skill.",
    example: "platform-team",
  },
  {
    field: "License",
    write: "An SPDX identifier or short license name.",
    example: "MIT",
  },
  {
    field: "Compatibility",
    write: "Runtime or tool requirements.",
    example: "Node >= 20",
  },
  {
    field: "Custom metadata",
    write: "Extra key/value pairs used by your own tooling.",
    example: "owner: platform-team",
  },
  {
    field: "References",
    write: "Flat Markdown files under references/ that the skill can point to.",
    example: "references/testing.md",
  },
  {
    field: "SKILL.md body",
    write: "The procedure: steps, checks, and when to stop.",
    example: "1. Confirm the version. 2. Run the checks.",
  },
];

function fieldGuide(): string {
  const rows = FIELD_GUIDE_ROWS.map(
    (row) => `<tr>
      <td data-label="Field">${escapeHtml(row.field)}</td>
      <td data-label="What to write">${escapeHtml(row.write)}</td>
      <td data-label="Example"><span class="mono">${escapeHtml(row.example)}</span></td>
    </tr>`,
  ).join("");
  return `<details class="disclosure skill-field-guide" id="skill-field-guide" data-skill-field-guide>
    <summary>Field guide${icon("chevron-down", "disclosure__chevron")}</summary>
    <div class="table-wrap">
      <table class="table table--stack skill-field-guide__table">
        <thead><tr><th scope="col">Field</th><th scope="col">What to write</th><th scope="col">Example</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

function detailsCard(
  values: SkillWorkspaceProps["values"],
  name: string,
  editable: boolean,
  error: SkillWorkspaceError | null,
  includeName: boolean,
): string {
  const metadata = values.bundle.metadata;
  const field = error?.field;
  const custom = Object.entries(metadata)
    .filter(([key]) => !KNOWN_METADATA_KEYS.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const classification = KNOWN_METADATA.filter((entry) => entry.group === "classification")
    .map((entry) =>
      metadataField({
        key: entry.key,
        label: entry.label,
        value: metadataValue(metadata, entry.key),
        id: `skill-metadata-${entry.key}`,
        hint: entry.hint,
        ...(field === "metadata" ? { error: error?.message } : {}),
        ...(entry.key === "output-format" ? { datalist: "skill-output-formats" } : {}),
      }),
    )
    .join("");
  const discovery = KNOWN_METADATA.filter((entry) => entry.group === "discovery")
    .map((entry) =>
      metadataField({
        key: entry.key,
        label: entry.label,
        value: metadataValue(metadata, entry.key),
        id: `skill-metadata-${entry.key}`,
        hint: entry.hint,
        ...(field === "metadata" ? { error: error?.message } : {}),
      }),
    )
    .join("");
  const versionFields = KNOWN_METADATA.filter((entry) => entry.group === "version")
    .map((entry) =>
      metadataField({
        key: entry.key,
        label: entry.label,
        value: metadataValue(metadata, entry.key),
        id: `skill-metadata-${entry.key}`,
        hint: entry.hint,
        ...(field === "metadata" ? { error: error?.message } : {}),
      }),
    )
    .join("");
  const descriptionError = field === "description" ? error?.message : undefined;
  const enabledError = field === "enabled" ? error?.message : undefined;
  const customRows =
    custom.length === 0
      ? '<p class="hint">No custom metadata keys.</p>'
      : custom
          .map(
            ([key, value]) => `<div class="cluster skill-metadata-row" data-skill-metadata-row>
              <input class="input" type="text" value="${escapeHtml(key)}" disabled data-skill-metadata-key-input aria-label="Metadata key" aria-describedby="skill-custom-metadata-hint" />
              <input class="input" type="text" value="${escapeHtml(value)}" disabled data-skill-metadata-value-input aria-label="Metadata value" aria-describedby="skill-custom-metadata-hint" />
              ${editable ? '<button class="btn btn-ghost btn-sm" type="button" data-skill-remove-metadata aria-label="Remove metadata">Remove</button>' : ""}
            </div>`,
          )
          .join("");
  const rawMetadata =
    values.bundle.metadataRaw === null
      ? ""
      : `<div class="field">
          <label class="label" for="skill-metadata-raw">Raw metadata JSON</label>
          <textarea class="textarea font-mono" id="skill-metadata-raw" rows="6" disabled data-skill-metadata-raw aria-describedby="skill-metadata-raw-hint${field === "metadata" ? " skill-metadata-raw-error" : ""}">${escapeHtml(values.bundle.metadataRaw)}</textarea>
          ${fieldError("skill-metadata-raw", field === "metadata" ? error?.message : undefined)}
          ${fieldHint("skill-metadata-raw-hint", "The stored metadata is invalid. Repair it as a JSON object, or clear it to start over.")}
          ${editable ? '<button class="btn btn-secondary btn-sm" type="button" data-skill-clear-metadata>Clear metadata</button>' : ""}
        </div>`;
  const disabled = editable ? "" : " disabled";
  const descriptionName = editable ? ' name="description"' : "";
  const counter = `<span class="mono" data-skill-counter-output="description">${values.description.length} / ${SKILL_LIMITS.description}</span>`;
  return `<details class="card skill-details" id="skill-details" open data-skill-details>
    <summary class="card__head"><h2 class="card__title">Details</h2><span class="cluster skill-details__meta"><span class="hint">Identity, classification, discovery, license</span><span class="skill-details__chevron" aria-hidden="true">${icon("chevron-right")}</span></span></summary>
    <div class="card__body stack">
      <p class="hint skill-details__intro">Only name, description, and the SKILL.md body are required; the rest are optional. <a href="#skill-field-guide" data-skill-guide-open>Field guide</a>.</p>
      <fieldset class="skill-fieldset">
        <legend class="label">Identity</legend>
        ${
          includeName
            ? `<div class="field">
          <label class="label" for="skill-name">Name</label>
          <input class="input mono" id="skill-name" type="text" value="${escapeHtml(name)}" readonly disabled aria-describedby="skill-name-hint" />
          ${fieldHint("skill-name-hint", "Names are immutable. Delete and re-create the skill to rename it.")}
        </div>`
            : ""
        }
        <div class="field">
          <div class="cluster"><label class="label" for="skill-description">Description</label>${counter}</div>
          <textarea class="textarea" id="skill-description" rows="3" maxlength="${SKILL_LIMITS.description}"${descriptionName}${disabled} required data-skill-counter="${SKILL_LIMITS.description}" data-skill-field="description"${fieldDescribedBy("skill-description-hint", descriptionError === undefined ? undefined : "skill-description-error")}>${escapeHtml(values.description)}</textarea>
          ${fieldError("skill-description", descriptionError)}
          ${fieldHint("skill-description-hint", "What the skill does and when the agent should use it.")}
        </div>
        <div class="field">
          <label class="check">
            <input type="hidden" name="enabled" value="0"${disabled} />
            <input class="checkbox" type="checkbox" name="enabled" value="1"${values.enabled ? " checked" : ""}${disabled} data-skill-field="enabled"${fieldDescribedBy("skill-enabled-hint", enabledError === undefined ? undefined : "skill-enabled-error")} />
            <span>Enabled</span>
          </label>
          ${fieldError("skill-enabled", enabledError)}
          ${fieldHint("skill-enabled-hint", "Uncheck to hide this skill at this context without deleting it.")}
        </div>
      </fieldset>
      <fieldset class="skill-fieldset">
        <legend class="label">Classification</legend>
        <div class="grid skill-details-grid">${classification}</div>
      </fieldset>
      <fieldset class="skill-fieldset">
        <legend class="label">Discovery</legend>
        <div class="grid skill-details-grid">${discovery}</div>
      </fieldset>
      <fieldset class="skill-fieldset">
        <legend class="label">Version and license</legend>
        <div class="grid skill-details-grid">${versionFields}</div>
        <div class="field">
          <label class="label" for="skill-license">License</label>
          <input class="input" id="skill-license" type="text" value="${escapeHtml(values.bundle.license ?? "")}" maxlength="${SKILL_LIMITS.license}" disabled data-skill-field="license"${fieldDescribedBy("skill-license-hint", field === "license" ? "skill-license-error" : undefined)} />
          ${fieldError("skill-license", field === "license" ? error?.message : undefined)}
          ${fieldHint("skill-license-hint", "An SPDX identifier or short license name, such as MIT.")}
        </div>
        <div class="field">
          <label class="label" for="skill-compatibility">Compatibility</label>
          <input class="input" id="skill-compatibility" type="text" value="${escapeHtml(values.bundle.compatibility ?? "")}" maxlength="${SKILL_LIMITS.compatibility}" disabled data-skill-field="compatibility"${fieldDescribedBy("skill-compatibility-hint", field === "compatibility" ? "skill-compatibility-error" : undefined)} />
          ${fieldError("skill-compatibility", field === "compatibility" ? error?.message : undefined)}
          ${fieldHint("skill-compatibility-hint", "Runtime or tool requirements, such as Node 20 or a specific agent version.")}
        </div>
      </fieldset>
      <fieldset class="skill-fieldset">
        <legend class="label">Custom metadata</legend>
        <div class="stack--tight" data-skill-custom-metadata>${customRows}</div>
        ${rawMetadata}
        ${fieldHint("skill-custom-metadata-hint", "Extra key/value pairs are preserved as-is for tooling you control.")}
        ${editable ? '<button class="btn btn-secondary btn-sm" type="button" data-skill-add-metadata>Add metadata</button>' : ""}
      </fieldset>
      ${fieldGuide()}
      <datalist id="skill-output-formats">
        <option value="mixed"></option><option value="code"></option><option value="report"></option><option value="document"></option><option value="plan"></option><option value="decision"></option>
      </datalist>
    </div>
  </details>`;
}

function referenceEditor(
  reference: SkillReference,
  index: number,
  editable: boolean,
  error: string | undefined,
): string {
  const content = reference.content;
  const pathId = `skill-ref-${index}-path`;
  const contentId = `skill-ref-${index}-content`;
  const size = Buffer.byteLength(content, "utf8");
  const body = editable
    ? `<div class="cluster"><label class="label" for="${escapeHtml(contentId)}">Reference body</label><span class="mono" data-skill-counter-output="ref-${index}">${content.length} / ${SKILL_LIMITS.referenceContent}</span></div>
      <textarea class="textarea font-mono skill-source" id="${escapeHtml(contentId)}" rows="12" maxlength="${SKILL_LIMITS.referenceContent}" disabled spellcheck="false" data-skill-counter="${SKILL_LIMITS.referenceContent}" data-skill-reference-content aria-describedby="${escapeHtml(contentId)}-hint${error === undefined ? "" : ` ${escapeHtml(contentId)}-error`}">${escapeHtml(content)}</textarea>
      ${fieldError(contentId, error)}
      ${fieldHint(`${contentId}-hint`, "Markdown reference loaded only when the skill points to this file.")}`
    : `<div class="cluster"><span class="label" id="${escapeHtml(contentId)}-label">Reference body</span><span class="hint mono" data-skill-file-size>${size} bytes</span></div>
      <pre class="skill-source prose--pre" data-skill-source-static tabindex="0" aria-labelledby="${escapeHtml(contentId)}-label">${escapeHtml(content)}</pre>`;
  return `<section class="skill-source-pane" id="skill-file-ref-${index}" data-skill-file data-skill-file-id="skill-file-ref-${index}" data-skill-file-kind="reference" data-skill-reference data-skill-file-path="${escapeHtml(reference.path)}">
    <div class="cluster skill-file-head">
      <span class="mono" id="${escapeHtml(pathId)}">${escapeHtml(reference.path)}</span>
      <span class="hint mono" data-skill-file-size>${size} bytes</span>
      ${editable ? '<button class="btn btn-ghost btn-sm" type="button" data-skill-remove-reference aria-label="Remove this reference file">Remove this file</button>' : ""}
    </div>
    ${body}
  </section>`;
}

function sourceWorkspace(
  values: SkillWorkspaceProps["values"],
  editable: boolean,
  error: SkillWorkspaceError | null,
): string {
  const contentError = error?.field === "content" ? error.message : undefined;
  const referencesError = error?.field === "references" ? error.message : undefined;
  const references = values.bundle.references;
  const contentSize = Buffer.byteLength(values.content, "utf8");
  const referenceSize = (reference: SkillReference): number =>
    Buffer.byteLength(reference.content, "utf8");
  const aggregate = references.reduce((total, reference) => total + reference.content.length, 0);
  const fileTabs =
    references.length === 0
      ? ""
      : `<aside class="skill-file-list" data-skill-file-list aria-label="Skill files">
          <div class="skill-file-list__head">
            <p class="nav-label">Files</p>
            <span class="hint mono" data-skill-file-count>${references.length + 1}</span>
          </div>
          <div class="skill-file-tabs" data-skill-file-tabs>
            <a class="settings-nav__link skill-file-tab" href="#skill-file-skill" aria-current="page" data-skill-file-tab data-skill-file-id="skill-file-skill" data-skill-file-path="SKILL.md">
              <span class="skill-file-tab__name">SKILL.md</span>
              <span class="hint mono skill-file-tab__size" data-skill-file-tab-size>${contentSize} bytes</span>
              <span class="skill-file-dirty" data-skill-file-dirty hidden><span class="sr-only">Unsaved changes</span></span>
            </a>
            ${references
              .map(
                (reference, index) =>
                  `<a class="settings-nav__link skill-file-tab" href="#skill-file-ref-${index}" data-skill-file-tab data-skill-file-id="skill-file-ref-${index}" data-skill-file-path="${escapeHtml(reference.path)}">
                    <span class="skill-file-tab__name">${escapeHtml(reference.path)}</span>
                    <span class="hint mono skill-file-tab__size" data-skill-file-tab-size>${referenceSize(reference)} bytes</span>
                    <span class="skill-file-dirty" data-skill-file-dirty hidden><span class="sr-only">Unsaved changes</span></span>
                  </a>`,
              )
              .join("")}
          </div>
          <div class="skill-file-picker" data-skill-file-picker hidden>
            <label class="sr-only" for="skill-file-select">Active file</label>
            <select class="input" id="skill-file-select" data-skill-file-select></select>
          </div>
          ${editable ? '<button class="btn btn-secondary btn-sm skill-add-reference" type="button" data-skill-add-reference>Add reference</button>' : ""}
        </aside>`;
  const source = editable
    ? `<div class="cluster"><label class="label" for="skill-content">SKILL.md body</label><span class="hint mono" data-skill-file-size>${contentSize} bytes</span><span class="mono" data-skill-counter-output="content">${values.content.length} / ${SKILL_LIMITS.content}</span></div>
      ${fieldHint("skill-content-hint", "The frontmatter is generated from Details; edit only the body here.")}
      <textarea class="textarea font-mono skill-source" id="skill-content" name="content" rows="20" maxlength="${SKILL_LIMITS.content}" required spellcheck="false" data-skill-counter="${SKILL_LIMITS.content}" data-skill-field="content"${fieldDescribedBy("skill-content-hint", contentError === undefined ? undefined : "skill-content-error")}>${escapeHtml(values.content)}</textarea>
      ${fieldError("skill-content", contentError)}`
    : `<div class="cluster"><span class="label" id="skill-content-label">SKILL.md body</span><span class="hint mono" data-skill-file-size>${contentSize} bytes</span></div>
      <pre class="skill-source prose--pre" data-skill-source-static tabindex="0" aria-labelledby="skill-content-label">${escapeHtml(values.content)}</pre>`;
  return `<section class="card skill-files" data-skill-files>
    <div class="card__head">
      <h2 class="card__title">Source and preview</h2>
      <p class="hint">${
        editable
          ? "One bundle form: metadata, SKILL.md, and every reference save together."
          : "Read-only source from the winning row. Override here to edit a copy at this context."
      }</p>
    </div>
    <div class="card__body">
      <div class="skill-workspace" data-skill-workspace>
        ${fileTabs}
        <div class="skill-viewtabs" data-skill-viewtabs hidden>
          <div class="segmented skill-viewtabs__group" role="tablist" aria-label="Source or preview">
            <button class="segmented__item" type="button" role="tab" id="skill-viewtab-source" aria-controls="skill-panes" aria-selected="true" data-skill-viewtab="source">Source</button>
            <button class="segmented__item" type="button" role="tab" id="skill-viewtab-preview" aria-controls="skill-preview-pane" aria-selected="false" data-skill-viewtab="preview">Preview</button>
          </div>
        </div>
        <div class="skill-panes" id="skill-panes" data-skill-panes>
          <section class="skill-source-pane" id="skill-file-skill" data-skill-file data-skill-file-id="skill-file-skill" data-skill-file-kind="skill" data-skill-file-path="SKILL.md">
            ${source}
          </section>
          ${references
            .map((reference, index) => referenceEditor(reference, index, editable, referencesError))
            .join("")}
        </div>
        <div class="skill-preview-pane" id="skill-preview-pane" data-skill-preview-pane tabindex="-1">
          <div class="cluster skill-preview-head"><p class="label">Preview</p><p class="hint mono" data-skill-preview-title>SKILL.md</p></div>
          <div class="skill-frontmatter-slot" data-skill-frontmatter hidden></div>
          <div class="skill-prose" id="skill-preview" data-skill-preview aria-live="polite">
            <p class="hint">Preview requires JavaScript.</p>
          </div>
          <noscript><p class="hint">All file editors above are stacked so no edit is lost without it.</p></noscript>
        </div>
      </div>
      <div class="cluster skill-reference-foot" id="skill-references">
        ${editable ? '<button class="btn btn-secondary btn-sm" type="button" data-skill-add-reference>Add reference</button>' : ""}
        <span class="hint" data-skill-reference-aggregate>${references.length} of ${SKILL_LIMITS.references} files &middot; ${aggregate} of ${SKILL_LIMITS.referenceAggregate} characters</span>
      </div>
      <p class="hint" id="skill-references-hint">References are flat references/&lt;slug&gt;.md files, up to ${SKILL_LIMITS.references} files and ${SKILL_LIMITS.referenceAggregate} characters total.</p>
      ${fieldError("skill-references", referencesError)}
      <template data-skill-reference-template>
        <section class="skill-source-pane" data-skill-file data-skill-file-kind="reference" data-skill-reference>
          <div class="cluster skill-file-head">
            <div class="field skill-file-path-field">
              <label class="label" data-skill-reference-path-label>Path</label>
              <input class="input mono" type="text" disabled data-skill-reference-path placeholder="references/example.md" aria-label="Reference path" aria-describedby="skill-references-hint" maxlength="${SKILL_LIMITS.referencePath}" spellcheck="false" autocomplete="off" />
            </div>
            <span class="hint mono" data-skill-file-size>0 bytes</span>
            <button class="btn btn-ghost btn-sm" type="button" data-skill-remove-reference aria-label="Remove this reference file">Remove this file</button>
          </div>
          <div class="cluster"><span class="label" data-skill-reference-content-label>Reference body</span><span class="mono" data-skill-counter-output>0 / ${SKILL_LIMITS.referenceContent}</span></div>
          <textarea class="textarea font-mono skill-source" rows="12" maxlength="${SKILL_LIMITS.referenceContent}" disabled spellcheck="false" data-skill-counter="${SKILL_LIMITS.referenceContent}" data-skill-reference-content aria-label="Reference content" aria-describedby="skill-references-hint"></textarea>
          <p class="hint">Paths are canonical references/&lt;slug&gt;.md files.</p>
        </section>
      </template>
      <template data-skill-metadata-template>
        <div class="cluster skill-metadata-row" data-skill-metadata-row>
          <input class="input" type="text" disabled data-skill-metadata-key-input placeholder="custom-key" aria-label="Metadata key" aria-describedby="skill-custom-metadata-hint" />
          <input class="input" type="text" disabled data-skill-metadata-value-input placeholder="value" aria-label="Metadata value" aria-describedby="skill-custom-metadata-hint" />
          <button class="btn btn-ghost btn-sm" type="button" data-skill-remove-metadata aria-label="Remove metadata">Remove</button>
        </div>
      </template>
    </div>
  </section>`;
}

function editBar(form: SkillFormProps): string {
  return `<div class="skill-editbar" data-skill-editbar>
    <p class="hint" data-skill-status role="status">All changes saved</p>
    <button class="btn btn-primary" type="submit" name="action" value="${form.mode === "create" ? "create" : "update"}" data-skill-save>${escapeHtml(form.saveLabel)}</button>
    <button class="btn btn-ghost" type="submit" name="action" value="discard" formnovalidate data-skill-discard>${escapeHtml(form.discardLabel)}</button>
  </div>`;
}

function dangerZone(danger: SkillDangerProps, error: SkillWorkspaceError | null): string {
  const mismatch = error?.field === "confirm_name" ? error.message : undefined;
  return `<section class="card skill-danger" data-skill-danger>
    <div class="card__head"><h2 class="card__title">Danger zone</h2></div>
    <div class="card__body stack">
      <p class="small">${escapeHtml(danger.explanation)}</p>
      <form method="post" action="${escapeHtml(danger.action)}" data-skill-delete-form>
        <input type="hidden" name="return_to" value="${escapeHtml(danger.returnTo)}" />
        <div class="field">
          <label class="label" for="skill-confirm-name">Type the exact skill name to confirm</label>
          <input class="input mono" id="skill-confirm-name" type="text" name="confirm_name" required autocomplete="off" spellcheck="false"${mismatch === undefined ? "" : ' aria-describedby="skill-confirm-name-error"'} />
          ${fieldError("skill-confirm-name", mismatch)}
        </div>
        <button class="btn btn-danger" type="submit">${icon("trash")}${escapeHtml(danger.label)}</button>
      </form>
    </div>
  </section>`;
}

function actionLink(link: SkillActionLinkProps): string {
  return `<a class="btn btn-${link.style}" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`;
}

function actionsHtml(actions: SkillActionsProps): string {
  const parts: string[] = [];
  if (actions.override !== null) {
    parts.push(`<form method="post" action="${escapeHtml(actions.override.action)}" data-skill-override data-skill-confirm="${escapeHtml(actions.override.confirm ?? "")}">
          <input type="hidden" name="action" value="override" />
          <input type="hidden" name="from_id" value="${actions.override.fromId ?? 0}" />
          <input type="hidden" name="enabled" value="${actions.override.enabled ?? "1"}" />
          ${targetFieldsHtml(actions.target)}
          <button class="btn btn-${actions.override.style}" type="submit">${escapeHtml(actions.override.label)}</button>
        </form>`);
  }
  if (actions.disable !== null) {
    parts.push(`<form method="post" action="${escapeHtml(actions.disable.action)}" data-skill-disable data-skill-confirm="${escapeHtml(actions.disable.confirm ?? "")}">
          <input type="hidden" name="action" value="override" />
          <input type="hidden" name="from_id" value="${actions.disable.fromId ?? 0}" />
          <input type="hidden" name="enabled" value="${actions.disable.enabled ?? "0"}" />
          ${targetFieldsHtml(actions.target)}
          <button class="btn btn-${actions.disable.style}" type="submit">${escapeHtml(actions.disable.label)}</button>
        </form>`);
  }
  if (actions.editAtSource !== null) {
    parts.push(actionLink(actions.editAtSource));
  }
  if (actions.openEffective !== null) {
    parts.push(actionLink(actions.openEffective));
  }
  if (actions.openTombstone !== null) {
    parts.push(actionLink(actions.openTombstone));
  }
  if (actions.revert !== null) {
    parts.push(`<form method="post" action="${escapeHtml(actions.revert.action)}" data-skill-revert data-skill-confirm="${escapeHtml(actions.revert.confirm ?? "")}">
              <input type="hidden" name="return_to" value="${escapeHtml(actions.revert.returnTo)}" />
              <button class="btn btn-${actions.revert.style}" type="submit">${escapeHtml(actions.revert.label)}</button>
            </form>`);
  }
  if (actions.openRepair !== null) {
    parts.push(actionLink(actions.openRepair));
  }
  if (actions.openSource !== null) {
    parts.push(actionLink(actions.openSource));
  }
  if (parts.length === 0) {
    return "";
  }
  return `<div class="cluster skill-page-actions" data-skill-actions>${parts.join("")}</div>`;
}

function scopeStrip(props: SkillWorkspaceProps): string {
  const current = (option: SkillsInventoryProps["scope"]["options"][number]): string =>
    option.current
      ? `<span class="settings-nav__link" aria-current="page">${icon("check")}${escapeHtml(option.label)}</span>`
      : `<span class="settings-nav__link">${escapeHtml(option.label)}</span>`;
  const options = props.scope.options
    .filter((option) => option.scope === "global" || option.href !== null)
    .map(current)
    .join("");
  return `<nav class="settings-nav skill-scope-strip" aria-label="Viewing scope" data-skill-scope-strip>
    <div class="settings-nav__scopes" role="group" aria-label="Skill scope">
      ${options}
    </div>
    <p class="hint">Source: <strong class="mono">${escapeHtml(scopeLabel(props.row.scope))}</strong> &middot; ${escapeHtml(props.state.note)}</p>
  </nav>`;
}

function restartBanner(restart: SkillWorkspaceProps["restart"]): string {
  if (restart === null) {
    return "";
  }
  if (restart.kind === "none") {
    return `<p class="hint" data-skill-restart-banner="none">${icon("check")}${escapeHtml(restart.hint)}</p>`;
  }
  return `<section class="settings-warning" role="status" data-skill-restart-banner>
    <p class="settings-warning__title">${icon("refresh")}Restart required</p>
    <p class="small">${escapeHtml(restart.hint)}</p>
    ${restart.entries
      .map(
        (entry) => `<div class="cluster">
          <a class="small" href="${escapeHtml(entry.href)}">${escapeHtml(entry.appKey)}</a>
          <form method="post" action="${escapeHtml(entry.restartAction)}">
            <input type="hidden" name="return_to" value="${escapeHtml(entry.returnTo)}" />
            <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
          </form>
        </div>`,
      )
      .join("")}
  </section>`;
}

function renderWorkspacePage(options: {
  site: SiteModel;
  chrome: PageChrome;
  props: SkillWorkspaceProps;
}): string {
  const props = options.props;
  const error: SkillWorkspaceError | null =
    props.error === null
      ? null
      : {
          message: props.error.message,
          ...(props.error.field === null ? {} : { field: props.error.field }),
        };
  const form = props.form;
  const editable = form !== null;
  const conflict =
    props.conflict === null
      ? ""
      : `<p class="field-error" role="alert" data-skill-conflict>This name already exists at this scope. <a href="${escapeHtml(props.conflict.href)}">Open the existing skill</a>.</p>`;
  const errorSummaryHtml = error === null ? "" : errorSummary(error);
  const header = pageHeader({
    overline: props.header.overline,
    title: props.header.title,
    description: props.header.description,
    meta: [...props.header.meta],
    actions:
      props.create && props.header.backHref !== null
        ? `<a class="btn btn-ghost" href="${escapeHtml(props.header.backHref)}">${escapeHtml(props.labels.backToSkills)}</a>`
        : actionsHtml(props.actions),
  });
  const workspace =
    editable && form !== null
      ? `<div class="stack skill-edit-workspace" data-skill-edit-workspace>
        <form class="stack skill-bundle-form" method="post" action="${escapeHtml(form.action)}" data-skill-form data-skill-mode="${form.mode}" data-skill-name="${escapeHtml(form.name)}">
          ${form.mode === "create" ? targetFieldsHtml(form.target) : `<input type="hidden" name="return_to" value="${escapeHtml(form.returnTo)}" />`}
          <input type="hidden" name="bundle" value="${escapeHtml(form.bundleSnapshot)}" data-skill-bundle />
          ${editBar(form)}
          ${
            form.mode === "create" && form.nameField !== null
              ? `<div class="field">
                <label class="label" for="skill-name">Name</label>
                <input class="input mono" id="skill-name" name="name" type="text" value="${escapeHtml(form.nameField.value)}" required maxlength="${form.nameField.maxlength}" pattern="${escapeHtml(form.nameField.pattern)}" autocomplete="off" spellcheck="false" placeholder="release-checklist"${fieldDescribedBy("skill-name-hint", form.nameField.error === null ? undefined : "skill-name-error")} />
                ${fieldError("skill-name", form.nameField.error ?? undefined)}
                ${fieldHint("skill-name-hint", form.nameField.hint)}
              </div>`
              : ""
          }
          ${errorSummaryHtml}
          ${conflict}
          ${detailsCard(props.values, props.name, true, error, form.mode !== "create")}
          ${sourceWorkspace(props.values, true, error)}
        </form>
        ${props.danger === null ? "" : dangerZone(props.danger, error)}
      </div>`
      : `<div class="stack skill-readonly-workspace" data-skill-readonly-workspace>
        <div class="stack skill-readonly" data-skill-readonly data-skill-name="${escapeHtml(props.name)}">
          ${detailsCard(props.values, props.name, false, error, true)}
          ${sourceWorkspace(props.values, false, error)}
        </div>
        ${props.danger === null || props.state.name !== "invalid-owned-name" ? "" : dangerZone(props.danger, error)}
      </div>`;
  const issues = issueList(props.issues);
  const collisions =
    props.collisions.length === 0
      ? ""
      : `<section class="settings-warning" role="alert" data-skill-collisions>${warningList(props.collisions)}</section>`;
  const restart = props.create ? "" : restartBanner(props.restart);
  const stateBadgeHtml = props.create
    ? '<span class="badge badge-info">Draft</span>'
    : `<span class="badge skill-state badge-${props.stateBadge.tone}" data-skill-state>${escapeHtml(props.stateBadge.label)}</span>`;
  const body = `${props.create ? "" : scopeStrip(props)}
    <div class="cluster section">${stateBadgeHtml}<a class="small" href="${escapeHtml(props.contextPage)}">${escapeHtml(props.labels.backToSkills)}</a></div>
    ${restart}
    ${collisions}
    ${issues}
    ${workspace}`;
  return appShell({
    title: props.title,
    active: "skills",
    ...(props.projectId === null ? {} : { activeProjectId: props.projectId }),
    breadcrumb: [...props.breadcrumb],
    projects: navProjects(options.site),
    pendingCount: options.site.pendingCount,
    operatorName: options.chrome.operatorName,
    notice: options.chrome.notice,
    header,
    body,
    moduleScripts: ["/assets/skill-detail.js"],
    skillsHref: props.contextPage,
  });
}

/* ------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* ------------------------------------------------------------------------- */

function skillError(error: unknown): WorkspaceError | undefined {
  if (error instanceof SkillValidationError) {
    return {
      message: error.message,
      ...(error.field === undefined ? {} : { field: error.field }),
    };
  }
  if (error instanceof SkillsConfirmError) {
    return { message: error.message, field: "confirm_name" };
  }
  if (error instanceof SkillsTargetError || error instanceof SkillsBodyError) {
    return { message: error.message };
  }
  return undefined;
}

function mutationError(
  error: unknown,
  browser: boolean,
  returnTo: string,
): HttpResponse | undefined {
  if (error instanceof SkillValidationError) {
    if (error.message === "invalid_override_source") {
      if (browser) {
        return redirectNotice(returnTo, "invalid_override_source", "error");
      }
      return errorJson(400, {
        error: "invalid_override_source",
        code: "invalid_override_source",
      });
    }
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(400, {
      error: error.message,
      code: error.code,
      ...(error.field === undefined ? {} : { field: error.field }),
    });
  }
  if (error instanceof SkillsConfirmError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(400, { error: error.message, code: error.code, field: error.field });
  }
  if (error instanceof SkillsTargetError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(400, { error: error.message, code: error.code });
  }
  if (error instanceof SkillsOverrideError) {
    if (browser) {
      return redirectNotice(returnTo, "invalid_override_source", "error");
    }
    return errorJson(400, { error: "invalid_override_source", code: "invalid_override_source" });
  }
  if (error instanceof SkillsBodyError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return errorJson(400, { error: error.message, code: "invalid_body" });
  }
  return undefined;
}

function notFound(browser: boolean, site?: SiteModel, chrome?: PageChrome): HttpResponse {
  if (browser && site !== undefined && chrome !== undefined) {
    return html(404, renderNotFound(site, chrome));
  }
  return errorJson(404, { error: "not found", code: "not_found" });
}

/* ------------------------------------------------------------------------- */
/* Dispatch                                                                  */
/* ------------------------------------------------------------------------- */

export function isSkillsRoute(method: string, pathname: string): boolean {
  if (pathname === "/skills/new") {
    return method === "GET";
  }
  if (/^\/skills\/\d+$/.test(pathname)) {
    return method === "GET";
  }
  if (pathname === "/skills") {
    return method === "GET";
  }
  if (/^\/projects\/[^/]+\/skills$/.test(pathname)) {
    return method === "GET";
  }
  if (/^\/projects\/[^/]+\/apps\/[^/]+\/skills$/.test(pathname)) {
    return method === "GET";
  }
  if (pathname === "/api/skills") {
    return method === "GET" || method === "POST";
  }
  if (/^\/api\/skills\/[^/]+\/delete$/.test(pathname)) {
    return method === "POST";
  }
  return method === "GET" || method === "POST" || method === "DELETE"
    ? /^\/api\/skills\/[^/]+$/.test(pathname)
    : false;
}

function skillsPageFor(pathname: string): { scope: SkillScope; target: SkillTarget } | undefined {
  if (pathname === "/skills") {
    return { scope: "global", target: {} };
  }
  const project = /^\/projects\/([^/]+)\/skills$/.exec(pathname);
  if (project !== null) {
    return { scope: "project", target: { projectId: safeDecode(project[1] ?? "") } };
  }
  const app = /^\/projects\/([^/]+)\/apps\/([^/]+)\/skills$/.exec(pathname);
  if (app !== null) {
    return {
      scope: "app",
      target: {
        projectId: safeDecode(app[1] ?? ""),
        appKey: safeDecode(app[2] ?? ""),
      },
    };
  }
  return undefined;
}

export async function handleSkills(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  let skills: SkillService;
  try {
    skills = deps.skills ?? new SkillService({ db: deps.db });
  } catch {
    return errorJson(503, { error: "skills are not available", code: "skills_unavailable" });
  }

  const browser = wantsHtml(request);
  const mutation = request.method === "POST" || request.method === "DELETE";

  if (mutation && !originAllowed(request)) {
    return errorJson(403, { error: "cross-site request rejected", code: "cross_origin" });
  }

  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return browser
      ? redirect(`/login?next=${encodeURIComponent(requestPath(request))}`)
      : errorJson(401, { error: "sign in required", code: "unauthorized" });
  }
  if (principal.kind !== "human") {
    return errorJson(403, {
      error: "only a human principal may manage skills",
      code: "human_only",
    });
  }
  const actor = principal.name;

  try {
    if (request.path === "/api/skills" && request.method === "GET") {
      const { scope, target } = targetFromQuery(request.query ?? {});
      if (!targetExists(deps, scope, target)) {
        return notFound(browser);
      }
      const resolved = skills.resolve(target);
      const preview = previewFor(deps, skills, scope, target);
      if (preview === undefined) {
        return json(200, resolved);
      }
      return json(200, {
        ...resolved,
        warnings: preview.warnings,
        ...(preview.truncated === undefined ? {} : { truncated: preview.truncated }),
      });
    }

    if (request.path === "/api/skills" && request.method === "POST") {
      let returnTo = "/skills";
      let payload: Record<string, unknown>;
      let scope: SkillScope = "global";
      let target: SkillTarget = {};
      try {
        payload = parseObjectBody(request);
        const parsedTarget = parseExplicitTarget(payload);
        scope = parsedTarget.scope;
        target = parsedTarget.target;
        returnTo = safeSkillReturn(stringValue(payload.return_to), skillsPagePath(scope, target));
      } catch (error) {
        const mapped = mutationError(error, browser, returnTo);
        if (mapped !== undefined) {
          return mapped;
        }
        throw error;
      }
      const site = browser ? buildSite(deps) : undefined;
      if (!targetExists(deps, scope, target)) {
        return notFound(browser, site, site === undefined ? undefined : pageChrome(actor, request));
      }
      const action = stringValue(payload.action) ?? "";
      if (action === "discard") {
        if (browser) {
          return redirectNotice(returnTo, "Changes discarded.", "success");
        }
        return json(200, { discarded: true });
      }
      if (action === "create") {
        let selected: WorkspaceValues | undefined;
        try {
          const parsed = parseBundlePayload(payload);
          selected = valuesFromCreatePayload(payload, parsed);
          if (selected.bundle.metadataRaw !== null) {
            throw new SkillValidationError("metadata must be valid JSON", "metadata");
          }
          const skill = skills.create(
            scope,
            target,
            {
              name: stringValue(payload.name),
              description: selected.description,
              content: selected.content,
              enabled: selected.enabled,
              license: selected.bundle.license,
              compatibility: selected.bundle.compatibility,
              metadata: selected.bundle.metadata,
              references: selected.bundle.references,
            },
            actor,
          );
          if (browser) {
            return redirectNotice(workspacePath(skill, returnTo), "Skill created.", "success");
          }
          return json(200, { skill: detailOf(skill) });
        } catch (error) {
          if (error instanceof SkillConflictError) {
            if (browser) {
              const existing = skills
                .resolve(target)
                .rows.find((entry) => entry.name === (stringValue(payload.name) ?? ""));
              const values = selected ?? valuesFromCreatePayload(payload, {});
              return html(
                409,
                renderCreateConflictPage({
                  site: site ?? buildSite(deps),
                  chrome: pageChrome(actor, request),
                  scope,
                  target,
                  values,
                  existingId: existing?.id,
                }),
              );
            }
            return errorJson(409, { error: error.message, code: error.code });
          }
          const workspaceError = skillError(error);
          if (browser && workspaceError !== undefined) {
            const values = selected ?? valuesFromCreatePayload(payload, {});
            return html(
              422,
              renderCreatePage({
                site: site ?? buildSite(deps),
                chrome: pageChrome(actor, request),
                scope,
                target,
                values,
                error: workspaceError,
              }),
            );
          }
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
      }
      if (action === "override") {
        try {
          const fromId = parseId(payload.from_id);
          if (fromId === undefined) {
            throw new SkillsOverrideError();
          }
          const enabled = enabledFrom(payload.enabled);
          const skill = skills.override(fromId, scope, target, enabled, actor);
          if (browser) {
            return redirectNotice(
              returnTo,
              enabled === false ? "Skill disabled here." : "Skill overridden here.",
              "success",
            );
          }
          return json(200, { skill: detailOf(skill) });
        } catch (error) {
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
      }
      return errorJson(400, {
        error: "action must be create or override",
        code: "invalid_body",
      });
    }

    const deleteMatch = /^\/api\/skills\/([^/]+)\/delete$/.exec(request.path);
    if (deleteMatch !== null && request.method === "POST") {
      const id = parseId(safeDecode(deleteMatch[1] ?? ""));
      const row = id === undefined ? undefined : skills.get(id);
      if (id === undefined || row === undefined) {
        return notFound(browser, browser ? buildSite(deps) : undefined, pageChrome(actor, request));
      }
      let returnTo = rowPagePath(row);
      let payload: Record<string, unknown> = {};
      try {
        payload = parseObjectBody(request);
        returnTo = safeSkillReturn(stringValue(payload.return_to), returnTo);
        const confirm = stringValue(payload.confirm_name);
        if (confirm !== undefined && confirm !== row.name) {
          throw new SkillsConfirmError();
        }
        skills.delete(id);
        if (browser) {
          return redirectNotice(
            returnTo,
            row.enabled ? "Skill deleted." : "Skill reverted to inherited.",
            "success",
          );
        }
        return json(200, { deleted: true });
      } catch (error) {
        if (error instanceof SkillsConfirmError && browser) {
          const site = buildSite(deps);
          const props = buildSkillDetailProps({
            deps,
            site,
            skills,
            row,
            context: { scope: row.scope, target: rowTarget(row) },
            error: { message: error.message, field: error.field },
          });
          return html(
            422,
            renderWorkspacePage({ site, chrome: pageChrome(actor, request), props }),
          );
        }
        const mapped = mutationError(error, browser, returnTo);
        if (mapped !== undefined) {
          return mapped;
        }
        throw error;
      }
    }

    const idMatch = /^\/api\/skills\/([^/]+)$/.exec(request.path);
    if (idMatch !== null) {
      const id = parseId(safeDecode(idMatch[1] ?? ""));
      const row = id === undefined ? undefined : skills.get(id);
      if (id === undefined || row === undefined) {
        return notFound(browser, browser ? buildSite(deps) : undefined, pageChrome(actor, request));
      }
      if (request.method === "GET") {
        return json(200, { skill: detailOf(row) });
      }
      if (request.method === "DELETE") {
        skills.delete(id);
        return json(200, { deleted: true });
      }
      if (request.method === "POST") {
        let returnTo = workspacePath(row);
        let payload: Record<string, unknown>;
        try {
          payload = parseObjectBody(request);
          returnTo = safeSkillReturn(stringValue(payload.return_to), returnTo);
        } catch (error) {
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
        const action = stringValue(payload.action) ?? "update";
        if (action === "delete") {
          const deleteReturnTo = safeSkillReturn(stringValue(payload.return_to), rowPagePath(row));
          try {
            const confirm = stringValue(payload.confirm_name);
            if (confirm !== undefined && confirm !== row.name) {
              throw new SkillsConfirmError();
            }
            skills.delete(id);
            if (browser) {
              return redirectNotice(
                deleteReturnTo,
                row.enabled ? "Skill deleted." : "Skill reverted to inherited.",
                "success",
              );
            }
            return json(200, { deleted: true });
          } catch (error) {
            if (error instanceof SkillsConfirmError && browser) {
              const site = buildSite(deps);
              const props = buildSkillDetailProps({
                deps,
                site,
                skills,
                row,
                context: { scope: row.scope, target: rowTarget(row) },
                error: { message: error.message, field: error.field },
              });
              return html(
                422,
                renderWorkspacePage({ site, chrome: pageChrome(actor, request), props }),
              );
            }
            const mapped = mutationError(error, browser, returnTo);
            if (mapped !== undefined) {
              return mapped;
            }
            throw error;
          }
        }
        if (action === "discard") {
          if (browser) {
            return redirectNotice(returnTo, "Changes discarded.", "success");
          }
          return json(200, { discarded: true });
        }
        if (action !== "update") {
          return errorJson(400, { error: "action must be update or delete", code: "invalid_body" });
        }
        let values: WorkspaceValues | undefined = valuesFromUpdatePayload(payload, {}, row);
        try {
          const parsed = parseBundlePayload(payload);
          values = valuesFromUpdatePayload(payload, parsed, row);
          const patch = updatePatch(payload, parsed);
          let skill: SkillRow;
          try {
            skill = skills.update(id, patch, actor);
          } catch (error) {
            if (!(parsed.preserveInvalid === true && error instanceof SkillValidationError)) {
              throw error;
            }
            // Without JavaScript the invalid stored bundle fields cannot be
            // edited; preserve them and apply only the legacy fields so a
            // body/description save never fails on unrelated corrupt data.
            const fallback: SkillUpdate = {};
            if (patch.description !== undefined) {
              fallback.description = patch.description;
            }
            if (patch.content !== undefined) {
              fallback.content = patch.content;
            }
            if (patch.enabled !== undefined) {
              fallback.enabled = patch.enabled;
            }
            if (Object.keys(fallback).length === 0) {
              throw error;
            }
            skill = skills.update(id, fallback, actor);
          }
          if (browser) {
            return redirectNotice(
              returnTo,
              patch.enabled === false ? "Skill disabled here." : "Skill saved.",
              "success",
            );
          }
          return json(200, { skill: detailOf(skill) });
        } catch (error) {
          const workspaceError = skillError(error);
          if (browser && workspaceError !== undefined) {
            const site = buildSite(deps);
            const props = buildSkillDetailProps({
              deps,
              site,
              skills,
              row,
              context: { scope: row.scope, target: rowTarget(row) },
              ...(values === undefined ? {} : { values }),
              error: workspaceError,
            });
            return html(
              422,
              renderWorkspacePage({ site, chrome: pageChrome(actor, request), props }),
            );
          }
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
      }
      return notFound(browser);
    }

    if (request.path === "/skills/new" && request.method === "GET") {
      const site = buildSite(deps);
      const chrome = pageChrome(actor, request);
      let parsed: { scope: SkillScope; target: SkillTarget };
      try {
        parsed = createTargetFromQuery(request.query ?? {});
      } catch {
        return html(404, renderNotFound(site, chrome));
      }
      if (!targetExists(deps, parsed.scope, parsed.target)) {
        return html(404, renderNotFound(site, chrome));
      }
      return html(
        200,
        renderCreatePage({
          site,
          chrome,
          scope: parsed.scope,
          target: parsed.target,
        }),
      );
    }

    const detailMatch = /^\/skills\/(\d+)$/.exec(request.path);
    if (detailMatch !== null && request.method === "GET") {
      const id = parseId(detailMatch[1] ?? "");
      const row = id === undefined ? undefined : skills.get(id);
      if (row === undefined) {
        const site = buildSite(deps);
        return notFound(browser, site, pageChrome(actor, request));
      }
      const site = buildSite(deps);
      const props = buildSkillDetailProps({
        deps,
        site,
        skills,
        row,
        ...(request.query?.from === undefined ? {} : { from: request.query.from }),
      });
      return html(200, renderWorkspacePage({ site, chrome: pageChrome(actor, request), props }));
    }

    const page = skillsPageFor(request.path);
    if (page === undefined || request.method !== "GET") {
      return notFound(browser);
    }
    const site = buildSite(deps);
    const chrome = pageChrome(actor, request);
    const props = buildSkillsInventoryProps({
      deps,
      site,
      skills,
      scope: page.scope,
      target: page.target,
      filter: parseInventoryFilter(request.query?.filter),
      search: (request.query?.q ?? "").trim(),
    });
    if (props === undefined) {
      return html(404, renderNotFound(site, chrome));
    }
    return html(200, renderInventoryPage({ site, chrome, props }));
  } catch (error) {
    if (error instanceof SkillsTargetError || error instanceof SkillsBodyError) {
      const mapped = mutationError(error, browser, "/skills");
      if (mapped !== undefined) {
        return mapped;
      }
    }
    if (!browser) {
      return errorJson(500, { error: "internal error", code: "internal_error" });
    }
    const site = buildSite(deps);
    const message = error instanceof Error ? error.message : String(error);
    return html(500, renderErrorPage(site, pageChrome(actor, request), message));
  }
}

/* ------------------------------------------------------------------------- */
/* Create page helpers                                                        */
/* ------------------------------------------------------------------------- */

interface CreatePageOptions {
  site: SiteModel;
  chrome: PageChrome;
  scope: SkillScope;
  target: SkillTarget;
  error?: WorkspaceError;
}

function renderCreatePage(options: CreatePageOptions & { values?: WorkspaceValues }): string {
  const props = buildSkillCreateProps({
    site: options.site,
    scope: options.scope,
    target: options.target,
    ...(options.values === undefined ? {} : { values: options.values }),
    ...(options.error === undefined ? {} : { error: options.error }),
  });
  return renderWorkspacePage({ site: options.site, chrome: options.chrome, props });
}

function renderCreateConflictPage(
  options: CreatePageOptions & { values: WorkspaceValues; existingId?: number },
): string {
  const props = buildSkillCreateProps({
    site: options.site,
    scope: options.scope,
    target: options.target,
    values: options.values,
    error: { message: "A skill with this name already exists at this scope.", field: "name" },
    ...(options.existingId === undefined ? {} : { conflictId: options.existingId }),
  });
  return renderWorkspacePage({ site: options.site, chrome: options.chrome, props });
}
