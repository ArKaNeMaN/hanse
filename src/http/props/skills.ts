/**
 * Page props for the five skills routes (`/skills`, project/application skills, `/skills/new`,
 * `/skills/:id`).
 *
 * The legacy inventory/new/detail renderers and the cookie-only `/api/ui/skills*` endpoints both
 * consume these assemblies, so the two surfaces cannot drift. The module owns the data shaping
 * (scope resolution, visibility, effective-source merging, action hrefs, labels) while the legacy
 * renderer only formats the returned props into HTML.
 *
 * No credentials, MCP tokens, provider keys, or settings secrets are read here. Skill content and
 * references are included because the legacy detail page displays them verbatim.
 */

import path from "node:path";
import { resolveInstanceEnv } from "../../opencode/instance.js";
import type { RegisteredApp } from "../../registry/index.js";
import {
  type EffectiveSkill,
  type ResolvedSkills,
  SKILL_LIMITS,
  type SkillApplyOptions,
  type SkillMetadata,
  type SkillPreview,
  type SkillReference,
  type SkillRow,
  type SkillScope,
  type SkillService,
  type SkillStoredIssue,
  type SkillSummary,
  type SkillTarget,
  type SkillWarning,
} from "../../skills/index.js";
import { appDir } from "../apps.js";
import type { ProjectView, SiteModel } from "../dashboard.js";
import type { HttpDeps } from "../handler.js";
import { absoluteTime } from "../ui.js";

/* ------------------------------------------------------------------------- */
/* Errors                                                                     */
/* ------------------------------------------------------------------------- */

export class SkillsTargetError extends Error {
  readonly code = "invalid_scope_target";

  constructor(message: string) {
    super(message);
    this.name = "SkillsTargetError";
  }
}

/* ------------------------------------------------------------------------- */
/* Scope, target, and paths                                                   */
/* ------------------------------------------------------------------------- */

export function scopeLabel(scope: SkillScope): string {
  if (scope === "global") {
    return "Global";
  }
  return scope === "project" ? "Project" : "Application";
}

export function scopeRank(scope: SkillScope): number {
  return scope === "global" ? 0 : scope === "project" ? 1 : 2;
}

export function parseScope(value: unknown): SkillScope {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sourceString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function targetForScope(scope: SkillScope, target: SkillTarget): SkillTarget {
  if (scope === "global") {
    return {};
  }
  if (scope === "project") {
    return { projectId: target.projectId ?? "" };
  }
  return { projectId: target.projectId ?? "", appKey: target.appKey ?? "" };
}

export function rowTarget(row: Pick<SkillRow, "scope" | "projectId" | "appKey">): SkillTarget {
  return targetForScope(row.scope, {
    projectId: row.projectId,
    appKey: row.appKey,
  });
}

export function sameTarget(scope: SkillScope, left: SkillTarget, right: SkillTarget): boolean {
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

export function parseExplicitTarget(source: Record<string, unknown>): {
  scope: SkillScope;
  target: SkillTarget;
} {
  const scope = parseScope(source.scope);
  const projectId = nonEmpty(sourceString(source, "projectId", "project"));
  const appKey = nonEmpty(sourceString(source, "appKey", "app"));
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

export function targetFromQuery(query: Record<string, string>): {
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

export function createTargetFromQuery(query: Record<string, string>): {
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

export function skillsPagePath(scope: SkillScope, target: SkillTarget): string {
  if (scope === "global") {
    return "/skills";
  }
  const projectId = encodeURIComponent(target.projectId ?? "");
  if (scope === "project") {
    return `/projects/${projectId}/skills`;
  }
  return `/projects/${projectId}/apps/${encodeURIComponent(target.appKey ?? "")}/skills`;
}

export function createPagePath(scope: SkillScope, target: SkillTarget): string {
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

export function rowPagePath(row: SkillRow): string {
  return skillsPagePath(row.scope, rowTarget(row));
}

export function workspacePath(row: SkillRow, from?: string): string {
  const base = `/skills/${row.id}`;
  if (from === undefined || from === rowPagePath(row)) {
    return base;
  }
  return `${base}?from=${encodeURIComponent(from)}`;
}

export function targetExists(deps: HttpDeps, scope: SkillScope, target: SkillTarget): boolean {
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

export function pageEntities(
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

/* ------------------------------------------------------------------------- */
/* Preview and surface models                                                 */
/* ------------------------------------------------------------------------- */

export interface SurfaceModel {
  scope: SkillScope;
  target: SkillTarget;
  resolved: ResolvedSkills;
  preview?: SkillPreview;
  returnTo: string;
}

export function previewFor(
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

export function surfaceModel(
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

/* ------------------------------------------------------------------------- */
/* Warnings, issues, pending apps                                             */
/* ------------------------------------------------------------------------- */

export function warningsFor(
  warnings: readonly SkillWarning[],
  name: string,
  codes: readonly SkillWarning["code"][],
): SkillWarning[] {
  return warnings.filter((warning) => warning.name === name && codes.includes(warning.code));
}

export function warningText(warning: SkillWarning): string {
  if (warning.code === "skill_collision") {
    return `"${warning.name ?? ""}" also exists at ${warning.root ?? "another skill root"}`;
  }
  return `"${warning.name ?? ""}" is disabled here but also exists at ${warning.root ?? "another skill root"}`;
}

export interface SkillWarningProps {
  readonly code: SkillWarning["code"];
  readonly name: string | null;
  readonly root: string | null;
  readonly text: string;
}

export function skillWarningProps(warning: SkillWarning): SkillWarningProps {
  return {
    code: warning.code,
    name: warning.name ?? null,
    root: warning.root ?? null,
    text: warningText(warning),
  };
}

export function issueText(issue: SkillStoredIssue): string {
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

export function issueAnchor(issue: SkillStoredIssue): string | undefined {
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

export interface SkillIssueProps {
  readonly code: SkillStoredIssue["code"];
  readonly message: string;
  readonly anchor: string | null;
}

export function skillIssueProps(
  issues: readonly SkillStoredIssue[],
  owned: boolean,
): SkillIssueProps[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issueText(issue),
    anchor: owned ? (issueAnchor(issue) ?? null) : null,
  }));
}

export interface SkillPendingAppProps {
  readonly projectId: string;
  readonly appKey: string;
  readonly href: string;
  readonly restartAction: string;
  readonly returnTo: string;
}

export function pendingApps(
  site: SiteModel,
  scope: SkillScope,
  target: SkillTarget,
  returnTo: string,
): SkillPendingAppProps[] {
  const entries: SkillPendingAppProps[] = [];
  for (const project of site.projects) {
    if (scope !== "global" && project.id !== target.projectId) {
      continue;
    }
    for (const app of project.apps) {
      if (scope === "app" && app.appKey !== target.appKey) {
        continue;
      }
      if (site.pendingRestart.get(app.id) === true) {
        entries.push({
          projectId: project.id,
          appKey: app.appKey,
          href: `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}`,
          restartAction: `/api/apps/${encodeURIComponent(app.appKey)}/restart?project=${encodeURIComponent(project.id)}`,
          returnTo,
        });
      }
    }
  }
  return entries;
}

/* ------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* ------------------------------------------------------------------------- */

export type InventoryState = "enabled" | "inherited" | "disabled" | "invalid";
export type InventoryFilter = "all" | "defined" | "inherited" | "disabled" | "invalid";

export interface SkillsScopeNavProps {
  readonly ariaLabel: string;
  readonly groupLabel: string;
  readonly globalHref: string;
  readonly projectHref: string | null;
  readonly appHref: string | null;
  readonly currentScope: SkillScope;
}

export interface SkillsScopeOptionProps {
  readonly scope: SkillScope;
  readonly label: string;
  readonly shortLabel: string | null;
  readonly href: string | null;
  readonly current: boolean;
}

export interface SkillsScopeProps {
  readonly scope: SkillScope;
  readonly scopeLabel: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly appKey: string | null;
  readonly appName: string | null;
  readonly target: SkillTarget;
  readonly href: string;
  readonly inventoryHref: string;
  readonly createHref: string;
  readonly settingsHref: string | null;
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  readonly nav: SkillsScopeNavProps;
  readonly options: readonly SkillsScopeOptionProps[];
}

export interface SkillsInventoryRowProps {
  readonly id: number;
  readonly primaryId: number;
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly state: InventoryState;
  readonly stateLabel: string;
  readonly enabled: boolean;
  readonly overridden: boolean;
  readonly shadowed: boolean;
  readonly shadows: readonly SkillScope[];
  readonly originScope: SkillScope;
  readonly originText: string;
  readonly references: number;
  readonly updatedAt: string;
  readonly issues: readonly SkillIssueProps[];
  readonly collisions: readonly SkillWarningProps[];
  readonly repairId: number | null;
  readonly effectiveId: number | null;
  readonly effectiveScope: SkillScope | null;
  readonly href: string;
  readonly effectiveHref: string | null;
  readonly actionLabel: string;
}

export interface SkillsFilterProps {
  readonly value: InventoryFilter;
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

export interface SkillsSearchProps {
  readonly action: string;
  readonly query: string;
  readonly hiddenFilter: InventoryFilter | null;
  readonly clearHref: string;
}

export interface SkillsEmptyProps {
  readonly kind: "none" | "search" | "filter";
  readonly iconName: "code" | "search" | "inbox";
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly actionHref: string;
  readonly actionStyle: "primary" | "secondary";
  readonly actionIcon: "plus" | null;
}

export interface SkillsCountsProps {
  readonly enabled: number;
  readonly inherited: number;
  readonly disabled: number;
  readonly invalid: number;
}

export interface SkillsLabelsProps {
  readonly navAriaLabel: string;
  readonly scopeGroupLabel: string;
  readonly title: string;
  readonly createTitle: string;
  readonly detailTitle: string;
  readonly create: string;
  readonly backToSkills: string;
  readonly override: string;
  readonly disable: string;
  readonly editAtSource: string;
  readonly openEffective: string;
  readonly openTombstone: string;
  readonly revert: string;
  readonly openRepair: string;
  readonly openSource: string;
  readonly save: string;
  readonly discard: string;
  readonly delete: string;
}

export interface SkillsInventoryProps {
  readonly scope: SkillsScopeProps;
  readonly title: string;
  readonly description: string;
  readonly overline: string;
  readonly meta: readonly string[];
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  readonly rows: readonly SkillsInventoryRowProps[];
  readonly allCount: number;
  readonly matchedCount: number;
  readonly counts: SkillsCountsProps;
  readonly filter: InventoryFilter;
  readonly filters: readonly SkillsFilterProps[];
  readonly search: SkillsSearchProps;
  readonly createHref: string;
  readonly createLabel: string;
  readonly empty: SkillsEmptyProps | null;
  readonly error: { readonly message: string } | null;
  readonly warnings: readonly SkillWarningProps[];
  readonly truncated: number | null;
  readonly pending: readonly SkillPendingAppProps[];
  readonly returnTo: string;
  readonly labels: SkillsLabelsProps;
}

export function parseInventoryFilter(value: string | undefined): InventoryFilter {
  if (value === "defined" || value === "inherited" || value === "disabled" || value === "invalid") {
    return value;
  }
  return "all";
}

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
  shadows: SkillScope[];
  repairId?: number;
  effectiveId?: number;
  effectiveScope?: SkillScope;
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
    let shadows: SkillScope[] = [];
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
        shadows =
          disabled?.source === null || disabled?.source === undefined ? [] : [disabled.source];
      } else {
        state = "enabled";
        stateLabel = "Enabled here";
        originScope = scoped.scope;
        originText =
          effective === undefined || effective.shadows.length === 0
            ? "Defined here"
            : `Overrides ${effective.shadows.map(scopeLabel).join(", ")}`;
        shadows = effective?.shadows ?? [];
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
        shadows,
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
      shadows: [],
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

function filterHref(pagePath: string, value: InventoryFilter, search: string): string {
  const params = new URLSearchParams();
  if (value !== "all") {
    params.set("filter", value);
  }
  if (search.length > 0) {
    params.set("q", search);
  }
  const query = params.toString();
  return query.length === 0 ? pagePath : `${pagePath}?${query}`;
}

function filterOptions(
  pagePath: string,
  filter: InventoryFilter,
  search: string,
): SkillsFilterProps[] {
  const values: Array<{ value: InventoryFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "defined", label: "Defined here" },
    { value: "inherited", label: "Inherited" },
    { value: "disabled", label: "Disabled" },
    { value: "invalid", label: "Invalid" },
  ];
  return values.map((entry) => ({
    value: entry.value,
    label: entry.label,
    href: filterHref(pagePath, entry.value, search),
    current: entry.value === filter,
  }));
}

function emptyProps(options: {
  scope: SkillScope;
  target: SkillTarget;
  pagePath: string;
  allEmpty: boolean;
  search: string;
}): SkillsEmptyProps {
  const createHref = createPagePath(options.scope, options.target);
  if (options.allEmpty) {
    return {
      kind: "none",
      iconName: "code",
      title: "No skills here yet",
      body: "A skill is a reusable procedure an agent loads at start. Create the first skill at this scope, or inherit one from a wider scope.",
      actionLabel: "Create the first skill",
      actionHref: createHref,
      actionStyle: "primary",
      actionIcon: "plus",
    };
  }
  if (options.search.length > 0) {
    return {
      kind: "search",
      iconName: "search",
      title: "No skills match your search",
      body: `Nothing matches “${options.search}” at this scope.`,
      actionLabel: "Clear search",
      actionHref: options.pagePath,
      actionStyle: "secondary",
      actionIcon: null,
    };
  }
  return {
    kind: "filter",
    iconName: "inbox",
    title: "No skills match this filter",
    body: "Try another filter to see the skills at this scope.",
    actionLabel: "Show all skills",
    actionHref: options.pagePath,
    actionStyle: "secondary",
    actionIcon: null,
  };
}

export interface SkillsInventoryBuildInput {
  readonly deps: HttpDeps;
  readonly site: SiteModel;
  readonly skills: SkillService;
  readonly scope: SkillScope;
  readonly target: SkillTarget;
  readonly filter: InventoryFilter;
  readonly search: string;
}

export function buildSkillsInventoryProps(
  input: SkillsInventoryBuildInput,
): SkillsInventoryProps | undefined {
  const entities = pageEntities(input.site, input.scope, input.target);
  if (entities === undefined) {
    return undefined;
  }
  const project = entities.project;
  const app = entities.app;
  const pagePath = skillsPagePath(input.scope, input.target);
  const model = surfaceModel(input.deps, input.skills, input.scope, input.target, pagePath);
  const warnings = model.preview?.warnings ?? model.resolved.warnings;
  const allRows = buildInventoryRows(model, warnings);
  const rows = allRows
    .filter((row) => inventoryMatchesFilter(row, input.filter))
    .filter((row) => inventoryMatchesSearch(row, input.search));
  const from = encodeURIComponent(pagePath);
  const description =
    input.scope === "global"
      ? "Reusable procedures every application can load. Project and application scopes can override or disable them."
      : input.scope === "project"
        ? `Skills for ${project?.name ?? ""}. Application scopes can override or disable them.`
        : `Skills for ${app?.appKey ?? ""}. This is the narrowest scope.`;
  const breadcrumb =
    input.scope === "global"
      ? [{ label: "Workbench", href: "/" }, { label: "Skills" }]
      : input.scope === "project"
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
  const meta = [
    ...(input.scope === "global" ? [] : [project?.name ?? ""]),
    ...(input.scope === "app" ? [app?.appKey ?? ""] : []),
  ].filter((entry) => entry.length > 0);
  const counts = {
    enabled: allRows.filter((row) => row.state === "enabled").length,
    inherited: allRows.filter((row) => row.state === "inherited").length,
    disabled: allRows.filter((row) => row.state === "disabled").length,
    invalid: allRows.filter((row) => row.state === "invalid").length,
  };
  const globalHref = "/skills";
  const projectHref =
    input.target.projectId === undefined
      ? null
      : `/projects/${encodeURIComponent(input.target.projectId)}/skills`;
  const appHref =
    input.target.projectId === undefined || input.target.appKey === undefined
      ? null
      : `/projects/${encodeURIComponent(input.target.projectId)}/apps/${encodeURIComponent(input.target.appKey)}/skills`;
  return {
    scope: {
      scope: input.scope,
      scopeLabel: scopeLabel(input.scope),
      projectId: input.target.projectId ?? null,
      projectName: project?.name ?? null,
      appKey: input.target.appKey ?? null,
      appName: app?.appKey ?? null,
      target: input.target,
      href: pagePath,
      inventoryHref: pagePath,
      createHref: createPagePath(input.scope, input.target),
      settingsHref:
        input.target.projectId === undefined
          ? "/settings"
          : input.target.appKey === undefined
            ? `/projects/${encodeURIComponent(input.target.projectId)}/settings`
            : `/projects/${encodeURIComponent(input.target.projectId)}/apps/${encodeURIComponent(input.target.appKey)}/settings`,
      breadcrumb,
      nav: {
        ariaLabel: "Skills",
        groupLabel: "Skills scope",
        globalHref,
        projectHref,
        appHref,
        currentScope: input.scope,
      },
      options: [
        {
          scope: "global",
          label: "Global",
          shortLabel: null,
          href: globalHref,
          current: input.scope === "global",
        },
        {
          scope: "project",
          label: "Project",
          shortLabel: null,
          href: projectHref,
          current: input.scope === "project",
        },
        {
          scope: "app",
          label: "Application",
          shortLabel: "App",
          href: appHref,
          current: input.scope === "app",
        },
      ],
    },
    title: "Skills",
    description,
    overline: scopeLabel(input.scope),
    meta,
    breadcrumb,
    rows: rows.map((row) => {
      const primaryId = row.repairId ?? row.effectiveId ?? row.id;
      return {
        id: row.id,
        primaryId,
        name: row.name,
        description: row.description,
        scope: row.scope,
        state: row.state,
        stateLabel: row.stateLabel,
        enabled: row.state === "enabled" || row.state === "inherited",
        overridden: row.state === "enabled" && row.shadows.length > 0,
        shadowed: row.effectiveId !== undefined,
        shadows: row.shadows,
        originScope: row.originScope,
        originText: row.originText,
        references: row.references,
        updatedAt: row.updatedAt,
        issues: skillIssueProps(row.issues, false),
        collisions: row.collisions.map(skillWarningProps),
        repairId: row.repairId ?? null,
        effectiveId: row.effectiveId ?? null,
        effectiveScope: row.effectiveScope ?? null,
        href: `/skills/${primaryId}?from=${from}`,
        effectiveHref:
          row.effectiveId === undefined ? null : `/skills/${row.effectiveId}?from=${from}`,
        actionLabel: `Open ${row.name}`,
      };
    }),
    allCount: allRows.length,
    matchedCount: rows.length,
    counts,
    filter: input.filter,
    filters: filterOptions(pagePath, input.filter, input.search),
    search: {
      action: pagePath,
      query: input.search,
      hiddenFilter: input.filter === "all" ? null : input.filter,
      clearHref: pagePath,
    },
    createHref: createPagePath(input.scope, input.target),
    createLabel: "New skill",
    empty:
      allRows.length === 0
        ? emptyProps({
            scope: input.scope,
            target: input.target,
            pagePath,
            allEmpty: true,
            search: input.search,
          })
        : rows.length === 0
          ? emptyProps({
              scope: input.scope,
              target: input.target,
              pagePath,
              allEmpty: false,
              search: input.search,
            })
          : null,
    error: null,
    warnings: warnings.map(skillWarningProps),
    truncated: model.preview?.truncated ?? null,
    pending: pendingApps(input.site, input.scope, input.target, pagePath),
    returnTo: pagePath,
    labels: SKILLS_LABELS,
  };
}

const SKILLS_LABELS: SkillsLabelsProps = {
  navAriaLabel: "Skills",
  scopeGroupLabel: "Skills scope",
  title: "Skills",
  createTitle: "New skill",
  detailTitle: "Skill",
  create: "New skill",
  backToSkills: "Back to skills",
  override: "Override here",
  disable: "Disable here",
  editAtSource: "Edit at source",
  openEffective: "Open effective source",
  openTombstone: "Open tombstone",
  revert: "Revert to inherited",
  openRepair: "Open/repair at context",
  openSource: "Open source",
  save: "Save changes",
  discard: "Discard changes",
  delete: "Delete skill",
};

/* ------------------------------------------------------------------------- */
/* Workspace values                                                           */
/* ------------------------------------------------------------------------- */

export interface BundleValues {
  license: string | null;
  compatibility: string | null;
  metadata: SkillMetadata;
  metadataRaw: string | null;
  references: SkillReference[];
}

export interface WorkspaceValues {
  name?: string;
  description: string;
  content: string;
  enabled: boolean;
  bundle: BundleValues;
}

export function bundleFromRow(row: SkillRow): BundleValues {
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

export function bundleSnapshot(values: WorkspaceValues, preserveInvalid: boolean): string {
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

export interface SkillReferenceProps {
  readonly path: string;
  readonly content: string;
  readonly size: number;
}

export interface SkillBundleProps {
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly metadata: SkillMetadata;
  readonly metadataRaw: string | null;
  readonly references: readonly SkillReferenceProps[];
}

function bundleProps(values: BundleValues): SkillBundleProps {
  return {
    license: values.license,
    compatibility: values.compatibility,
    metadata: values.metadata,
    metadataRaw: values.metadataRaw,
    references: values.references.map((reference) => ({
      path: reference.path,
      content: reference.content,
      size: Buffer.byteLength(reference.content, "utf8"),
    })),
  };
}

/* ------------------------------------------------------------------------- */
/* Workspace state                                                            */
/* ------------------------------------------------------------------------- */

export type WorkspaceStateName =
  | "editable"
  | "tombstone"
  | "invalid-owned"
  | "invalid-owned-name"
  | "inherited"
  | "shadowed"
  | "hidden"
  | "invalid-context"
  | "not-effective";

export interface WorkspaceState {
  name: WorkspaceStateName;
  contextScope: SkillScope;
  contextTarget: SkillTarget;
  resolved: ResolvedSkills;
  scoped?: SkillSummary;
  effective?: EffectiveSkill;
  editable: boolean;
}

export function stateLabelFor(name: WorkspaceStateName): string {
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

export function stateNote(state: WorkspaceState, row: SkillRow): string {
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

export function parseScopePath(
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
  return skillsPageForPath(pathname);
}

function skillsPageForPath(
  pathname: string,
): { scope: SkillScope; target: SkillTarget } | undefined {
  if (pathname === "/skills") {
    return { scope: "global", target: {} };
  }
  const project = /^\/projects\/([^/]+)\/skills$/.exec(pathname);
  if (project !== null) {
    return { scope: "project", target: { projectId: decode(project[1] ?? "") } };
  }
  const app = /^\/projects\/([^/]+)\/apps\/([^/]+)\/skills$/.exec(pathname);
  if (app !== null) {
    return {
      scope: "app",
      target: {
        projectId: decode(app[1] ?? ""),
        appKey: decode(app[2] ?? ""),
      },
    };
  }
  return undefined;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function viewContext(
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

export function workspaceState(
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
/* Workspace props                                                            */
/* ------------------------------------------------------------------------- */

export interface SkillStateProps {
  readonly name: WorkspaceStateName;
  readonly label: string;
  readonly note: string;
  readonly editable: boolean;
  readonly contextScope: SkillScope;
  readonly contextTarget: SkillTarget;
  readonly effectiveHere: boolean;
}

export interface SkillVisibilityProps {
  readonly enabled: boolean;
  readonly overridden: boolean;
  readonly shadowed: boolean;
  readonly shadows: readonly SkillScope[];
}

export interface SkillActionFormProps {
  readonly action: string;
  readonly returnTo: string;
  readonly fromId: number | null;
  readonly enabled: "1" | "0" | null;
  readonly confirm: string | null;
  readonly label: string;
  readonly style: "primary" | "secondary";
}

export interface SkillActionLinkProps {
  readonly href: string;
  readonly label: string;
  readonly style: "primary" | "secondary" | "ghost";
}

export interface SkillActionsProps {
  readonly target: SkillTargetFieldsProps;
  readonly override: SkillActionFormProps | null;
  readonly disable: SkillActionFormProps | null;
  readonly revert: SkillActionFormProps | null;
  readonly editAtSource: SkillActionLinkProps | null;
  readonly openEffective: SkillActionLinkProps | null;
  readonly openTombstone: SkillActionLinkProps | null;
  readonly openRepair: SkillActionLinkProps | null;
  readonly openSource: SkillActionLinkProps | null;
}

export interface SkillTargetFieldsProps {
  readonly scope: SkillScope;
  readonly projectId: string | null;
  readonly appKey: string | null;
  readonly returnTo: string;
}

export interface SkillFormFieldProps {
  readonly value: string;
  readonly hintId: string;
  readonly error: string | null;
}

export interface SkillFormProps {
  readonly action: string;
  readonly method: "post";
  readonly mode: "create" | "update";
  readonly name: string;
  readonly returnTo: string;
  readonly target: SkillTargetFieldsProps;
  readonly bundleSnapshot: string;
  readonly saveLabel: string;
  readonly discardLabel: string;
  readonly nameField: {
    readonly value: string;
    readonly required: boolean;
    readonly maxlength: number;
    readonly pattern: string;
    readonly hint: string;
    readonly error: string | null;
  } | null;
  readonly description: SkillFormFieldProps;
  readonly enabled: {
    readonly checked: boolean;
    readonly hint: string;
    readonly error: string | null;
  };
}

export interface SkillDangerProps {
  readonly action: string;
  readonly returnTo: string;
  readonly label: string;
  readonly explanation: string;
  readonly expectedName: string;
  readonly invalidName: boolean;
}

export interface SkillRestartProps {
  readonly kind: "none" | "required";
  readonly hint: string;
  readonly entries: readonly SkillPendingAppProps[];
}

export interface SkillWorkspaceRowProps {
  readonly id: number;
  readonly name: string;
  readonly scope: SkillScope;
  readonly description: string;
  readonly enabled: boolean;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly metadata: SkillMetadata;
  readonly metadataRaw: string | null;
  readonly updatedAt: string;
  readonly storedIssues: readonly SkillIssueProps[];
}

export interface SkillWorkspaceProps {
  readonly create: boolean;
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly title: string;
  readonly overline: string;
  readonly meta: readonly string[];
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  readonly contextPage: string;
  readonly projectId: string | null;
  readonly scope: SkillsScopeProps;
  readonly row: SkillWorkspaceRowProps;
  readonly values: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
    readonly enabled: boolean;
    readonly bundle: SkillBundleProps;
  };
  readonly state: SkillStateProps;
  readonly visibility: SkillVisibilityProps;
  readonly stateBadge: {
    readonly name: WorkspaceStateName | "draft";
    readonly label: string;
    readonly tone: "success" | "warning" | "error" | "info";
  };
  readonly actions: SkillActionsProps;
  readonly header: {
    readonly overline: string;
    readonly title: string;
    readonly description: string;
    readonly meta: readonly string[];
    readonly backHref: string | null;
  };
  readonly form: SkillFormProps | null;
  readonly danger: SkillDangerProps | null;
  readonly issues: readonly SkillIssueProps[];
  readonly collisions: readonly SkillWarningProps[];
  readonly warnings: readonly SkillWarningProps[];
  readonly restart: SkillRestartProps | null;
  readonly error: { readonly message: string; readonly field: string | null } | null;
  readonly conflict: { readonly id: number; readonly href: string } | null;
  readonly labels: SkillsLabelsProps;
}

export interface SkillWorkspaceError {
  readonly message: string;
  readonly field?: string;
}

export interface SkillWorkspaceBuildInput {
  readonly site: SiteModel;
  readonly row: SkillRow;
  readonly state: WorkspaceState;
  readonly values: WorkspaceValues;
  readonly error?: SkillWorkspaceError;
  readonly create?: boolean;
  readonly conflictId?: number;
}

function scopeProps(site: SiteModel, scope: SkillScope, target: SkillTarget): SkillsScopeProps {
  const entities = pageEntities(site, scope, target);
  const project = entities?.project;
  const app = entities?.app;
  const pagePath = skillsPagePath(scope, target);
  const projectHref =
    target.projectId === undefined
      ? null
      : `/projects/${encodeURIComponent(target.projectId)}/skills`;
  const appHref =
    target.projectId === undefined || target.appKey === undefined
      ? null
      : `/projects/${encodeURIComponent(target.projectId)}/apps/${encodeURIComponent(target.appKey)}/skills`;
  const breadcrumb =
    scope === "global"
      ? [{ label: "Workbench", href: "/" }, { label: "Skills" }]
      : scope === "project"
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
  return {
    scope,
    scopeLabel: scopeLabel(scope),
    projectId: target.projectId ?? null,
    projectName: project?.name ?? null,
    appKey: target.appKey ?? null,
    appName: app?.appKey ?? null,
    target,
    href: pagePath,
    inventoryHref: pagePath,
    createHref: createPagePath(scope, target),
    settingsHref:
      target.projectId === undefined
        ? "/settings"
        : target.appKey === undefined
          ? `/projects/${encodeURIComponent(target.projectId)}/settings`
          : `/projects/${encodeURIComponent(target.projectId)}/apps/${encodeURIComponent(target.appKey)}/settings`,
    breadcrumb,
    nav: {
      ariaLabel: "Skills",
      groupLabel: "Skills scope",
      globalHref: "/skills",
      projectHref,
      appHref,
      currentScope: scope,
    },
    options: [
      {
        scope: "global",
        label: "Global",
        shortLabel: null,
        href: "/skills",
        current: scope === "global",
      },
      {
        scope: "project",
        label: "Project",
        shortLabel: null,
        href: projectHref,
        current: scope === "project",
      },
      {
        scope: "app",
        label: "Application",
        shortLabel: "App",
        href: appHref,
        current: scope === "app",
      },
    ],
  };
}

function reverseScopeBreadcrumb(
  site: SiteModel,
  state: WorkspaceState,
  name: string,
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
      { label: name },
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
      { label: name },
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
    { label: name },
  ];
}

export function workspaceActions(
  state: WorkspaceState,
  row: SkillRow,
  sourcePage: string,
  labels: SkillsLabelsProps,
): SkillActionsProps {
  const target: SkillTargetFieldsProps = {
    scope: state.contextScope,
    projectId: state.contextTarget.projectId ?? null,
    appKey: state.contextTarget.appKey ?? null,
    returnTo: sourcePage,
  };
  const empty: SkillActionsProps = {
    target,
    override: null,
    disable: null,
    revert: null,
    editAtSource: null,
    openEffective: null,
    openTombstone: null,
    openRepair: null,
    openSource: null,
  };
  switch (state.name) {
    case "inherited":
      return {
        ...empty,
        override: {
          action: "/api/skills",
          returnTo: sourcePage,
          fromId: row.id,
          enabled: "1",
          confirm: "Create an editable copy of this skill at this context?",
          label: labels.override,
          style: "primary",
        },
        disable: {
          action: "/api/skills",
          returnTo: sourcePage,
          fromId: row.id,
          enabled: "0",
          confirm:
            "Disable this skill at this context? A wider skill stays hidden until you revert.",
          label: labels.disable,
          style: "secondary",
        },
        editAtSource: { href: workspacePath(row), label: labels.editAtSource, style: "ghost" },
      };
    case "shadowed":
      return {
        ...empty,
        editAtSource: { href: workspacePath(row), label: labels.editAtSource, style: "ghost" },
        openEffective:
          state.effective === undefined
            ? null
            : {
                href: `/skills/${state.effective.id}?from=${encodeURIComponent(sourcePage)}`,
                label: labels.openEffective,
                style: "secondary",
              },
      };
    case "hidden": {
      const tombstone = state.scoped;
      return {
        ...empty,
        openTombstone:
          tombstone === undefined
            ? null
            : {
                href: `/skills/${tombstone.id}?from=${encodeURIComponent(sourcePage)}`,
                label: labels.openTombstone,
                style: "secondary",
              },
        revert:
          tombstone === undefined
            ? null
            : {
                action: `/api/skills/${tombstone.id}/delete`,
                returnTo: sourcePage,
                fromId: null,
                enabled: null,
                confirm: "Revert this tombstone? The wider skill becomes effective here.",
                label: labels.revert,
                style: "secondary",
              },
      };
    }
    case "invalid-context":
      return {
        ...empty,
        openRepair:
          state.scoped === undefined
            ? null
            : {
                href: `/skills/${state.scoped.id}?from=${encodeURIComponent(sourcePage)}`,
                label: labels.openRepair,
                style: "primary",
              },
      };
    case "not-effective":
      return {
        ...empty,
        openSource: { href: workspacePath(row), label: labels.openSource, style: "secondary" },
      };
    case "editable":
    case "tombstone":
    case "invalid-owned":
    case "invalid-owned-name":
      return empty;
  }
}

function dangerProps(row: SkillRow, contextPage: string): SkillDangerProps {
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
  return {
    action: `/api/skills/${row.id}/delete`,
    returnTo: contextPage,
    label,
    explanation,
    expectedName: row.name,
    invalidName,
  };
}

function restartProps(
  state: WorkspaceState,
  site: SiteModel,
  row: SkillRow,
): SkillRestartProps | null {
  const effectiveHere =
    state.name === "editable" || state.name === "tombstone" || state.name === "inherited";
  if (!effectiveHere) {
    return {
      kind: "none",
      hint: "This change does not affect a running agent; no restart is needed.",
      entries: [],
    };
  }
  const pending = pendingApps(site, state.contextScope, state.contextTarget, workspacePath(row));
  if (pending.length === 0) {
    return null;
  }
  return {
    kind: "required",
    hint: "The effective skill set changed. Restart an agent to apply it; Hanse never restarts automatically.",
    entries: pending,
  };
}

export function emptyRow(scope: SkillScope, target: SkillTarget): SkillRow {
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

export function createState(scope: SkillScope, target: SkillTarget): WorkspaceState {
  return {
    name: "editable",
    contextScope: scope,
    contextTarget: target,
    resolved: { scope, effective: [], rows: [], disabled: [], warnings: [] },
    editable: true,
  };
}

export function emptyWorkspaceValues(): WorkspaceValues {
  return {
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
}

export function buildSkillWorkspaceProps(input: SkillWorkspaceBuildInput): SkillWorkspaceProps {
  const { row, state, values, site } = input;
  const create = input.create === true;
  const editable = create || state.editable;
  const contextPage = skillsPagePath(state.contextScope, state.contextTarget);
  const projectId = state.contextTarget.projectId ?? null;
  const warnings = create
    ? []
    : warningsFor(state.resolved.warnings, row.name, [
        "skill_collision",
        "skill_disabled_elsewhere",
      ]).map(skillWarningProps);
  const title = create ? "New skill" : row.name;
  const overline = create
    ? `${scopeLabel(state.contextScope).toUpperCase()} SKILL`
    : `${scopeLabel(row.scope).toUpperCase()} SKILL`;
  const description = create
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
  if (!create) {
    meta.push(`Updated ${absoluteTime(row.updatedAt)}`);
  }
  meta.push(`${values.bundle.references.length} references`);
  const label = stateLabelFor(state.name);
  const tone: "success" | "warning" | "error" | "info" = create
    ? "info"
    : state.name === "editable" || state.name === "inherited"
      ? "success"
      : state.name === "tombstone" ||
          state.name === "not-effective" ||
          state.name === "shadowed" ||
          state.name === "hidden"
        ? "warning"
        : "error";
  const breadcrumb = create
    ? [
        ...(state.contextScope === "global"
          ? [
              { label: "Workbench", href: "/" },
              { label: "Skills", href: contextPage },
            ]
          : reverseScopeBreadcrumb(site, state, "Skills")),
        { label: "New skill" },
      ]
    : reverseScopeBreadcrumb(site, state, row.name);
  const issues = create ? [] : skillIssueProps(row.storedIssues, state.editable);
  const effectiveShadows = state.effective?.shadows ?? [];
  const visibility: SkillVisibilityProps = {
    enabled: row.enabled && row.storedIssues.length === 0,
    overridden:
      state.name === "shadowed" ||
      state.name === "hidden" ||
      state.name === "invalid-context" ||
      state.name === "not-effective",
    shadowed: state.name === "shadowed" || state.name === "hidden",
    shadows: effectiveShadows,
  };
  const form =
    editable && (create || !state.name.startsWith("invalid-owned-name"))
      ? {
          action: create ? "/api/skills" : `/api/skills/${row.id}`,
          method: "post" as const,
          mode: create ? ("create" as const) : ("update" as const),
          name: row.name,
          returnTo: create ? contextPage : workspacePath(row),
          target: {
            scope: state.contextScope,
            projectId: state.contextTarget.projectId ?? null,
            appKey: state.contextTarget.appKey ?? null,
            returnTo: create ? contextPage : workspacePath(row),
          },
          bundleSnapshot: bundleSnapshot(values, !create && row.storedIssues.length > 0),
          saveLabel: create ? "Create skill" : "Save changes",
          discardLabel: create ? "Discard" : "Discard changes",
          nameField: create
            ? {
                value: values.name ?? "",
                required: true,
                maxlength: SKILL_LIMITS.name,
                pattern: "[a-z0-9]+(?:-[a-z0-9]+)*",
                hint: "Lowercase letters, digits, and single hyphens.",
                error: input.error?.field === "name" ? (input.error.message ?? null) : null,
              }
            : null,
          description: {
            value: values.description,
            hintId: "skill-description-hint",
            error: input.error?.field === "description" ? input.error.message : null,
          },
          enabled: {
            checked: values.enabled,
            hint: "Uncheck to hide this skill at this context without deleting it.",
            error: input.error?.field === "enabled" ? input.error.message : null,
          },
        }
      : null;
  const danger =
    !create && (state.editable || state.name === "invalid-owned-name")
      ? dangerProps(row, contextPage)
      : null;
  return {
    create,
    id: row.id,
    name: row.name,
    description: row.description,
    title,
    overline,
    meta,
    breadcrumb,
    contextPage,
    projectId,
    scope: scopeProps(site, state.contextScope, state.contextTarget),
    row: {
      id: row.id,
      name: row.name,
      scope: row.scope,
      description: row.description,
      enabled: row.enabled,
      license: row.license,
      compatibility: row.compatibility,
      metadata: row.metadata,
      metadataRaw: row.metadataRaw,
      updatedAt: row.updatedAt,
      storedIssues: issues,
    },
    values: {
      name: values.name ?? "",
      description: values.description,
      content: values.content,
      enabled: values.enabled,
      bundle: bundleProps(values.bundle),
    },
    state: {
      name: state.name,
      label,
      note: stateNote(state, row),
      editable: state.editable,
      contextScope: state.contextScope,
      contextTarget: state.contextTarget,
      effectiveHere:
        state.name === "editable" || state.name === "tombstone" || state.name === "inherited",
    },
    visibility,
    stateBadge: { name: create ? "draft" : state.name, label: create ? "Draft" : label, tone },
    actions: workspaceActions(state, row, contextPage, SKILLS_LABELS),
    header: {
      overline,
      title,
      description,
      meta,
      backHref: create ? contextPage : null,
    },
    form,
    danger,
    issues,
    collisions: warnings,
    warnings,
    restart: create ? null : restartProps(state, site, row),
    error:
      input.error === undefined
        ? null
        : { message: input.error.message, field: input.error.field ?? null },
    conflict:
      input.conflictId === undefined
        ? null
        : {
            id: input.conflictId,
            href: `/skills/${input.conflictId}?from=${encodeURIComponent(contextPage)}`,
          },
    labels: SKILLS_LABELS,
  };
}

export interface SkillCreateBuildInput {
  readonly site: SiteModel;
  readonly scope: SkillScope;
  readonly target: SkillTarget;
  readonly values?: WorkspaceValues;
  readonly error?: SkillWorkspaceError;
  readonly conflictId?: number;
}

export function buildSkillCreateProps(input: SkillCreateBuildInput): SkillWorkspaceProps {
  return buildSkillWorkspaceProps({
    site: input.site,
    row: emptyRow(input.scope, input.target),
    state: createState(input.scope, input.target),
    values: input.values ?? emptyWorkspaceValues(),
    ...(input.error === undefined ? {} : { error: input.error }),
    create: true,
    ...(input.conflictId === undefined ? {} : { conflictId: input.conflictId }),
  });
}

export interface SkillDetailBuildInput {
  readonly deps: HttpDeps;
  readonly site: SiteModel;
  readonly skills: SkillService;
  readonly row: SkillRow;
  readonly from?: string;
  readonly values?: WorkspaceValues;
  readonly error?: SkillWorkspaceError;
  readonly context?: { scope: SkillScope; target: SkillTarget };
}

export function buildSkillDetailProps(input: SkillDetailBuildInput): SkillWorkspaceProps {
  const context = input.context ?? viewContext(input.deps, input.from, input.row);
  const state = workspaceState(input.skills, input.row, context);
  const values =
    input.values ??
    ({
      description: input.row.description,
      content: input.row.content,
      enabled: input.row.enabled,
      bundle: bundleFromRow(input.row),
    } satisfies WorkspaceValues);
  return buildSkillWorkspaceProps({
    site: input.site,
    row: input.row,
    state,
    values,
    ...(input.error === undefined ? {} : { error: input.error }),
  });
}

/* ------------------------------------------------------------------------- */
/* Endpoint target parsing                                                    */
/* ------------------------------------------------------------------------- */

export function inventoryTargetFromQuery(query: Record<string, string>): {
  scope: SkillScope;
  target: SkillTarget;
} {
  const project = nonEmpty(query.project);
  const app = nonEmpty(query.app);
  const rawScope = nonEmpty(query.scope);
  if (rawScope === undefined) {
    return targetFromQuery(query);
  }
  return parseExplicitTarget({ scope: rawScope, project, app });
}

/* ------------------------------------------------------------------------- */
/* Shared labels                                                              */
/* ------------------------------------------------------------------------- */
