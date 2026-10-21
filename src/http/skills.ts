import path from "node:path";
import { resolveInstanceEnv } from "../opencode/instance.js";
import type { RegisteredApp } from "../registry/index.js";
import {
  type EffectiveSkill,
  type ResolvedSkills,
  type SkillApplyOptions,
  SkillConflictError,
  type SkillPreview,
  type SkillRow,
  type SkillScope,
  SkillService,
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

/* ------------------------------------------------------------------------- */
/* Response primitives                                                        */
/* ------------------------------------------------------------------------- */

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { ...JSON_HEADERS },
  };
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

function wantsFragment(request: HttpRequest): boolean {
  return (request.headers["x-hanse-fragment"] ?? "").trim().toLowerCase() === "skills";
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

function rowPagePath(row: SkillRow): string {
  return skillsPagePath(row.scope, {
    ...(row.scope === "global" ? {} : { projectId: row.projectId }),
    ...(row.scope === "app" ? { appKey: row.appKey } : {}),
  });
}

function sourcePagePath(model: SurfaceModel, source: SkillScope): string {
  return skillsPagePath(source, model.target);
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
  switch (warning.code) {
    case "skill_collision":
      return `"${warning.name ?? ""}" also exists at ${warning.root ?? "another skill root"}`;
    case "skill_disabled_elsewhere":
      return `"${warning.name ?? ""}" is disabled here but also exists at ${warning.root ?? "another skill root"}`;
    case "invalid_skill_name":
      return `Skill #${warning.id ?? "?"} has an invalid stored name and is ignored`;
  }
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
/* Surface rendering                                                          */
/* ------------------------------------------------------------------------- */

function scopeBadge(scope: SkillScope): string {
  return `<span class="badge">${escapeHtml(scopeLabel(scope))}</span>`;
}

function shadowsNote(skill: EffectiveSkill): string {
  if (skill.shadows.length === 0) {
    return "";
  }
  return `<p class="hint">Overrides ${escapeHtml(skill.shadows.map(scopeLabel).join(", "))}.</p>`;
}

function hiddenTargetFields(model: SurfaceModel): string {
  const fields = [
    `<input type="hidden" name="scope" value="${escapeHtml(model.scope)}" />`,
    `<input type="hidden" name="return_to" value="${escapeHtml(model.returnTo)}" />`,
  ];
  if (model.scope !== "global") {
    fields.push(
      `<input type="hidden" name="project" value="${escapeHtml(model.target.projectId ?? "")}" />`,
    );
  }
  if (model.scope === "app") {
    fields.push(
      `<input type="hidden" name="app" value="${escapeHtml(model.target.appKey ?? "")}" />`,
    );
  }
  return fields.join("");
}

function errorSlot(): string {
  return '<p class="field-error" data-skill-error role="alert" hidden></p>';
}

function effectiveActions(model: SurfaceModel, skill: EffectiveSkill): string {
  if (skill.source === model.scope) {
    return `<div class="cluster">
      <a class="btn btn-secondary min-h-11" href="#skill-${skill.id}">Edit here</a>
      <form method="post" action="/api/skills/${skill.id}" data-skill-form data-no-busy>
        <input type="hidden" name="action" value="update" />
        <input type="hidden" name="enabled" value="0" />
        <input type="hidden" name="return_to" value="${escapeHtml(model.returnTo)}" />
        ${errorSlot()}
        <button class="btn btn-secondary min-h-11" type="submit">Disable here</button>
      </form>
    </div>`;
  }
  return `<div class="cluster">
    <form method="post" action="/api/skills" data-skill-form data-no-busy data-success-notice="Skill overridden here.">
      <input type="hidden" name="action" value="override" />
      <input type="hidden" name="from_id" value="${skill.id}" />
      <input type="hidden" name="enabled" value="1" />
      ${hiddenTargetFields(model)}
      ${errorSlot()}
      <button class="btn btn-secondary min-h-11" type="submit">Override here</button>
    </form>
    <form method="post" action="/api/skills" data-skill-form data-no-busy data-success-notice="Skill disabled here.">
      <input type="hidden" name="action" value="override" />
      <input type="hidden" name="from_id" value="${skill.id}" />
      <input type="hidden" name="enabled" value="0" />
      ${hiddenTargetFields(model)}
      ${errorSlot()}
      <button class="btn btn-secondary min-h-11" type="submit">Disable here</button>
    </form>
    <a class="btn btn-ghost min-h-11" href="${escapeHtml(sourcePagePath(model, skill.source))}">Open at source</a>
  </div>`;
}

function effectiveRows(model: SurfaceModel, warnings: readonly SkillWarning[]): string {
  if (model.resolved.effective.length === 0) {
    return emptyState({
      iconName: "code",
      title: "No effective skills",
      body: "Skills are reusable procedures agents load at start. Create the first skill at this scope.",
      action: `<button class="btn btn-primary btn-sm" type="button" data-dialog-open="skill-new-dialog">${icon("plus")}Create the first skill</button>`,
    });
  }
  return model.resolved.effective
    .map((skill) => {
      const collisions = warningsFor(warnings, skill.name, [
        "skill_collision",
        "skill_disabled_elsewhere",
      ]);
      const owned = skill.source === model.scope;
      return `<div class="setting-row" id="effective-skill-${skill.id}" data-skill-name="${escapeHtml(skill.name)}">
        <div class="setting-row__body">
          <div class="cluster">
            <strong class="mono">${escapeHtml(skill.name)}</strong>
            ${scopeBadge(skill.source)}
            ${owned ? '<span class="badge badge-success">Enabled here</span>' : '<span class="badge badge-ghost">Inherited</span>'}
          </div>
          <p class="small">${escapeHtml(skill.description)}</p>
          ${shadowsNote(skill)}
          ${warningList(collisions)}
          ${effectiveActions(model, skill)}
        </div>
      </div>`;
    })
    .join("");
}

function counter(id: string, max: number, value: number): string {
  return `<span class="mono" id="${escapeHtml(id)}-counter" data-skill-counter-output>${value} / ${max}</span>`;
}

function editorForm(row: SkillRow, returnTo: string): string {
  return `<form class="setting-row__form" method="post" action="/api/skills/${row.id}" data-skill-form data-no-busy data-success-notice="Skill saved.">
    <input type="hidden" name="action" value="update" />
    <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
    ${errorSlot()}
    <div class="field">
      <div class="cluster"><label class="label" for="skill-${row.id}-description">Description</label>${counter(`skill-${row.id}-description`, 1024, row.description.length)}</div>
      <input class="input" id="skill-${row.id}-description" name="description" type="text" value="${escapeHtml(row.description)}" maxlength="1024" required data-skill-counter="1024" autocomplete="off" />
    </div>
    <div class="field">
      <div class="cluster"><label class="label" for="skill-${row.id}-content">Markdown body</label>${counter(`skill-${row.id}-content`, 48000, row.content.length)}</div>
      <textarea class="textarea font-mono" id="skill-${row.id}-content" name="content" rows="10" maxlength="48000" required spellcheck="false" data-skill-counter="48000">${escapeHtml(row.content)}</textarea>
    </div>
    <label class="check">
      <input type="hidden" name="enabled" value="0" />
      <input class="checkbox" type="checkbox" name="enabled" value="1"${row.enabled ? " checked" : ""} />
      <span>Enabled</span>
    </label>
    <div class="setting-row__actions">
      <button class="btn btn-primary btn-sm min-h-11" type="submit">Save</button>
      <button class="btn btn-ghost btn-sm min-h-11" type="button" data-skill-cancel>Cancel</button>
      <noscript><button class="btn btn-danger btn-sm min-h-11" type="submit" formaction="/api/skills/${row.id}/delete" formnovalidate>Delete</button></noscript>
    </div>
  </form>`;
}

function toggleForm(row: SkillRow, returnTo: string): string {
  return `<form method="post" action="/api/skills/${row.id}" data-skill-form data-no-busy data-success-notice="${row.enabled ? "Skill disabled here." : "Skill enabled here."}">
    <input type="hidden" name="action" value="update" />
    <input type="hidden" name="enabled" value="${row.enabled ? "0" : "1"}" />
    <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
    ${errorSlot()}
    <button class="btn btn-secondary min-h-11" type="submit">${row.enabled ? "Disable here" : "Enable here"}</button>
  </form>`;
}

function definedRows(model: SurfaceModel): string {
  if (model.resolved.rows.length === 0) {
    return `<p class="hint">No skills are defined at this scope. Inherited skills still resolve from wider scopes.</p>`;
  }
  return model.resolved.rows
    .map((row) => {
      return `<details class="setting-row" id="skill-${row.id}" data-skill-name="${escapeHtml(row.name)}">
        <summary class="setting-row__summary">
          <span class="setting-row__title"><strong class="mono">${escapeHtml(row.name)}</strong></span>
          <span class="setting-row__effective"><span class="small">${escapeHtml(row.description)}</span></span>
          <span class="setting-row__state">${row.enabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Disabled here</span>'}</span>
          <span class="setting-row__chevron">${icon("chevron-down")}</span>
        </summary>
        <div class="setting-row__body">
          ${row.enabled ? "" : '<p class="hint">This tombstone hides the inherited skill. Enable it to restore the inherited body, or delete it to fall back.</p>'}
          <div class="cluster">
            ${toggleForm(row, model.returnTo)}
            <button class="btn btn-danger min-h-11" type="button" data-skill-delete data-skill-id="${row.id}" data-skill-name="${escapeHtml(row.name)}" data-return-to="${escapeHtml(model.returnTo)}">${icon("trash")}Delete</button>
          </div>
          <p class="hint">Updated ${escapeHtml(absoluteTime(row.updatedAt))}${row.updatedBy === null ? "" : ` by ${escapeHtml(row.updatedBy)}`}.</p>
          ${editorForm(row, model.returnTo)}
        </div>
      </details>`;
    })
    .join("");
}

function disabledRows(model: SurfaceModel, warnings: readonly SkillWarning[]): string {
  if (model.resolved.disabled.length === 0) {
    return `<p class="hint">No inherited skills are disabled here.</p>`;
  }
  return model.resolved.disabled
    .map((entry) => {
      const collisions = warningsFor(warnings, entry.name, ["skill_disabled_elsewhere"]);
      const source =
        entry.source === null ? "an inherited skill" : `the ${scopeLabel(entry.source)} skill`;
      return `<div class="setting-row" id="disabled-skill-${entry.id}" data-skill-name="${escapeHtml(entry.name)}">
        <div class="setting-row__body">
          <div class="cluster">
            <strong class="mono">${escapeHtml(entry.name)}</strong>
            <span class="badge badge-warning">Disabled here</span>
            <span class="hint">Hides ${escapeHtml(source)}.</span>
          </div>
          ${warningList(collisions)}
          <div class="cluster">
            <form method="post" action="/api/skills/${entry.id}" data-skill-form data-no-busy data-success-notice="Skill enabled here.">
              <input type="hidden" name="action" value="update" />
              <input type="hidden" name="enabled" value="1" />
              <input type="hidden" name="return_to" value="${escapeHtml(model.returnTo)}" />
              ${errorSlot()}
              <button class="btn btn-secondary min-h-11" type="submit">Enable here</button>
            </form>
            <form method="post" action="/api/skills/${entry.id}/delete" data-skill-form data-no-busy data-success-notice="Skill reverted to inherited.">
              <input type="hidden" name="return_to" value="${escapeHtml(model.returnTo)}" />
              ${errorSlot()}
              <button class="btn btn-secondary min-h-11" type="submit">Revert to inherited</button>
            </form>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

function renderSurface(model: SurfaceModel, site: SiteModel): string {
  const warnings = model.preview?.warnings ?? model.resolved.warnings;
  const invalid = model.resolved.warnings.filter(
    (warning) => warning.code === "invalid_skill_name",
  );
  const truncated =
    model.preview?.truncated === undefined
      ? ""
      : `<p class="hint">${model.preview.truncated} more collision warnings omitted.</p>`;
  return `<div id="skills-surface">
    <div class="workbench-grid section">
      <div class="stack">
    ${invalid.length === 0 ? "" : `<div class="settings-warning" role="alert">${warningList(invalid)}</div>`}
    <div class="settings-sections">
      <section class="card settings-section" id="skills-effective" aria-labelledby="skills-effective-title">
        <div class="card__head">
          <h2 class="card__title" id="skills-effective-title">Effective here</h2>
          <span class="badge">${model.resolved.effective.length}</span>
        </div>
        <div class="card__body${model.resolved.effective.length === 0 ? "" : " card__body--flush"}">
          <p class="hint">Hanse-effective at this scope. Repository and plugin skills are outside this hierarchy.</p>
          ${effectiveRows(model, warnings)}
        </div>
      </section>
      <section class="card settings-section" id="skills-defined" aria-labelledby="skills-defined-title">
        <div class="card__head">
          <h2 class="card__title" id="skills-defined-title">Defined at this scope</h2>
          <span class="badge">${model.resolved.rows.length}</span>
        </div>
        <div class="card__body${model.resolved.rows.length === 0 ? "" : " card__body--flush"}">
          ${definedRows(model)}
        </div>
      </section>
      <section class="card settings-section" id="skills-disabled" aria-labelledby="skills-disabled-title">
        <div class="card__head">
          <h2 class="card__title" id="skills-disabled-title">Disabled at this scope</h2>
          <span class="badge">${model.resolved.disabled.length}</span>
        </div>
        <div class="card__body">
          ${disabledRows(model, warnings)}
        </div>
      </section>
      ${truncated}
    </div>
      </div>
      ${rail(model, site)}
    </div>
  </div>`;
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
    <div class="cluster">
      <p class="nav-label">On this page</p>
      <div class="cluster" role="group" aria-label="Skills sections">
        <a class="btn btn-secondary min-h-11" href="#skills-effective">Effective</a>
        <a class="btn btn-secondary min-h-11" href="#skills-defined">Defined</a>
        <a class="btn btn-secondary min-h-11" href="#skills-disabled">Disabled</a>
      </div>
    </div>
  </nav>`;
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

function rail(model: SurfaceModel, site: SiteModel): string {
  const effective = model.resolved.effective.length;
  const defined = model.resolved.rows.length;
  const pending = pendingApps(site, model.scope, model.target);
  const hierarchyNote =
    model.scope === "app"
      ? "Repository and plugin skills on this application are scanned for collisions. opencode may still load a same-named skill from those roots; Hanse does not override them."
      : "Repository and plugin skills are outside this hierarchy and may shadow a same-named managed skill. Open an application's Skills page for collision details.";
  const collisionWarnings = (model.preview?.warnings ?? []).filter(
    (warning) => warning.code !== "invalid_skill_name",
  );
  const collisionSection =
    collisionWarnings.length === 0 && model.preview?.truncated === undefined
      ? ""
      : `<section class="card" aria-labelledby="skills-collisions-title">
          <div class="card__head">
            <h2 class="card__title" id="skills-collisions-title">Skill root warnings</h2>
            <span class="badge">${collisionWarnings.length}</span>
          </div>
          <div class="card__body stack--tight">
            ${warningList(collisionWarnings)}
            ${model.preview?.truncated === undefined ? "" : `<p class="hint">${model.preview.truncated} more collision warnings omitted.</p>`}
          </div>
        </section>`;
  const pendingSection =
    pending.length === 0
      ? ""
      : `<section class="card" aria-labelledby="skills-restart-title">
          <div class="card__head">
            <h2 class="card__title" id="skills-restart-title">Restart required</h2>
            <span class="badge">${pending.length}</span>
          </div>
          <div class="card__body stack--tight">
            <p class="hint">Settings or skills changed. A restart applies the effective set; it is never automatic.</p>
            ${pending
              .map(
                (entry) => `<div class="cluster">
                  <a class="small" href="/projects/${encodeURIComponent(entry.projectId)}/apps/${encodeURIComponent(entry.appKey)}">${escapeHtml(entry.appKey)}</a>
                  <span class="status" data-state="awaiting_approval">${icon("stamp")}Restart required</span>
                  <form method="post" action="/api/apps/${encodeURIComponent(entry.appKey)}/restart?project=${encodeURIComponent(entry.projectId)}">
                    <input type="hidden" name="return_to" value="${escapeHtml(model.returnTo)}" />
                    <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
                  </form>
                </div>`,
              )
              .join("")}
          </div>
        </section>`;
  return `<aside class="rail-stack" aria-label="Skills information">
    <section class="card" aria-labelledby="skills-how-title">
      <div class="card__head"><h2 class="card__title" id="skills-how-title">How it works</h2></div>
      <div class="card__body stack--tight">
        <p class="small">Skills resolve global &rarr; project &rarr; application. The narrowest row wins by name; a disabled row hides wider skills without deleting them.</p>
        <p class="small">Skills are loaded once at agent start. Changes apply only after an explicit restart.</p>
        <p class="hint">${escapeHtml(hierarchyNote)}</p>
      </div>
    </section>
    ${collisionSection}
    <section class="card" aria-labelledby="skills-count-title">
      <div class="card__head"><h2 class="card__title" id="skills-count-title">Summary</h2></div>
      <div class="card__body stack--tight">
        <p class="mono">${effective} effective &middot; ${defined} defined here</p>
        <p class="hint">Counts are Hanse-effective at this scope, not every skill on disk.</p>
      </div>
    </section>
    ${pendingSection}
  </aside>`;
}

/* ------------------------------------------------------------------------- */
/* Dialogs                                                                    */
/* ------------------------------------------------------------------------- */

function newSkillDialog(model: SurfaceModel, context: string): string {
  return `<dialog class="dialog" id="skill-new-dialog" aria-labelledby="skill-new-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <div class="cluster"><h2 class="dialog__title" id="skill-new-title">New skill</h2><button class="btn btn-ghost btn-icon btn-sm" type="button" data-dialog-close aria-label="Close">${icon("x")}</button></div>
        <p class="dialog__meta">${escapeHtml(context || `${scopeLabel(model.scope)} scope`)}</p>
      </header>
      <form class="dialog__form" method="post" action="/api/skills" data-skill-form data-no-busy data-success-notice="Skill created.">
        <input type="hidden" name="action" value="create" />
        ${hiddenTargetFields(model)}
        <div class="dialog__body">
          ${errorSlot()}
          <div class="field">
            <label class="label" for="skill-new-name">Name</label>
            <input class="input" id="skill-new-name" name="name" type="text" required maxlength="64" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off" spellcheck="false" placeholder="release-checklist" />
            <p class="hint">Lowercase letters, digits, and single hyphens.</p>
          </div>
          <div class="field">
            <div class="cluster"><label class="label" for="skill-new-description">Description</label>${counter("skill-new-description", 1024, 0)}</div>
            <input class="input" id="skill-new-description" name="description" type="text" required maxlength="1024" data-skill-counter="1024" autocomplete="off" />
            <p class="hint">What the skill does and when the agent should use it.</p>
          </div>
          <div class="field">
            <div class="cluster"><label class="label" for="skill-new-content">Markdown body</label>${counter("skill-new-content", 48000, 0)}</div>
            <textarea class="textarea font-mono" id="skill-new-content" name="content" rows="12" required maxlength="48000" spellcheck="false" data-skill-counter="48000"></textarea>
          </div>
          <label class="check">
            <input type="hidden" name="enabled" value="0" />
            <input class="checkbox" type="checkbox" name="enabled" value="1" checked />
            <span>Enabled</span>
          </label>
          <div class="cluster">
            <button class="btn btn-secondary btn-sm" type="button" data-skill-example>Insert example</button>
          </div>
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-primary" type="submit">Create skill</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function deleteDialog(model: SurfaceModel): string {
  return `<dialog class="dialog" id="skill-delete-dialog" aria-labelledby="skill-delete-title">
    <div class="dialog__frame">
      <form class="dialog__form" method="post" action="/api/skills" data-skill-form data-skill-delete-form data-no-busy data-success-notice="Skill deleted.">
        <input type="hidden" name="return_to" value="${escapeHtml(model.returnTo)}" />
        <div class="dialog__head">
          <h2 class="dialog__title" id="skill-delete-title">Delete skill?</h2>
          <p class="dialog__meta" data-skill-delete-name></p>
        </div>
        <div class="dialog__body">
          <p>Delete &ldquo;<span data-skill-delete-name></span>&rdquo;? This cannot be undone.</p>
          <p class="hint">Deleting a tombstone falls back to the inherited skill. Deleting an enabled row removes it from this scope.</p>
          ${errorSlot()}
        </div>
        <div class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-danger" type="submit">Delete skill</button>
        </div>
      </form>
    </div>
  </dialog>`;
}

function noScriptCreate(model: SurfaceModel): string {
  return `<noscript>
    <details class="setting-row" id="skill-create-fallback">
      <summary class="setting-row__summary">
        <span class="setting-row__title"><strong class="mono">Create a skill (JavaScript disabled)</strong></span>
        <span class="setting-row__effective"><span class="small">Submit this form to create a skill at this scope.</span></span>
        <span class="setting-row__chevron">${icon("chevron-down")}</span>
      </summary>
      <div class="setting-row__body">
        <form class="setting-row__form" method="post" action="/api/skills">
          <input type="hidden" name="action" value="create" />
          ${hiddenTargetFields(model)}
          <div class="field">
            <label class="label" for="skill-fallback-name">Name</label>
            <input class="input" id="skill-fallback-name" name="name" type="text" required maxlength="64" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off" />
          </div>
          <div class="field">
            <label class="label" for="skill-fallback-description">Description</label>
            <input class="input" id="skill-fallback-description" name="description" type="text" required maxlength="1024" autocomplete="off" />
          </div>
          <div class="field">
            <label class="label" for="skill-fallback-content">Markdown body</label>
            <textarea class="textarea font-mono" id="skill-fallback-content" name="content" rows="10" required maxlength="48000" spellcheck="false"></textarea>
          </div>
          <label class="check">
            <input type="hidden" name="enabled" value="0" />
            <input class="checkbox" type="checkbox" name="enabled" value="1" checked />
            <span>Enabled</span>
          </label>
          <div class="setting-row__actions">
            <button class="btn btn-primary min-h-11" type="submit">Create skill</button>
          </div>
        </form>
      </div>
    </details>
  </noscript>`;
}

/* ------------------------------------------------------------------------- */
/* Page                                                                       */
/* ------------------------------------------------------------------------- */

function renderSkillsPage(options: {
  site: SiteModel;
  chrome: PageChrome;
  model: SurfaceModel;
  project?: ProjectView;
  app?: RegisteredApp;
}): string {
  const { model } = options;
  const project = options.project;
  const app = options.app;
  const title = "Skills";
  const contextLabel =
    model.scope === "global"
      ? "Global scope"
      : model.scope === "project"
        ? `Project ${project?.name ?? ""}`.trim()
        : `${project?.name ?? ""} / ${app?.appKey ?? ""}`.replace(/^ \/ | \/ $/g, "").trim();
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
    title,
    description,
    meta: [
      ...(model.scope === "global" ? [] : [project?.name ?? ""]),
      ...(model.scope === "app" ? [app?.appKey ?? ""] : []),
    ].filter((entry) => entry.length > 0),
    actions: `<button class="btn btn-primary" type="button" data-dialog-open="skill-new-dialog">${icon("plus")}New skill</button>`,
  });
  const body = `${scopeNav(model.scope, model.target)}
    ${renderSurface(model, options.site)}
    <noscript><p class="hint">JavaScript is off. Use “Create a skill (JavaScript disabled)” below the cards; edits and toggles still submit as normal forms.</p></noscript>
    ${newSkillDialog(model, contextLabel)}
    ${deleteDialog(model)}
    ${noScriptCreate(model)}`;
  return appShell({
    title,
    active: "skills",
    activeProjectId: project?.id,
    breadcrumb,
    projects: navProjects(options.site),
    pendingCount: options.site.pendingCount,
    operatorName: options.chrome.operatorName,
    notice: options.chrome.notice,
    header,
    body,
    scripts: ["/assets/skills.js"],
    skillsHref: skillsPagePath(model.scope, model.target),
  });
}

/* ------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* ------------------------------------------------------------------------- */

function mutationError(
  error: unknown,
  browser: boolean,
  returnTo: string,
): HttpResponse | undefined {
  if (error instanceof SkillConflictError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return json(409, { error: error.message, code: "skill_exists" });
  }
  if (error instanceof SkillValidationError) {
    if (error.message === "invalid_override_source") {
      if (browser) {
        return redirectNotice(returnTo, "invalid_override_source", "error");
      }
      return json(400, { error: "invalid_override_source", code: "invalid_override_source" });
    }
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return json(400, { error: error.message });
  }
  if (error instanceof SkillsTargetError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return json(400, { error: error.message, code: "invalid_scope_target" });
  }
  if (error instanceof SkillsOverrideError) {
    if (browser) {
      return redirectNotice(returnTo, "invalid_override_source", "error");
    }
    return json(400, { error: "invalid_override_source", code: "invalid_override_source" });
  }
  if (error instanceof SkillsBodyError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return json(400, { error: error.message });
  }
  return undefined;
}

function pathnameOf(value: string): string {
  const hashIndex = value.indexOf("#");
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutHash.indexOf("?");
  return queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
}

function mutationResponse(options: {
  deps: HttpDeps;
  skills: SkillService;
  scope: SkillScope;
  target: SkillTarget;
  returnTo: string;
  fragment: boolean;
  browser: boolean;
  message: string;
  payload: unknown;
}): HttpResponse {
  if (options.fragment) {
    const page = skillsPageFor(pathnameOf(options.returnTo));
    const usePage =
      page !== undefined && targetExists(options.deps, page.scope, page.target) ? page : undefined;
    const model = surfaceModel(
      options.deps,
      options.skills,
      usePage?.scope ?? options.scope,
      usePage?.target ?? options.target,
      options.returnTo,
    );
    return json(200, {
      ok: true,
      surface: renderSurface(model, buildSite(options.deps)),
      counts: {
        effective: model.resolved.effective.length,
        defined: model.resolved.rows.length,
      },
    });
  }
  if (options.browser) {
    return redirectNotice(options.returnTo, options.message, "success");
  }
  return json(200, options.payload);
}

/* ------------------------------------------------------------------------- */
/* Dispatch                                                                  */
/* ------------------------------------------------------------------------- */

export function isSkillsRoute(method: string, pathname: string): boolean {
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
    return json(503, { error: "skills are not available", code: "skills_unavailable" });
  }

  const fragment = wantsFragment(request);
  const browser = wantsHtml(request) && !fragment;
  const mutation = request.method === "POST" || request.method === "DELETE";

  if (mutation && !originAllowed(request)) {
    return json(403, { error: "cross-site request rejected", code: "cross_origin" });
  }

  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return browser
      ? redirect(`/login?next=${encodeURIComponent(requestPath(request))}`)
      : json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may manage skills", code: "human_only" });
  }
  const actor = principal.name;

  try {
    if (request.path === "/api/skills" && request.method === "GET") {
      const { scope, target } = targetFromQuery(request.query ?? {});
      if (!targetExists(deps, scope, target)) {
        return json(404, { error: "not found" });
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
      try {
        const payload = parseObjectBody(request);
        const { scope, target } = parseExplicitTarget(payload);
        returnTo = safeSkillReturn(stringValue(payload.return_to), skillsPagePath(scope, target));
        if (!targetExists(deps, scope, target)) {
          return json(404, { error: "not found" });
        }
        const action = stringValue(payload.action) ?? "";
        let skill: SkillRow;
        let message: string;
        if (action === "create") {
          const enabled = enabledFrom(payload.enabled);
          skill = skills.create(
            scope,
            target,
            {
              name: stringValue(payload.name),
              description: stringValue(payload.description) ?? "",
              content: stringValue(payload.content) ?? "",
              ...(enabled === undefined ? {} : { enabled }),
            },
            actor,
          );
          message = "Skill created.";
        } else if (action === "override") {
          const fromId = parseId(payload.from_id);
          if (fromId === undefined) {
            throw new SkillsOverrideError();
          }
          const enabled = enabledFrom(payload.enabled);
          skill = skills.override(fromId, scope, target, enabled, actor);
          message = enabled === false ? "Skill disabled here." : "Skill overridden here.";
        } else {
          throw new SkillsBodyError("action must be create or override");
        }
        return mutationResponse({
          deps,
          skills,
          scope,
          target,
          returnTo,
          fragment,
          browser,
          message,
          payload: { skill },
        });
      } catch (error) {
        const mapped = mutationError(error, browser, returnTo);
        if (mapped !== undefined) {
          return mapped;
        }
        throw error;
      }
    }

    const deleteMatch = /^\/api\/skills\/([^/]+)\/delete$/.exec(request.path);
    if (deleteMatch !== null && request.method === "POST") {
      const id = parseId(safeDecode(deleteMatch[1] ?? ""));
      const row = id === undefined ? undefined : skills.get(id);
      if (id === undefined || row === undefined) {
        return json(404, { error: "not found" });
      }
      let returnTo = rowPagePath(row);
      try {
        const payload = parseObjectBody(request);
        returnTo = safeSkillReturn(stringValue(payload.return_to), returnTo);
        skills.delete(id);
        return mutationResponse({
          deps,
          skills,
          scope: row.scope,
          target: {
            ...(row.scope === "global" ? {} : { projectId: row.projectId }),
            ...(row.scope === "app" ? { appKey: row.appKey } : {}),
          },
          returnTo,
          fragment,
          browser,
          message: "Skill deleted.",
          payload: { deleted: true },
        });
      } catch (error) {
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
        return json(404, { error: "not found" });
      }
      if (request.method === "GET") {
        return json(200, { skill: row });
      }
      if (request.method === "DELETE") {
        skills.delete(id);
        return json(200, { deleted: true });
      }
      if (request.method === "POST") {
        let returnTo = rowPagePath(row);
        try {
          const payload = parseObjectBody(request);
          returnTo = safeSkillReturn(stringValue(payload.return_to), returnTo);
          const action = stringValue(payload.action) ?? "update";
          if (action === "delete") {
            skills.delete(id);
            return mutationResponse({
              deps,
              skills,
              scope: row.scope,
              target: {
                ...(row.scope === "global" ? {} : { projectId: row.projectId }),
                ...(row.scope === "app" ? { appKey: row.appKey } : {}),
              },
              returnTo,
              fragment,
              browser,
              message: "Skill deleted.",
              payload: { deleted: true },
            });
          }
          if (action !== "update") {
            throw new SkillsBodyError("action must be update");
          }
          const patch: SkillUpdate = {};
          if (payload.description !== undefined) {
            patch.description = stringValue(payload.description) ?? "";
          }
          if (payload.content !== undefined) {
            patch.content = stringValue(payload.content) ?? "";
          }
          const enabled = enabledFrom(payload.enabled);
          if (enabled !== undefined) {
            patch.enabled = enabled;
          }
          if (Object.keys(patch).length === 0) {
            throw new SkillsBodyError("update requires at least one field");
          }
          const skill = skills.update(id, patch, actor);
          return mutationResponse({
            deps,
            skills,
            scope: row.scope,
            target: {
              ...(row.scope === "global" ? {} : { projectId: row.projectId }),
              ...(row.scope === "app" ? { appKey: row.appKey } : {}),
            },
            returnTo,
            fragment,
            browser,
            message: enabled === false ? "Skill disabled here." : "Skill saved.",
            payload: { skill },
          });
        } catch (error) {
          const mapped = mutationError(error, browser, returnTo);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
      }
      return json(404, { error: "not found" });
    }

    const page = skillsPageFor(request.path);
    if (page === undefined || request.method !== "GET") {
      return json(404, { error: "not found" });
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
      renderSkillsPage({
        site,
        chrome: pageChrome(actor, request),
        model,
        ...(entities.project === undefined ? {} : { project: entities.project }),
        ...(entities.app === undefined ? {} : { app: entities.app }),
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
      return json(500, { error: "internal error" });
    }
    const site = buildSite(deps);
    const message = error instanceof Error ? error.message : String(error);
    return html(500, renderErrorPage(site, pageChrome(actor, request), message));
  }
}
