import path from "node:path";
import { resolveInstanceEnv } from "../opencode/instance.js";
import type { RegisteredApp } from "../registry/index.js";
import {
  type EffectiveSkill,
  type ResolvedSkills,
  SKILL_LIMITS,
  type SkillApplyOptions,
  SkillConflictError,
  type SkillMetadata,
  type SkillPreview,
  type SkillReference,
  type SkillRow,
  type SkillScope,
  SkillService,
  type SkillStoredIssue,
  type SkillSummary,
  type SkillTarget,
  type SkillUpdate,
  SkillValidationError,
  type SkillWarning,
} from "../skills/index.js";
import { appDir } from "./apps.js";
import { principalFrom } from "./auth.js";
import {
  buildSite,
  type PageChrome,
  type ProjectView,
  renderErrorPage,
  renderNotFound,
  type SiteModel,
} from "./dashboard.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
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

class SkillsTargetError extends Error {
  readonly code = "invalid_scope_target";

  constructor(message: string) {
    super(message);
    this.name = "SkillsTargetError";
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

function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
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
/* Scope and target                                                           */
/* ------------------------------------------------------------------------- */

function scopeLabel(scope: SkillScope): string {
  if (scope === "global") {
    return "Global";
  }
  return scope === "project" ? "Project" : "Application";
}

function scopeRank(scope: SkillScope): number {
  return scope === "global" ? 0 : scope === "project" ? 1 : 2;
}

function parseScope(value: unknown): SkillScope {
  if (value === "global" || value === "project" || value === "app") {
    return value;
  }
  throw new SkillsTargetError("scope must be global, project, or app");
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function targetForScope(scope: SkillScope, target: SkillTarget): SkillTarget {
  if (scope === "global") {
    return {};
  }
  if (scope === "project") {
    return { projectId: target.projectId ?? "" };
  }
  return { projectId: target.projectId ?? "", appKey: target.appKey ?? "" };
}

function rowTarget(row: SkillRow): SkillTarget {
  return targetForScope(row.scope, {
    projectId: row.projectId,
    appKey: row.appKey,
  });
}

function sameTarget(scope: SkillScope, left: SkillTarget, right: SkillTarget): boolean {
  if (scope === "global") {
    return true;
  }
  if ((left.projectId ?? "") !== (right.projectId ?? "")) {
    return false;
  }
  if (scope === "project") {
    return true;
  }
  return (left.appKey ?? "") === (right.appKey ?? "");
}

function parseExplicitTarget(source: Record<string, unknown>): {
  scope: SkillScope;
  target: SkillTarget;
} {
  const scope = parseScope(source.scope);
  const projectId = nonEmpty(stringField(source, "projectId", "project"));
  const appKey = nonEmpty(stringField(source, "appKey", "app"));
  if (scope === "global") {
    if (projectId !== undefined || appKey !== undefined) {
      throw new SkillsTargetError("global scope does not accept a project or application");
    }
    return { scope, target: {} };
  }
  if (scope === "project") {
    if (projectId === undefined) {
      throw new SkillsTargetError("project scope requires a project");
    }
    if (appKey !== undefined) {
      throw new SkillsTargetError("project scope does not accept an application");
    }
    return { scope, target: { projectId } };
  }
  if (projectId === undefined || appKey === undefined) {
    throw new SkillsTargetError("app scope requires a project and an application");
  }
  return { scope, target: { projectId, appKey } };
}

function targetFromQuery(query: Record<string, string>): {
  scope: SkillScope;
  target: SkillTarget;
} {
  const projectId = nonEmpty(query.project);
  const appKey = nonEmpty(query.app);
  if (appKey !== undefined && projectId === undefined) {
    throw new SkillsTargetError("app requires a project");
  }
  if (projectId === undefined) {
    return { scope: "global", target: {} };
  }
  if (appKey === undefined) {
    return { scope: "project", target: { projectId } };
  }
  return { scope: "app", target: { projectId, appKey } };
}

function createTargetFromQuery(query: Record<string, string>): {
  scope: SkillScope;
  target: SkillTarget;
} {
  const projectId = nonEmpty(query.project);
  const appKey = nonEmpty(query.app);
  if (query.scope === undefined || query.scope.trim().length === 0) {
    return targetFromQuery(query);
  }
  return parseExplicitTarget({ scope: query.scope, project: projectId, app: appKey });
}

function skillsPagePath(scope: SkillScope, target: SkillTarget): string {
  if (scope === "global") {
    return "/skills";
  }
  const projectId = encodeURIComponent(target.projectId ?? "");
  if (scope === "project") {
    return `/projects/${projectId}/skills`;
  }
  return `/projects/${projectId}/apps/${encodeURIComponent(target.appKey ?? "")}/skills`;
}

function createPagePath(scope: SkillScope, target: SkillTarget): string {
  const params = new URLSearchParams();
  params.set("scope", scope);
  if (scope !== "global") {
    params.set("project", target.projectId ?? "");
  }
  if (scope === "app") {
    params.set("app", target.appKey ?? "");
  }
  return `/skills/new?${params.toString()}`;
}

function rowPagePath(row: SkillRow): string {
  return skillsPagePath(row.scope, rowTarget(row));
}

function workspacePath(row: SkillRow, from?: string): string {
  const base = `/skills/${row.id}`;
  if (from === undefined || from === rowPagePath(row)) {
    return base;
  }
  return `${base}?from=${encodeURIComponent(from)}`;
}

function targetExists(deps: HttpDeps, scope: SkillScope, target: SkillTarget): boolean {
  if (scope === "global") {
    return true;
  }
  const project = deps.getProjects().find((entry) => entry.id === target.projectId);
  if (project === undefined) {
    return false;
  }
  if (scope === "project") {
    return true;
  }
  return project.service.listApps().some((app) => app.appKey === target.appKey);
}

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
/* Preview and models                                                         */
/* ------------------------------------------------------------------------- */

interface SurfaceModel {
  scope: SkillScope;
  target: SkillTarget;
  resolved: ResolvedSkills;
  preview?: SkillPreview;
  returnTo: string;
}

function previewFor(
  deps: HttpDeps,
  skills: SkillService,
  scope: SkillScope,
  target: SkillTarget,
): SkillPreview | undefined {
  if (scope !== "app") {
    return undefined;
  }
  const project = deps.getProjects().find((entry) => entry.id === target.projectId);
  const app =
    project === undefined || target.appKey === undefined
      ? undefined
      : project.service.listApps().find((entry) => entry.appKey === target.appKey);
  if (project === undefined || app === undefined || target.appKey === undefined) {
    return undefined;
  }
  const directory = appDir(project, app);
  const isolated =
    deps.agentsHome === undefined
      ? undefined
      : resolveInstanceEnv(deps.agentsHome, { projectId: project.id, app: app.appKey });
  const options: SkillApplyOptions = {
    appRoot: isolated === undefined ? directory : path.dirname(isolated.HOME),
    home: isolated?.HOME ?? path.join(directory, ".hanse-no-home"),
    xdgCacheHome: isolated?.XDG_CACHE_HOME ?? path.join(directory, ".hanse-no-cache"),
    appDir: directory,
    ...(deps.baselinePlugins === undefined ? {} : { baselinePlugins: deps.baselinePlugins }),
  };
  return skills.preview(target, options);
}

function surfaceModel(
  deps: HttpDeps,
  skills: SkillService,
  scope: SkillScope,
  target: SkillTarget,
  returnTo: string,
): SurfaceModel {
  const resolved = skills.resolve(target);
  const preview = previewFor(deps, skills, scope, target);
  return {
    scope,
    target,
    resolved,
    ...(preview === undefined ? {} : { preview }),
    returnTo,
  };
}

function warningsFor(
  warnings: readonly SkillWarning[],
  name: string,
  codes: readonly SkillWarning["code"][],
): SkillWarning[] {
  return warnings.filter((warning) => warning.name === name && codes.includes(warning.code));
}

function warningText(warning: SkillWarning): string {
  if (warning.code === "skill_collision") {
    return `"${warning.name ?? ""}" also exists at ${warning.root ?? "another skill root"}`;
  }
  return `"${warning.name ?? ""}" is disabled here but also exists at ${warning.root ?? "another skill root"}`;
}

function warningList(warnings: readonly SkillWarning[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return warnings
    .map(
      (warning) =>
        `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(warningText(warning))}</p>`,
    )
    .join("");
}

/* ------------------------------------------------------------------------- */
/* Stored issue rendering                                                     */
/* ------------------------------------------------------------------------- */

function issueText(issue: SkillStoredIssue): string {
  switch (issue.code) {
    case "invalid_skill_name":
      return "The stored name is not a valid skill name. Names are immutable; delete and re-create the skill.";
    case "invalid_skill_metadata":
      return `The stored metadata is not valid JSON: ${issue.detail}`;
    case "invalid_skill_reference":
      return `Reference ${issue.path}: ${issue.detail}`;
    case "invalid_skill_bundle":
      return `The stored bundle is invalid: ${issue.detail}`;
  }
}

function issueAnchor(issue: SkillStoredIssue): string | undefined {
  switch (issue.code) {
    case "invalid_skill_metadata":
      return "#skill-metadata-raw";
    case "invalid_skill_reference":
      return "#skill-references";
    case "invalid_skill_bundle":
      return "#skill-details";
    case "invalid_skill_name":
      return undefined;
  }
}

function issueList(issues: readonly SkillStoredIssue[], owned: boolean): string {
  if (issues.length === 0) {
    return "";
  }
  const items = issues
    .map((issue) => {
      const anchor = owned ? issueAnchor(issue) : undefined;
      const link =
        anchor === undefined ? "" : ` <a class="small" href="${escapeHtml(anchor)}">Repair</a>`;
      return `<li>${escapeHtml(issueText(issue))}${link}</li>`;
    })
    .join("");
  return `<section class="settings-warning" role="alert" data-skill-issues>
    <p class="settings-warning__title">${icon("alert-triangle")}Issues</p>
    <ul class="stack--tight">${items}</ul>
  </section>`;
}

function issueGlyph(issues: readonly SkillStoredIssue[]): string {
  if (issues.length === 0) {
    return "";
  }
  return `<span class="status" data-state="failed" title="${escapeHtml(issueText(issues[0] as SkillStoredIssue))}">${icon("alert-triangle")}<span class="sr-only">Invalid</span></span>`;
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

function pageEntities(
  site: SiteModel,
  scope: SkillScope,
  target: SkillTarget,
): { project?: ProjectView; app?: RegisteredApp } | undefined {
  if (scope === "global") {
    return {};
  }
  const project =
    target.projectId === undefined
      ? undefined
      : site.projects.find((entry) => entry.id === target.projectId);
  if (project === undefined) {
    return undefined;
  }
  if (scope === "project") {
    return { project };
  }
  const app = project.apps.find((entry) => entry.appKey === target.appKey);
  if (app === undefined) {
    return undefined;
  }
  return { project, app };
}

function pendingApps(
  site: SiteModel,
  scope: SkillScope,
  target: SkillTarget,
): Array<{ projectId: string; appKey: string }> {
  const entries: Array<{ projectId: string; appKey: string }> = [];
  for (const project of site.projects) {
    if (scope !== "global" && project.id !== target.projectId) {
      continue;
    }
    for (const app of project.apps) {
      if (scope === "app" && app.appKey !== target.appKey) {
        continue;
      }
      if (site.pendingRestart.get(app.id) === true) {
        entries.push({ projectId: project.id, appKey: app.appKey });
      }
    }
  }
  return entries;
}

/* ------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* ------------------------------------------------------------------------- */

type InventoryState = "enabled" | "inherited" | "disabled" | "invalid";
type InventoryFilter = "all" | "defined" | "inherited" | "disabled" | "invalid";

interface InventoryRow {
  id: number;
  name: string;
  description: string;
  scope: SkillScope;
  state: InventoryState;
  stateLabel: string;
  originScope: SkillScope;
  originText: string;
  references: number;
  updatedAt: string;
  issues: SkillStoredIssue[];
  collisions: SkillWarning[];
  repairId?: number;
  effectiveId?: number;
  effectiveScope?: SkillScope;
}

function parseInventoryFilter(value: string | undefined): InventoryFilter {
  if (value === "defined" || value === "inherited" || value === "disabled" || value === "invalid") {
    return value;
  }
  return "all";
}

function buildInventoryRows(
  model: SurfaceModel,
  warnings: readonly SkillWarning[],
): InventoryRow[] {
  const effectiveByName = new Map<string, EffectiveSkill>();
  for (const skill of model.resolved.effective) {
    effectiveByName.set(skill.name, skill);
  }
  const scopedByName = new Map<string, SkillSummary>();
  for (const row of model.resolved.rows) {
    scopedByName.set(row.name, row);
  }
  const disabledByName = new Map(model.resolved.disabled.map((entry) => [entry.name, entry]));
  const names = new Set<string>([...effectiveByName.keys(), ...scopedByName.keys()]);
  const rows: InventoryRow[] = [];
  for (const name of [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const scoped = scopedByName.get(name);
    const effective = effectiveByName.get(name);
    if (scoped === undefined && effective === undefined) {
      continue;
    }
    const collisions = warningsFor(warnings, name, ["skill_collision", "skill_disabled_elsewhere"]);
    const base = scoped ?? effective;
    if (base === undefined) {
      continue;
    }
    let state: InventoryState;
    let stateLabel: string;
    let originScope: SkillScope;
    let originText: string;
    let repairId: number | undefined;
    let effectiveId: number | undefined;
    let effectiveScope: SkillScope | undefined;
    if (scoped !== undefined) {
      if (scoped.storedIssues.length > 0) {
        state = "invalid";
        const invalidName = scoped.storedIssues.some(
          (issue) => issue.code === "invalid_skill_name",
        );
        if (effective !== undefined && effective.id !== scoped.id) {
          stateLabel = invalidName ? "Invalid here" : "Invalid local override";
          effectiveId = effective.id;
          effectiveScope = effective.source;
          originScope = effective.source;
          originText = `Effective source: ${scopeLabel(effective.source)}`;
        } else {
          stateLabel = "Invalid here";
          originScope = scoped.scope;
          originText = "Defined here";
        }
        repairId = scoped.id;
      } else if (!scoped.enabled) {
        const disabled = disabledByName.get(name);
        state = "disabled";
        stateLabel = "Disabled here";
        originScope = disabled?.source ?? scoped.scope;
        originText =
          disabled?.source === null || disabled?.source === undefined
            ? "Hidden at this scope"
            : `Inherited from ${scopeLabel(disabled.source)}`;
      } else {
        state = "enabled";
        stateLabel = "Enabled here";
        originScope = scoped.scope;
        originText =
          effective === undefined || effective.shadows.length === 0
            ? "Defined here"
            : `Overrides ${effective.shadows.map(scopeLabel).join(", ")}`;
      }
      rows.push({
        id: scoped.id,
        name,
        description: scoped.description,
        scope: scoped.scope,
        state,
        stateLabel,
        originScope,
        originText,
        references: scoped.references.length,
        updatedAt: scoped.updatedAt,
        issues: scoped.storedIssues,
        collisions,
        ...(repairId === undefined ? {} : { repairId }),
        ...(effectiveId === undefined ? {} : { effectiveId }),
        ...(effectiveScope === undefined ? {} : { effectiveScope }),
      });
      continue;
    }
    if (effective === undefined) {
      continue;
    }
    rows.push({
      id: effective.id,
      name,
      description: effective.description,
      scope: effective.source,
      state: "inherited",
      stateLabel: "Inherited",
      originScope: effective.source,
      originText: `Inherited from ${scopeLabel(effective.source)}`,
      references: effective.references.length,
      updatedAt: effective.updatedAt,
      issues: [],
      collisions,
    });
  }
  return rows;
}

function inventoryMatchesFilter(row: InventoryRow, filter: InventoryFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "defined":
      return row.state !== "inherited";
    case "inherited":
      return row.state === "inherited";
    case "disabled":
      return row.state === "disabled";
    case "invalid":
      return row.state === "invalid";
  }
}

function inventoryMatchesSearch(row: InventoryRow, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const needle = query.toLowerCase();
  return row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle);
}

function scopeBadge(scope: SkillScope): string {
  return `<span class="badge">${escapeHtml(scopeLabel(scope))}</span>`;
}

function stateBadge(row: InventoryRow): string {
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

function scopeNav(scope: SkillScope, target: SkillTarget): string {
  const projectHref =
    target.projectId === undefined
      ? undefined
      : `/projects/${encodeURIComponent(target.projectId)}/skills`;
  const appHref =
    target.projectId === undefined || target.appKey === undefined
      ? undefined
      : `/projects/${encodeURIComponent(target.projectId)}/apps/${encodeURIComponent(target.appKey)}/skills`;
  const current = (label: string, short?: string): string =>
    short === undefined
      ? `<span class="settings-nav__link" aria-current="page">${icon("check")}${escapeHtml(label)}</span>`
      : `<span class="settings-nav__link" aria-current="page">${icon("check")}<span class="settings-nav__scope-full">${escapeHtml(label)}</span><span class="settings-nav__scope-short">${escapeHtml(short)}</span></span>`;
  const scopes = [
    scope === "global"
      ? current("Global")
      : '<a class="settings-nav__link" href="/skills">Global</a>',
    projectHref === undefined
      ? ""
      : scope === "project"
        ? current("Project")
        : `<a class="settings-nav__link" href="${escapeHtml(projectHref)}">Project</a>`,
    appHref === undefined
      ? ""
      : scope === "app"
        ? current("Application", "App")
        : `<a class="settings-nav__link" href="${escapeHtml(appHref)}">Application</a>`,
  ].join("");
  return `<nav class="settings-nav" aria-label="Skills">
    <div class="settings-nav__scopes" role="group" aria-label="Skills scope">${scopes}</div>
  </nav>`;
}

function inventoryToolbar(model: SurfaceModel, filter: InventoryFilter, search: string): string {
  const pagePath = skillsPagePath(model.scope, model.target);
  const filterHref = (value: InventoryFilter): string => {
    const params = new URLSearchParams();
    if (value !== "all") {
      params.set("filter", value);
    }
    if (search.length > 0) {
      params.set("q", search);
    }
    const query = params.toString();
    return query.length === 0 ? pagePath : `${pagePath}?${query}`;
  };
  const filters: Array<{ value: InventoryFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "defined", label: "Defined here" },
    { value: "inherited", label: "Inherited" },
    { value: "disabled", label: "Disabled" },
    { value: "invalid", label: "Invalid" },
  ];
  return `<div class="toolbar skill-toolbar" data-skill-inventory-toolbar>
    <form method="get" action="${escapeHtml(pagePath)}" role="search" class="cluster">
      <label class="sr-only" for="skill-search">Search skills</label>
      ${filter === "all" ? "" : `<input type="hidden" name="filter" value="${escapeHtml(filter)}" />`}
      <input class="input search-input" id="skill-search" type="search" name="q" value="${escapeHtml(search)}" placeholder="Search skills" autocomplete="off" />
      <button class="btn btn-secondary" type="submit">${icon("search")}Search</button>
    </form>
    <div class="segmented" role="group" aria-label="Filter skills">
      ${filters
        .map(
          (entry) =>
            `<a class="segmented__item" href="${escapeHtml(filterHref(entry.value))}"${entry.value === filter ? ' aria-current="page"' : ""}>${escapeHtml(entry.label)}</a>`,
        )
        .join("")}
    </div>
  </div>`;
}

function inventoryTable(model: SurfaceModel, rows: readonly InventoryRow[]): string {
  const from = encodeURIComponent(skillsPagePath(model.scope, model.target));
  const body = rows
    .map((row) => {
      const primaryId = row.repairId ?? row.effectiveId ?? row.id;
      const href = `/skills/${primaryId}?from=${from}`;
      const effectiveHref =
        row.effectiveId === undefined ? undefined : `/skills/${row.effectiveId}?from=${from}`;
      const secondary =
        effectiveHref === undefined
          ? ""
          : `<a class="small" href="${escapeHtml(effectiveHref)}" data-skill-effective-link>Open effective source</a>`;
      const updated = `<span class="mono" title="${escapeHtml(row.updatedAt)}">${escapeHtml(absoluteTime(row.updatedAt))}</span>`;
      const references =
        row.references === 0
          ? '<span class="hint mono">0</span>'
          : `<span class="mono">${row.references}</span>`;
      return `<tr data-skill-name="${escapeHtml(row.name)}" data-skill-state="${row.state}" data-skill-state-label="${escapeHtml(row.stateLabel)}">
        <td class="table__primary" data-label="Skill">
          <a class="mono" href="${escapeHtml(href)}">${escapeHtml(row.name)}</a>
          <p class="small">${escapeHtml(row.description)}</p>
          ${secondary}
        </td>
        <td data-label="Origin"><span class="cluster">${scopeBadge(row.originScope)}<span class="small">${escapeHtml(row.originText)}</span></span></td>
        <td data-label="State"><span class="cluster">${stateBadge(row)}${issueGlyph(row.issues)}${row.collisions.length === 0 ? "" : `<span class="status" data-state="awaiting_approval" title="${escapeHtml(warningText(row.collisions[0] as SkillWarning))}">${icon("alert-triangle")}<span class="sr-only">Collision</span></span>`}</span></td>
        <td data-label="References">${references}</td>
        <td data-label="Updated">${updated}</td>
        <td class="table__actions"><a class="btn btn-ghost btn-icon" href="${escapeHtml(href)}" aria-label="Open ${escapeHtml(row.name)}">${icon("chevron-right")}</a></td>
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

function inventoryEmptyState(options: {
  model: SurfaceModel;
  allEmpty: boolean;
  search: string;
}): string {
  const createHref = createPagePath(options.model.scope, options.model.target);
  const pagePath = skillsPagePath(options.model.scope, options.model.target);
  if (options.allEmpty) {
    return emptyState({
      iconName: "code",
      title: "No skills here yet",
      body: "A skill is a reusable procedure an agent loads at start. Create the first skill at this scope, or inherit one from a wider scope.",
      action: `<a class="btn btn-primary" href="${escapeHtml(createHref)}">${icon("plus")}Create the first skill</a>`,
    });
  }
  if (options.search.length > 0) {
    return emptyState({
      iconName: "search",
      title: "No skills match your search",
      body: `Nothing matches “${options.search}” at this scope.`,
      action: `<a class="btn btn-secondary" href="${escapeHtml(pagePath)}">Clear search</a>`,
    });
  }
  return emptyState({
    iconName: "inbox",
    title: "No skills match this filter",
    body: "Try another filter to see the skills at this scope.",
    action: `<a class="btn btn-secondary" href="${escapeHtml(pagePath)}">Show all skills</a>`,
  });
}

function inventoryRail(
  model: SurfaceModel,
  site: SiteModel,
  rows: readonly InventoryRow[],
): string {
  const pending = pendingApps(site, model.scope, model.target);
  const warnings = model.preview?.warnings ?? [];
  const collisionSection =
    warnings.length === 0 && model.preview?.truncated === undefined
      ? ""
      : `<section class="card" aria-labelledby="skills-collisions-title">
          <div class="card__head">
            <h2 class="card__title" id="skills-collisions-title">Skill root warnings</h2>
            <span class="badge">${warnings.length}</span>
          </div>
          <div class="card__body stack--tight">
            ${warningList(warnings)}
            ${model.preview?.truncated === undefined ? "" : `<p class="hint">${model.preview.truncated} more collision warnings omitted.</p>`}
          </div>
        </section>`;
  const pendingSection =
    pending.length === 0
      ? ""
      : `<section class="card" aria-labelledby="skills-restart-title" data-skill-restart-rail>
          <div class="card__head">
            <h2 class="card__title" id="skills-restart-title">Restart required</h2>
            <span class="badge">${pending.length}</span>
          </div>
          <div class="card__body stack--tight">
            <p class="hint">Skills changed. A restart applies the effective set; it is never automatic.</p>
            ${pending
              .map(
                (entry) => `<div class="cluster">
                  <a class="small" href="/projects/${encodeURIComponent(entry.projectId)}/apps/${encodeURIComponent(entry.appKey)}">${escapeHtml(entry.appKey)}</a>
                  <span class="status" data-state="awaiting_approval">${icon("stamp")}Restart required</span>
                  <form method="post" action="/api/apps/${encodeURIComponent(entry.appKey)}/restart?project=${encodeURIComponent(entry.projectId)}">
                    <input type="hidden" name="return_to" value="${escapeHtml(skillsPagePath(model.scope, model.target))}" />
                    <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
                  </form>
                </div>`,
              )
              .join("")}
          </div>
        </section>`;
  const counts = {
    enabled: rows.filter((row) => row.state === "enabled").length,
    inherited: rows.filter((row) => row.state === "inherited").length,
    disabled: rows.filter((row) => row.state === "disabled").length,
    invalid: rows.filter((row) => row.state === "invalid").length,
  };
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
        <p class="mono">${counts.enabled} enabled &middot; ${counts.inherited} inherited</p>
        <p class="mono">${counts.disabled} disabled &middot; ${counts.invalid} invalid</p>
        <p class="hint">Counts are Hanse-effective at this scope, not every skill on disk.</p>
      </div>
    </section>
    ${pendingSection}
  </aside>`;
}

function renderInventoryPage(options: {
  site: SiteModel;
  chrome: PageChrome;
  model: SurfaceModel;
  project?: ProjectView;
  app?: RegisteredApp;
  filter: InventoryFilter;
  search: string;
}): string {
  const { model } = options;
  const project = options.project;
  const app = options.app;
  const warnings = model.preview?.warnings ?? model.resolved.warnings;
  const allRows = buildInventoryRows(model, warnings);
  const rows = allRows
    .filter((row) => inventoryMatchesFilter(row, options.filter))
    .filter((row) => inventoryMatchesSearch(row, options.search));
  const description =
    model.scope === "global"
      ? "Reusable procedures every application can load. Project and application scopes can override or disable them."
      : model.scope === "project"
        ? `Skills for ${project?.name ?? ""}. Application scopes can override or disable them.`
        : `Skills for ${app?.appKey ?? ""}. This is the narrowest scope.`;
  const breadcrumb =
    model.scope === "global"
      ? [{ label: "Workbench", href: "/" }, { label: "Skills" }]
      : model.scope === "project"
        ? [
            { label: "Projects", href: "/projects" },
            {
              label: project?.name ?? "",
              href: `/projects/${encodeURIComponent(project?.id ?? "")}`,
            },
            { label: "Skills" },
          ]
        : [
            { label: "Projects", href: "/projects" },
            {
              label: project?.name ?? "",
              href: `/projects/${encodeURIComponent(project?.id ?? "")}`,
            },
            {
              label: app?.appKey ?? "",
              href: `/projects/${encodeURIComponent(project?.id ?? "")}/apps/${encodeURIComponent(app?.appKey ?? "")}`,
            },
            { label: "Skills" },
          ];
  const header = pageHeader({
    overline: scopeLabel(model.scope),
    title: "Skills",
    description,
    meta: [
      ...(model.scope === "global" ? [] : [project?.name ?? ""]),
      ...(model.scope === "app" ? [app?.appKey ?? ""] : []),
    ].filter((entry) => entry.length > 0),
    actions: `<a class="btn btn-primary" href="${escapeHtml(createPagePath(model.scope, model.target))}">${icon("plus")}New skill</a>`,
  });
  const content =
    allRows.length === 0
      ? inventoryEmptyState({ model, allEmpty: true, search: options.search })
      : rows.length === 0
        ? inventoryEmptyState({ model, allEmpty: false, search: options.search })
        : inventoryTable(model, rows);
  const body = `${scopeNav(model.scope, model.target)}
    <div class="workbench-grid section">
      <div class="stack">
        ${inventoryToolbar(model, options.filter, options.search)}
        <p class="hint" data-skill-count>${rows.length} of ${allRows.length} skills at this scope</p>
        ${content}
      </div>
      ${inventoryRail(model, options.site, allRows)}
    </div>`;
  return appShell({
    title: "Skills",
    active: "skills",
    activeProjectId: project?.id,
    breadcrumb,
    projects: navProjects(options.site),
    pendingCount: options.site.pendingCount,
    operatorName: options.chrome.operatorName,
    notice: options.chrome.notice,
    header,
    body,
    skillsHref: skillsPagePath(model.scope, model.target),
  });
}

/* ------------------------------------------------------------------------- */
/* Workspace models                                                           */
/* ------------------------------------------------------------------------- */

interface BundleValues {
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  metadataRaw: string | null;
  references: SkillReference[];
}

interface WorkspaceValues {
  name?: string;
  description: string;
  content: string;
  enabled: boolean;
  bundle: BundleValues;
}

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

function bundleFromRow(row: SkillRow): BundleValues {
  return {
    license: row.license,
    compatibility: row.compatibility,
    metadata: row.metadata,
    metadataRaw: row.metadataRaw,
    references: row.references.map((reference) => ({
      path: reference.path,
      content: reference.content,
    })),
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

type WorkspaceStateName =
  | "editable"
  | "tombstone"
  | "invalid-owned"
  | "invalid-owned-name"
  | "inherited"
  | "shadowed"
  | "hidden"
  | "invalid-context"
  | "not-effective";

interface WorkspaceState {
  name: WorkspaceStateName;
  contextScope: SkillScope;
  contextTarget: SkillTarget;
  resolved: ResolvedSkills;
  scoped?: SkillSummary;
  effective?: EffectiveSkill;
  editable: boolean;
}

function stateLabelFor(name: WorkspaceStateName): string {
  switch (name) {
    case "editable":
      return "Enabled here";
    case "tombstone":
      return "Disabled here";
    case "invalid-owned":
      return "Invalid here";
    case "invalid-owned-name":
      return "Invalid here";
    case "inherited":
      return "Inherited";
    case "shadowed":
      return "Shadowed";
    case "hidden":
      return "Hidden at this context";
    case "invalid-context":
      return "Invalid here";
    case "not-effective":
      return "Not effective here";
  }
}

function stateNote(state: WorkspaceState, row: SkillRow): string {
  switch (state.name) {
    case "editable":
      return "Defined at this scope. Saving changes applies to this row only.";
    case "tombstone":
      return "This tombstone hides the wider skill. Enable it and save to restore the inherited body, or revert below.";
    case "invalid-owned":
      return "This row is invalid and is not effective. Repair the issues above and save.";
    case "invalid-owned-name":
      return "The stored name is invalid, so this row cannot be repaired in place. Delete and re-create it with a valid name.";
    case "inherited":
      return `Inherited from ${scopeLabel(row.scope)}. Override here to edit a copy at this context.`;
    case "shadowed":
      return "A different row is the effective winner at this context. Edit that row or open it to inspect the effective source.";
    case "hidden":
      return "A tombstone at this context hides this wider skill.";
    case "invalid-context":
      return "A row at this context is invalid and is being repaired there. This wider source is read-only here.";
    case "not-effective":
      return "This row is disabled or invalid and is not effective at this context.";
  }
}

function parseScopePath(
  value: string | undefined,
): { scope: SkillScope; target: SkillTarget } | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const withoutHash = value.split("#")[0] ?? "";
  const pathname = withoutHash.split("?")[0] ?? "";
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) {
    return undefined;
  }
  return skillsPageFor(pathname);
}

function viewContext(
  deps: HttpDeps,
  from: string | undefined,
  row: SkillRow,
): { scope: SkillScope; target: SkillTarget; page: string } {
  const own = { scope: row.scope, target: rowTarget(row) };
  const parsed = parseScopePath(from);
  if (parsed !== undefined && targetExists(deps, parsed.scope, parsed.target)) {
    if (scopeRank(parsed.scope) >= scopeRank(row.scope)) {
      return { ...parsed, page: skillsPagePath(parsed.scope, parsed.target) };
    }
  }
  return { ...own, page: skillsPagePath(own.scope, own.target) };
}

function workspaceState(
  skills: SkillService,
  row: SkillRow,
  context: { scope: SkillScope; target: SkillTarget },
): WorkspaceState {
  if (row.scope === context.scope && sameTarget(row.scope, rowTarget(row), context.target)) {
    const editableName = row.storedIssues.some((issue) => issue.code === "invalid_skill_name");
    const invalid = row.storedIssues.length > 0;
    const name: WorkspaceStateName = invalid
      ? editableName
        ? "invalid-owned-name"
        : "invalid-owned"
      : row.enabled
        ? "editable"
        : "tombstone";
    return {
      name,
      contextScope: context.scope,
      contextTarget: context.target,
      resolved: skills.resolve(context.target),
      editable: !editableName,
    };
  }
  const resolved = skills.resolve(context.target);
  const scoped = resolved.rows.find((entry) => entry.name === row.name && entry.id !== row.id);
  const effective = resolved.effective.find((entry) => entry.name === row.name);
  let name: WorkspaceStateName;
  if (scoped !== undefined) {
    if (scoped.storedIssues.length > 0) {
      name = "invalid-context";
    } else if (!scoped.enabled) {
      name = "hidden";
    } else if (effective !== undefined && effective.id === scoped.id) {
      name = "shadowed";
    } else {
      name = "invalid-context";
    }
  } else if (effective !== undefined && effective.id === row.id) {
    name = "inherited";
  } else if (effective !== undefined) {
    name = "shadowed";
  } else {
    name = "not-effective";
  }
  return {
    name,
    contextScope: context.scope,
    contextTarget: context.target,
    resolved,
    ...(scoped === undefined ? {} : { scoped }),
    ...(effective === undefined ? {} : { effective }),
    editable: false,
  };
}

/* ------------------------------------------------------------------------- */
/* Workspace rendering                                                        */
/* ------------------------------------------------------------------------- */

function scopeStrip(state: WorkspaceState, row: SkillRow): string {
  const { contextTarget } = state;
  const projectHref =
    contextTarget.projectId === undefined
      ? undefined
      : `/projects/${encodeURIComponent(contextTarget.projectId)}/skills`;
  const appHref =
    contextTarget.projectId === undefined || contextTarget.appKey === undefined
      ? undefined
      : `/projects/${encodeURIComponent(contextTarget.projectId)}/apps/${encodeURIComponent(contextTarget.appKey)}/skills`;
  const current = (scope: SkillScope, label: string): string =>
    scope === state.contextScope
      ? `<span class="settings-nav__link" aria-current="page">${icon("check")}${escapeHtml(label)}</span>`
      : `<span class="settings-nav__link">${escapeHtml(label)}</span>`;
  return `<nav class="settings-nav skill-scope-strip" aria-label="Viewing scope" data-skill-scope-strip>
    <div class="settings-nav__scopes" role="group" aria-label="Skill scope">
      ${current("global", "Global")}
      ${projectHref === undefined ? "" : current("project", "Project")}
      ${appHref === undefined ? "" : current("app", "Application")}
    </div>
    <p class="hint">Source: <strong class="mono">${escapeHtml(scopeLabel(row.scope))}</strong> &middot; ${escapeHtml(stateNote(state, row))}</p>
  </nav>`;
}

function scopeBreadcrumb(
  site: SiteModel,
  state: WorkspaceState,
  row: SkillRow,
): Array<{ label: string; href?: string }> {
  const project =
    state.contextTarget.projectId === undefined
      ? undefined
      : site.projects.find((entry) => entry.id === state.contextTarget.projectId);
  const app =
    project === undefined
      ? undefined
      : project.apps.find((entry) => entry.appKey === state.contextTarget.appKey);
  const scopePage = skillsPagePath(state.contextScope, state.contextTarget);
  if (state.contextScope === "global") {
    return [
      { label: "Workbench", href: "/" },
      { label: "Skills", href: scopePage },
      { label: row.name },
    ];
  }
  if (state.contextScope === "project") {
    return [
      { label: "Projects", href: "/projects" },
      {
        label: project?.name ?? "",
        href: `/projects/${encodeURIComponent(project?.id ?? "")}`,
      },
      { label: "Skills", href: scopePage },
      { label: row.name },
    ];
  }
  return [
    { label: "Projects", href: "/projects" },
    {
      label: project?.name ?? "",
      href: `/projects/${encodeURIComponent(project?.id ?? "")}`,
    },
    {
      label: app?.appKey ?? "",
      href: `/projects/${encodeURIComponent(project?.id ?? "")}/apps/${encodeURIComponent(app?.appKey ?? "")}`,
    },
    { label: "Skills", href: scopePage },
    { label: row.name },
  ];
}

function restartBanner(state: WorkspaceState, site: SiteModel, row: SkillRow): string {
  const pending = pendingApps(site, state.contextScope, state.contextTarget);
  const effectiveHere =
    state.name === "editable" || state.name === "tombstone" || state.name === "inherited";
  if (!effectiveHere) {
    return `<p class="hint" data-skill-restart-banner="none">${icon("check")}This change does not affect a running agent; no restart is needed.</p>`;
  }
  if (pending.length === 0) {
    return "";
  }
  return `<section class="settings-warning" role="status" data-skill-restart-banner>
    <p class="settings-warning__title">${icon("refresh")}Restart required</p>
    <p class="small">The effective skill set changed. Restart an agent to apply it; Hanse never restarts automatically.</p>
    ${pending
      .map(
        (entry) => `<div class="cluster">
          <a class="small" href="/projects/${encodeURIComponent(entry.projectId)}/apps/${encodeURIComponent(entry.appKey)}">${escapeHtml(entry.appKey)}</a>
          <form method="post" action="/api/apps/${encodeURIComponent(entry.appKey)}/restart?project=${encodeURIComponent(entry.projectId)}">
            <input type="hidden" name="return_to" value="${escapeHtml(workspacePath(row))}" />
            <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
          </form>
        </div>`,
      )
      .join("")}
  </section>`;
}

function workspaceActions(state: WorkspaceState, row: SkillRow, sourcePage: string): string {
  switch (state.name) {
    case "inherited": {
      const targetFields = hiddenTargetFields(state.contextScope, state.contextTarget, sourcePage);
      return `<div class="cluster skill-page-actions" data-skill-actions>
        <form method="post" action="/api/skills" data-skill-override data-skill-confirm="Create an editable copy of this skill at this context?">
          <input type="hidden" name="action" value="override" />
          <input type="hidden" name="from_id" value="${row.id}" />
          <input type="hidden" name="enabled" value="1" />
          ${targetFields}
          <button class="btn btn-primary" type="submit">Override here</button>
        </form>
        <form method="post" action="/api/skills" data-skill-disable data-skill-confirm="Disable this skill at this context? A wider skill stays hidden until you revert.">
          <input type="hidden" name="action" value="override" />
          <input type="hidden" name="from_id" value="${row.id}" />
          <input type="hidden" name="enabled" value="0" />
          ${targetFields}
          <button class="btn btn-secondary" type="submit">Disable here</button>
        </form>
        <a class="btn btn-ghost" href="${escapeHtml(workspacePath(row))}">Edit at source</a>
      </div>`;
    }
    case "shadowed":
      return `<div class="cluster skill-page-actions" data-skill-actions>
        <a class="btn btn-primary" href="${escapeHtml(workspacePath(row))}">Edit at source</a>
        ${state.effective === undefined ? "" : `<a class="btn btn-secondary" href="/skills/${state.effective.id}?from=${encodeURIComponent(sourcePage)}">Open effective source</a>`}
      </div>`;
    case "hidden": {
      const tombstone = state.scoped;
      const tombstoneLink =
        tombstone === undefined
          ? ""
          : `<a class="btn btn-secondary" href="/skills/${tombstone.id}?from=${encodeURIComponent(sourcePage)}">Open tombstone</a>`;
      const revert =
        tombstone === undefined
          ? ""
          : `<form method="post" action="/api/skills/${tombstone.id}/delete" data-skill-revert data-skill-confirm="Revert this tombstone? The wider skill becomes effective here.">
              <input type="hidden" name="return_to" value="${escapeHtml(sourcePage)}" />
              <button class="btn btn-secondary" type="submit">Revert to inherited</button>
            </form>`;
      return `<div class="cluster skill-page-actions" data-skill-actions>${tombstoneLink}${revert}</div>`;
    }
    case "invalid-context": {
      const scoped = state.scoped;
      return `<div class="cluster skill-page-actions" data-skill-actions>${
        scoped === undefined
          ? ""
          : `<a class="btn btn-primary" href="/skills/${scoped.id}?from=${encodeURIComponent(sourcePage)}">Open/repair at context</a>`
      }</div>`;
    }
    case "not-effective":
      return `<div class="cluster skill-page-actions" data-skill-actions><a class="btn btn-secondary" href="${escapeHtml(workspacePath(row))}">Open source</a></div>`;
    case "editable":
    case "tombstone":
    case "invalid-owned":
    case "invalid-owned-name":
      return "";
  }
}

function hiddenTargetFields(scope: SkillScope, target: SkillTarget, returnTo: string): string {
  const fields = [
    `<input type="hidden" name="scope" value="${escapeHtml(scope)}" />`,
    `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />`,
  ];
  if (scope !== "global") {
    fields.push(
      `<input type="hidden" name="project" value="${escapeHtml(target.projectId ?? "")}" />`,
    );
  }
  if (scope === "app") {
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
  values: WorkspaceValues,
  row: SkillRow,
  editable: boolean,
  error: WorkspaceError | undefined,
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
          <input class="input mono" id="skill-name" type="text" value="${escapeHtml(row.name)}" readonly disabled aria-describedby="skill-name-hint" />
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
  values: WorkspaceValues,
  editable: boolean,
  error: WorkspaceError | undefined,
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

function bundleSnapshot(values: WorkspaceValues, preserveInvalid: boolean): string {
  const bundle: Record<string, unknown> = {
    license: values.bundle.license,
    compatibility: values.bundle.compatibility,
    metadata: values.bundle.metadata,
    references: values.bundle.references.map((reference) => ({
      path: reference.path,
      content: reference.content,
    })),
  };
  if (values.bundle.metadataRaw !== null) {
    bundle.metadataRaw = values.bundle.metadataRaw;
  }
  if (preserveInvalid) {
    bundle.preserveInvalid = true;
  }
  return JSON.stringify(bundle);
}

function editBar(editable: boolean, mode: "update" | "create"): string {
  if (!editable) {
    return "";
  }
  const label = mode === "create" ? "Create skill" : "Save changes";
  return `<div class="skill-editbar" data-skill-editbar>
    <p class="hint" data-skill-status role="status">All changes saved</p>
    <button class="btn btn-primary" type="submit" name="action" value="${mode === "create" ? "create" : "update"}" data-skill-save>${label}</button>
    <button class="btn btn-ghost" type="submit" name="action" value="discard" formnovalidate data-skill-discard>Discard${mode === "create" ? "" : " changes"}</button>
  </div>`;
}

function dangerZone(
  row: SkillRow,
  returnTo: string,
  editable: boolean,
  error: WorkspaceError | undefined,
): string {
  if (!editable) {
    return "";
  }
  const invalidName = row.storedIssues.some((issue) => issue.code === "invalid_skill_name");
  const isTombstone = !row.enabled && !invalidName;
  const label = invalidName
    ? "Delete and re-create"
    : isTombstone
      ? "Revert to inherited"
      : "Delete skill";
  const explanation = invalidName
    ? "The stored name is invalid, so this row cannot be repaired in place. Delete it and create a skill with a valid name."
    : isTombstone
      ? "Reverting deletes this tombstone so the wider skill becomes effective again."
      : row.scope === "global"
        ? "Delete this skill permanently. This cannot be undone."
        : "Delete this row. A wider skill with the same name becomes effective here.";
  const mismatch = error?.field === "confirm_name" ? error.message : undefined;
  return `<section class="card skill-danger" data-skill-danger>
    <div class="card__head"><h2 class="card__title">Danger zone</h2></div>
    <div class="card__body stack">
      <p class="small">${escapeHtml(explanation)}</p>
      <form method="post" action="/api/skills/${row.id}/delete" data-skill-delete-form>
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
        <div class="field">
          <label class="label" for="skill-confirm-name">Type the exact skill name to confirm</label>
          <input class="input mono" id="skill-confirm-name" type="text" name="confirm_name" required autocomplete="off" spellcheck="false"${mismatch === undefined ? "" : ' aria-describedby="skill-confirm-name-error"'} />
          ${fieldError("skill-confirm-name", mismatch)}
        </div>
        <button class="btn btn-danger" type="submit">${icon("trash")}${escapeHtml(label)}</button>
      </form>
    </div>
  </section>`;
}

function renderWorkspacePage(options: {
  site: SiteModel;
  chrome: PageChrome;
  row: SkillRow;
  state: WorkspaceState;
  values: WorkspaceValues;
  error?: WorkspaceError;
  create?: boolean;
  conflictId?: number;
}): string {
  const { row, state, values, site } = options;
  const editable = options.create || state.editable;
  const contextPage = skillsPagePath(state.contextScope, state.contextTarget);
  const returnTo = options.create ? contextPage : contextPage;
  const formValues = bundleSnapshot(values, !options.create && row.storedIssues.length > 0);
  const project =
    state.contextTarget.projectId === undefined
      ? undefined
      : site.projects.find((entry) => entry.id === state.contextTarget.projectId);
  const title = options.create ? "New skill" : row.name;
  const overline = options.create
    ? `${scopeLabel(state.contextScope).toUpperCase()} SKILL`
    : `${scopeLabel(row.scope).toUpperCase()} SKILL`;
  const description = options.create
    ? "Create a reusable procedure for agents to load at start. Details, the body, and references save as one bundle."
    : row.description;
  const meta: string[] = [];
  if (values.bundle.license !== null) {
    meta.push(values.bundle.license);
  }
  if (values.bundle.compatibility !== null) {
    meta.push(values.bundle.compatibility);
  }
  if (values.bundle.metadata.version !== undefined) {
    meta.push(`v${values.bundle.metadata.version}`);
  }
  if (!options.create) {
    meta.push(`Updated ${absoluteTime(row.updatedAt)}`);
  }
  meta.push(`${values.bundle.references.length} references`);
  const warnings = options.create
    ? []
    : warningsFor(options.state.resolved.warnings, row.name, [
        "skill_collision",
        "skill_disabled_elsewhere",
      ]);
  const header = pageHeader({
    overline,
    title,
    description,
    meta,
    actions: options.create
      ? `<a class="btn btn-ghost" href="${escapeHtml(contextPage)}">Back to skills</a>`
      : workspaceActions(state, row, contextPage),
  });
  const conflict =
    options.conflictId === undefined
      ? ""
      : `<p class="field-error" role="alert" data-skill-conflict>This name already exists at this scope. <a href="/skills/${options.conflictId}?from=${encodeURIComponent(contextPage)}">Open the existing skill</a>.</p>`;
  const errorSummaryHtml = options.error === undefined ? "" : errorSummary(options.error);
  const workspace = editable
    ? `<div class="stack skill-edit-workspace" data-skill-edit-workspace>
        <form class="stack skill-bundle-form" method="post" action="${options.create ? "/api/skills" : `/api/skills/${row.id}`}" data-skill-form data-skill-mode="${options.create ? "create" : "update"}" data-skill-name="${escapeHtml(row.name)}">
          ${options.create ? hiddenTargetFields(state.contextScope, state.contextTarget, returnTo) : `<input type="hidden" name="return_to" value="${escapeHtml(workspacePath(row))}" />`}
          <input type="hidden" name="bundle" value="${escapeHtml(formValues)}" data-skill-bundle />
          ${editBar(true, options.create ? "create" : "update")}
          ${
            options.create
              ? `<div class="field">
                <label class="label" for="skill-name">Name</label>
                <input class="input mono" id="skill-name" name="name" type="text" value="${escapeHtml(values.name ?? "")}" required maxlength="${SKILL_LIMITS.name}" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off" spellcheck="false" placeholder="release-checklist"${fieldDescribedBy("skill-name-hint", options.error?.field === "name" ? "skill-name-error" : undefined)} />
                ${fieldError("skill-name", options.error?.field === "name" ? options.error.message : undefined)}
                ${fieldHint("skill-name-hint", "Lowercase letters, digits, and single hyphens.")}
              </div>`
              : ""
          }
          ${errorSummaryHtml}
          ${conflict}
          ${detailsCard(values, row, true, options.error, !options.create)}
          ${sourceWorkspace(values, true, options.error)}
        </form>
        ${dangerZone(row, contextPage, !options.create, options.error)}
      </div>`
    : `<div class="stack skill-readonly-workspace" data-skill-readonly-workspace>
        <div class="stack skill-readonly" data-skill-readonly data-skill-name="${escapeHtml(row.name)}">
          ${detailsCard(values, row, false, options.error, true)}
          ${sourceWorkspace(values, false, options.error)}
        </div>
        ${state.name === "invalid-owned-name" ? dangerZone(row, contextPage, true, options.error) : ""}
      </div>`;
  const issues =
    !options.create && row.storedIssues.length > 0
      ? issueList(row.storedIssues, state.editable)
      : "";
  const collisions =
    warnings.length === 0
      ? ""
      : `<section class="settings-warning" role="alert" data-skill-collisions>${warningList(warnings)}</section>`;
  const restart = options.create ? "" : restartBanner(state, site, row);
  const stateBadgeHtml = options.create
    ? '<span class="badge badge-info">Draft</span>'
    : `<span class="badge skill-state ${state.name === "editable" || state.name === "inherited" ? "badge-success" : state.name === "tombstone" || state.name === "not-effective" || state.name === "shadowed" || state.name === "hidden" ? "badge-warning" : "badge-error"}" data-skill-state>${escapeHtml(stateLabelFor(state.name))}</span>`;
  const body = `${options.create ? "" : scopeStrip(state, row)}
    <div class="cluster section">${stateBadgeHtml}<a class="small" href="${escapeHtml(contextPage)}">Back to skills</a></div>
    ${restart}
    ${collisions}
    ${issues}
    ${workspace}`;
  return appShell({
    title: options.create ? "New skill" : row.name,
    active: "skills",
    activeProjectId: project?.id,
    breadcrumb: options.create
      ? [
          ...(state.contextScope === "global"
            ? [
                { label: "Workbench", href: "/" },
                { label: "Skills", href: contextPage },
              ]
            : scopeBreadcrumb(site, state, { ...row, name: "Skills" })),
          { label: "New skill" },
        ]
      : scopeBreadcrumb(site, state, row),
    projects: navProjects(site),
    pendingCount: site.pendingCount,
    operatorName: options.chrome.operatorName,
    notice: options.chrome.notice,
    header,
    body,
    moduleScripts: ["/assets/skill-detail.js"],
    skillsHref: contextPage,
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
          const context = { scope: row.scope, target: rowTarget(row) };
          return html(
            422,
            renderWorkspacePage({
              site,
              chrome: pageChrome(actor, request),
              row,
              state: workspaceState(skills, row, context),
              values: {
                description: row.description,
                content: row.content,
                enabled: row.enabled,
                bundle: bundleFromRow(row),
              },
              error: { message: error.message, field: error.field },
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
              const context = { scope: row.scope, target: rowTarget(row) };
              return html(
                422,
                renderWorkspacePage({
                  site,
                  chrome: pageChrome(actor, request),
                  row,
                  state: workspaceState(skills, row, context),
                  values: {
                    description: row.description,
                    content: row.content,
                    enabled: row.enabled,
                    bundle: bundleFromRow(row),
                  },
                  error: { message: error.message, field: error.field },
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
            const context = { scope: row.scope, target: rowTarget(row) };
            return html(
              422,
              renderWorkspacePage({
                site,
                chrome: pageChrome(actor, request),
                row,
                state: workspaceState(skills, row, context),
                values: values ?? {
                  description: row.description,
                  content: row.content,
                  enabled: row.enabled,
                  bundle: bundleFromRow(row),
                },
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
      const context = viewContext(deps, request.query?.from, row);
      const state = workspaceState(skills, row, context);
      return html(
        200,
        renderWorkspacePage({
          site,
          chrome: pageChrome(actor, request),
          row,
          state,
          values: {
            description: row.description,
            content: row.content,
            enabled: row.enabled,
            bundle: bundleFromRow(row),
          },
        }),
      );
    }

    const page = skillsPageFor(request.path);
    if (page === undefined || request.method !== "GET") {
      return notFound(browser);
    }
    const site = buildSite(deps);
    const entities = pageEntities(site, page.scope, page.target);
    if (entities === undefined) {
      return html(404, renderNotFound(site, pageChrome(actor, request)));
    }
    const model = surfaceModel(
      deps,
      skills,
      page.scope,
      page.target,
      skillsPagePath(page.scope, page.target),
    );
    return html(
      200,
      renderInventoryPage({
        site,
        chrome: pageChrome(actor, request),
        model,
        ...(entities.project === undefined ? {} : { project: entities.project }),
        ...(entities.app === undefined ? {} : { app: entities.app }),
        filter: parseInventoryFilter(request.query?.filter),
        search: (request.query?.q ?? "").trim(),
      }),
    );
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

function emptyRow(scope: SkillScope, target: SkillTarget): SkillRow {
  const timestamp = new Date(0).toISOString();
  return {
    id: 0,
    scope,
    projectId: target.projectId ?? "",
    appKey: target.appKey ?? "",
    name: "",
    description: "",
    content: "",
    enabled: true,
    license: null,
    compatibility: null,
    metadata: {},
    references: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    updatedBy: null,
    storedIssues: [],
    metadataRaw: null,
  };
}

function createState(scope: SkillScope, target: SkillTarget): WorkspaceState {
  return {
    name: "editable",
    contextScope: scope,
    contextTarget: target,
    resolved: { scope, effective: [], rows: [], disabled: [], warnings: [] },
    editable: true,
  };
}

function renderCreatePage(options: CreatePageOptions & { values?: WorkspaceValues }): string {
  const values = options.values ?? {
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
  };
  const row = emptyRow(options.scope, options.target);
  return renderWorkspacePage({
    site: options.site,
    chrome: options.chrome,
    row,
    state: createState(options.scope, options.target),
    values,
    ...(options.error === undefined ? {} : { error: options.error }),
    create: true,
  });
}

function renderCreateConflictPage(
  options: CreatePageOptions & { values: WorkspaceValues; existingId?: number },
): string {
  const row = emptyRow(options.scope, options.target);
  return renderWorkspacePage({
    site: options.site,
    chrome: options.chrome,
    row,
    state: createState(options.scope, options.target),
    values: options.values,
    error: { message: "A skill with this name already exists at this scope.", field: "name" },
    create: true,
    ...(options.existingId === undefined ? {} : { conflictId: options.existingId }),
  });
}
