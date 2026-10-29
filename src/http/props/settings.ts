/**
 * Page props for the three settings scopes (`/settings`, project settings, application settings).
 *
 * `buildSettingsProps` is the single assembly used by the legacy settings renderer and by
 * `GET /api/ui/settings`, so the two renderers cannot drift. It returns `undefined` when the
 * requested project/app target does not exist.
 *
 * Secrets are write-only. This module never reads provider key plaintext or git credential
 * private material: provider rows carry only the status metadata from `ResolvedSettings`, and git
 * rows carry only public metadata (public key/fingerprint/allowed hosts/username) already rendered
 * by the legacy page. Masked values are markers such as "Not shown", never the stored secret.
 */

import type { ModelProvider, ModelProviderModel } from "../../model-providers/index.js";
import { collisionWarnings, providerBaseUrlWarnings } from "../../model-providers/index.js";
import type { RegisteredApp } from "../../registry/index.js";
import {
  type EffectiveValue,
  type GitAuthKind,
  type GitAuthScoped,
  type GitAuthScopedState,
  type GitAuthStatus,
  type PendingRestart,
  type ProviderKeyStatus,
  type ResolvedSettings,
  type ScopedValue,
  type SettingsScope,
  type SettingsTarget,
  SettingsValidationError,
} from "../../settings/index.js";
import { DEEPSEEK_FIELDS, webDriverDefinitions } from "../../web/registry.js";
import type { ProjectView, SiteModel } from "../dashboard.js";
import type { HttpDeps } from "../handler.js";
import type { Notice } from "../ui.js";

export const SETTINGS_SECTION_KEYS = [
  "agent",
  "web",
  "context",
  "git",
  "restart",
  "warnings",
] as const;
export type SettingsSectionKey = (typeof SETTINGS_SECTION_KEYS)[number];

export type SettingsScopeState = ScopedValue<unknown>["state"];

export interface SettingsScopeOptionProps {
  readonly value: string;
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

export interface SettingsAppOptionProps extends SettingsScopeOptionProps {
  readonly appKey: string;
}

export interface SettingsProjectOptionProps extends SettingsScopeOptionProps {
  readonly projectId: string;
  readonly apps: readonly SettingsAppOptionProps[];
}

export interface SettingsScopeHrefProps {
  readonly global: string;
  readonly project: string | null;
  readonly app: string | null;
}

export interface SettingsScopeProps {
  readonly scope: SettingsScope;
  readonly scopeLabel: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly appKey: string | null;
  readonly appId: string | null;
  readonly href: string;
  readonly settingsHref: string;
  readonly skillsHref: string;
  readonly title: string;
  readonly description: string;
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  readonly nav: {
    readonly globalHref: string;
    readonly projectHref: string | null;
    readonly appHref: string | null;
    readonly projectCurrent: boolean;
    readonly appCurrent: boolean;
    readonly projectShortLabel: string;
    readonly appShortLabel: string;
  };
  readonly hrefs: SettingsScopeHrefProps;
  readonly projects: readonly SettingsProjectOptionProps[];
}

export interface SettingsEffectiveProps {
  readonly value: unknown;
  readonly state: EffectiveValue<unknown>["state"];
  readonly source: SettingsScope | "default";
  readonly sources: readonly (SettingsScope | "default")[];
  readonly text: string;
  readonly sourceLine: string;
}

export interface SettingsScopeDetailProps {
  readonly scope: SettingsScope;
  readonly label: string;
  readonly state: SettingsScopeState;
  readonly stateLabel: string;
  readonly valueText: string | null;
}

export interface SettingsRowActionProps {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly label: string;
  readonly confirmLabel: string | null;
  readonly reason: string | null;
  readonly warning: string | null;
}

export interface SettingsRowActionsProps {
  readonly save: SettingsRowActionProps;
  readonly inherit: SettingsRowActionProps | null;
  readonly clear: SettingsRowActionProps | null;
}

export interface SettingsFormProps {
  readonly action: string;
  readonly method: "post";
  readonly successNotice: string;
  readonly returnTo: string;
  readonly hidden: {
    readonly scope: SettingsScope;
    readonly projectId: string | null;
    readonly appKey: string | null;
    readonly returnTo: string;
  };
}

export interface SettingsSelectOptionProps {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
}

export interface SettingsDriverFieldProps {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "number" | "checkbox";
  readonly min: number | null;
  readonly max: number | null;
  readonly placeholder: string | null;
  readonly value: string;
  readonly checked: boolean;
  readonly required: boolean;
}

export interface SettingsDriverControlProps {
  readonly options: readonly SettingsSelectOptionProps[];
  readonly placeholder: SettingsSelectOptionProps | null;
  readonly fields: readonly SettingsDriverFieldProps[];
  readonly showFields: boolean;
}

export interface SettingsNumberControlProps {
  readonly value: string;
  readonly placeholder: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly required: boolean;
}

export interface SettingsSelectControlProps {
  readonly options: readonly SettingsSelectOptionProps[];
  readonly placeholder: SettingsSelectOptionProps | null;
}

export interface SettingsTextControlProps {
  readonly value: string;
  readonly placeholder: string;
  readonly required: boolean;
  readonly autocomplete: string | null;
  readonly listId: string | null;
  readonly options: readonly string[];
}

export type SettingsRowKind =
  | "model"
  | "web"
  | "context-enabled"
  | "context-percent"
  | "git-identity";

export interface SettingsRowProps {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly hint: string | null;
  readonly kind: SettingsRowKind;
  readonly effective: SettingsEffectiveProps;
  readonly effectiveText: string;
  readonly sourceLine: string;
  readonly own: ScopedValue<unknown>;
  readonly warnings: readonly string[];
  readonly scopeDetails: readonly SettingsScopeDetailProps[];
  readonly actions: SettingsRowActionsProps;
  readonly form: SettingsFormProps;
  readonly text: SettingsTextControlProps | null;
  readonly select: SettingsSelectControlProps | null;
  readonly number: SettingsNumberControlProps | null;
  readonly driver: SettingsDriverControlProps | null;
  readonly inheritedNote: string | null;
  readonly errorSlotId: string;
}

export interface SettingsProviderRowProps {
  readonly provider: string;
  readonly status: ProviderKeyStatus;
  readonly state: "set" | "cleared" | "missing" | "host" | "error";
  readonly configured: boolean;
  readonly usable: boolean;
  readonly masked: string;
  readonly effectiveText: string;
  readonly sourceLine: string;
  readonly warning: string | null;
  readonly rowId: string;
  readonly errorSlotId: string;
  readonly actions: SettingsRowActionsProps;
  readonly form: SettingsFormProps;
}

export interface SettingsModelProviderRowProps {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly ModelProviderModel[];
  readonly modelsText: string;
  readonly warnings: readonly string[];
  readonly key: {
    readonly status: ProviderKeyStatus;
    readonly state: "set" | "cleared" | "missing" | "host" | "error";
    readonly label: string;
    readonly masked: string;
  };
  readonly rowId: string;
  readonly nameInputId: string;
  readonly urlInputId: string;
  readonly modelsInputId: string;
  readonly errorId: string;
  readonly actions: {
    readonly update: string;
    readonly delete: string;
    readonly returnTo: string;
  };
}

export interface SettingsModelProvidersProps {
  readonly providers: readonly SettingsModelProviderRowProps[];
  readonly count: number;
  readonly add: {
    readonly action: string;
    readonly returnTo: string;
    readonly errorId: string;
  };
  readonly manageHref: string;
}

export interface SettingsGitCredentialProps {
  readonly kind: GitAuthKind;
  readonly title: string;
  readonly status: GitAuthStatus;
  readonly state: "set" | "cleared" | "missing" | "error";
  readonly configured: boolean;
  readonly hasSecret: boolean;
  readonly masked: string;
  readonly effectiveText: string;
  readonly sourceLine: string;
  readonly scopedState: GitAuthScopedState;
  readonly scoped: Record<SettingsScope, GitAuthScopedState>;
  readonly scopeDetails: readonly SettingsScopeDetailProps[];
  readonly allowTest: boolean;
  readonly inheritReason: string | null;
  readonly clearReason: string | null;
  readonly details: {
    readonly publicKey: string | null;
    readonly fingerprint: string | null;
    readonly hasKnownHosts: boolean | null;
    readonly hosts: readonly string[] | null;
    readonly username: string | null;
    readonly error: string | null;
  };
  readonly actions: {
    readonly action: string;
    readonly test: string | null;
    readonly allowTest: boolean;
  };
  readonly form: SettingsFormProps;
}

export interface SettingsGitProps {
  readonly identity: readonly SettingsRowProps[];
  readonly ssh: SettingsGitCredentialProps;
  readonly https: SettingsGitCredentialProps;
  readonly testAppPath: string | null;
  readonly testCheck: {
    readonly hint: string;
    readonly href: string | null;
  };
  readonly securityNotes: string;
}

export interface SettingsPendingRowProps {
  readonly appId: string;
  readonly appKey: string;
  readonly projectId: string;
  readonly reasons: readonly string[];
  readonly reasonLabels: readonly string[];
  readonly href: string;
  readonly restartAction: string;
  readonly returnTo: string;
}

export interface SettingsRestartProps {
  readonly pending: readonly SettingsPendingRowProps[];
  readonly restartRequired: boolean;
  readonly profileWarnings: readonly string[];
  readonly returnTo: string;
  readonly hint: string;
}

export interface SettingsLabelsProps {
  readonly nav: {
    readonly ariaLabel: string;
    readonly scopeLabel: string;
    readonly sectionsLabel: string;
    readonly scopes: Readonly<Record<SettingsScope | "applicationShort", string>>;
    readonly sections: {
      readonly agent: string;
      readonly web: string;
      readonly context: string;
      readonly git: string;
      readonly restart: string;
    };
  };
  readonly sections: {
    readonly agent: string;
    readonly web: string;
    readonly context: string;
    readonly git: string;
    readonly restart: string;
  };
  readonly actions: {
    readonly save: string;
    readonly inherit: string;
    readonly clear: string;
    readonly clearTitle: string;
    readonly clearBody: string;
    readonly clearConfirm: string;
    readonly cancel: string;
    readonly restartAgent: string;
    readonly testConnection: string;
  };
  readonly providers: {
    readonly title: string;
    readonly hint: string;
    readonly empty: string;
    readonly addTitle: string;
    readonly keyLabel: string;
    readonly providerLabel: string;
    readonly providerPlaceholder: string;
    readonly changeKey: string;
    readonly masked: string;
  };
  readonly modelProviders: {
    readonly title: string;
    readonly hint: string;
    readonly empty: string;
    readonly addTitle: string;
    readonly globalHint: string;
    readonly manage: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly models: string;
    readonly modelsHint: string;
    readonly providerId: string;
    readonly providerIdPlaceholder: string;
    readonly namePlaceholder: string;
    readonly baseUrlPlaceholder: string;
    readonly modelsPlaceholder: string;
    readonly deleteConfirmPrefix: string;
    readonly modelsCount: string;
  };
  readonly git: {
    readonly title: string;
    readonly badge: string;
    readonly noscript: string;
    readonly user: string;
    readonly email: string;
    readonly ssh: string;
    readonly https: string;
    readonly key: {
      readonly overline: string;
      readonly fingerprint: string;
      readonly knownHosts: string;
      readonly knownHostsSet: string;
      readonly knownHostsUnset: string;
      readonly allowedHosts: string;
      readonly username: string;
      readonly cleared: string;
      readonly missing: string;
    };
    readonly testApp: string;
    readonly credentialCheck: string;
    readonly credentialCheckHint: string;
    readonly appSettings: string;
    readonly testHint: string;
    readonly securityNotes: string;
  };
  readonly restart: {
    readonly title: string;
    readonly badge: string;
    readonly hint: string;
    readonly empty: string;
    readonly profileWarnings: string;
  };
  readonly warnings: string;
}

export interface SettingsDialogsProps {
  readonly clear: {
    readonly id: string;
    readonly titleId: string;
    readonly metaId: string;
    readonly bodyId: string;
    readonly formId: string;
    readonly action: string;
    readonly title: string;
    readonly body: string;
    readonly fieldError: string;
    readonly cancel: string;
    readonly submit: string;
  };
}

export interface SettingsProps {
  readonly scope: SettingsScopeProps;
  readonly effective: ResolvedSettings["effective"];
  readonly scoped: Record<string, ScopedValue<unknown>>;
  readonly providerKeys: Record<string, ProviderKeyStatus>;
  readonly gitAuth: ResolvedSettings["gitAuth"];
  readonly gitAuthScoped: GitAuthScoped;
  readonly warnings: readonly string[];
  readonly pendingRestart: readonly PendingRestart[];
  readonly notice: Notice | null;
  readonly rows: {
    readonly model: SettingsRowProps;
    readonly webSearch: SettingsRowProps;
    readonly webFetch: SettingsRowProps;
    readonly contextEnabled: SettingsRowProps;
    readonly contextPercent: SettingsRowProps;
    readonly gitName: SettingsRowProps;
    readonly gitEmail: SettingsRowProps;
  };
  readonly providers: readonly SettingsProviderRowProps[];
  readonly modelProviders: SettingsModelProvidersProps;
  readonly git: SettingsGitProps;
  readonly restart: SettingsRestartProps;
  readonly labels: SettingsLabelsProps;
  readonly dialogs: SettingsDialogsProps;
  /** Client-owned unsaved-form state; server-provided props always start clean. */
  readonly dirty: boolean;
  readonly restartRequired: boolean;
}

/* ------------------------------------------------------------------------- */
/* Target and scope helpers                                                 */
/* ------------------------------------------------------------------------- */

export function settingsScopeLabel(scope: SettingsScope): string {
  if (scope === "global") {
    return "Global";
  }
  return scope === "project" ? "Project" : "Application";
}

export function applicableSettingsScopes(scope: SettingsScope): SettingsScope[] {
  if (scope === "global") {
    return ["global"];
  }
  return scope === "project" ? ["global", "project"] : ["global", "project", "app"];
}

function scopeValue(value: unknown): SettingsScope {
  if (value === "global" || value === "project" || value === "app") {
    return value;
  }
  throw new SettingsValidationError("scope must be global, project, or app");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function targetFrom(source: Record<string, unknown>, scope: SettingsScope): SettingsTarget {
  const projectId = stringValue(source.projectId ?? source.project);
  const appKey = stringValue(source.appKey ?? source.app);
  if (scope === "global") {
    return {};
  }
  if (scope === "project") {
    if (projectId === undefined || projectId.length === 0) {
      throw new SettingsValidationError("project scope requires projectId");
    }
    return { projectId };
  }
  if (projectId === undefined || projectId.length === 0) {
    throw new SettingsValidationError("app scope requires projectId");
  }
  if (appKey === undefined || appKey.length === 0) {
    throw new SettingsValidationError("app scope requires appKey");
  }
  return { projectId, appKey };
}

/** Parse `scope` plus target fields exactly like the legacy settings API. */
export function parseSettingsTarget(source: Record<string, unknown>): {
  scope: SettingsScope;
  target: SettingsTarget;
} {
  const scope = scopeValue(source.scope);
  return { scope, target: targetFrom(source, scope) };
}

export function settingsPagePath(scope: SettingsScope, target: SettingsTarget): string {
  if (scope === "global") {
    return "/settings";
  }
  if (scope === "project") {
    return `/projects/${encodeURIComponent(target.projectId ?? "")}/settings`;
  }
  return `/projects/${encodeURIComponent(target.projectId ?? "")}/apps/${encodeURIComponent(
    target.appKey ?? "",
  )}/settings`;
}

export function firstAppSettingsPath(site: SiteModel, projectId?: string): string | undefined {
  const project =
    projectId === undefined
      ? site.projects.find((entry) => entry.apps.length > 0)
      : site.projects.find((entry) => entry.id === projectId);
  const app = project?.apps[0];
  if (project === undefined || app === undefined) {
    return undefined;
  }
  return `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/settings`;
}

interface SettingsPageEntities {
  readonly project?: ProjectView;
  readonly app?: RegisteredApp;
}

export function settingsPageEntities(
  site: SiteModel,
  scope: SettingsScope,
  target: SettingsTarget,
): SettingsPageEntities | undefined {
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

function pendingFor(
  deps: HttpDeps,
  scope: SettingsScope,
  target: SettingsTarget,
): PendingRestart[] {
  const manager = deps.manager;
  if (manager === undefined) {
    return [];
  }
  const pending: PendingRestart[] = [];
  for (const project of deps.getProjects()) {
    if (scope !== "global" && target.projectId !== project.id) {
      continue;
    }
    for (const app of project.service.listApps()) {
      if (scope === "app" && app.appKey !== target.appKey) {
        continue;
      }
      const state = manager.pendingRestart(app.id);
      if (state.pending) {
        pending.push({
          appId: app.id,
          appKey: app.appKey,
          projectId: project.id,
          reasons: state.reasons,
        });
      }
    }
  }
  return pending;
}

export function settingsRestartReason(reason: string): string {
  if (reason === "settings_changed") {
    return "Settings changed";
  }
  if (reason === "profile_not_applied") {
    return "Agent profile not applied";
  }
  if (reason === "applied_state_unknown") {
    return "Applied state unknown";
  }
  return reason;
}

/* ------------------------------------------------------------------------- */
/* Presentation helpers                                                     */
/* ------------------------------------------------------------------------- */

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "Cleared";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function effectiveText(effective: EffectiveValue<unknown>): string {
  if (effective.state === "default") {
    return effective.value === null ? "Not set" : formatValue(effective.value);
  }
  if (effective.state === "cleared") {
    return "Cleared";
  }
  return formatValue(effective.value);
}

function sourceName(source: SettingsScope | "default"): string {
  return source === "default" ? "default" : settingsScopeLabel(source);
}

function sourceLine(effective: EffectiveValue<unknown>): string {
  if (effective.state === "cleared" && effective.source !== "default") {
    return `Cleared at ${settingsScopeLabel(effective.source)}`;
  }
  if (effective.source === "default") {
    return "default";
  }
  return `from ${settingsScopeLabel(effective.source)}`;
}

function ownValue(
  resolved: ResolvedSettings,
  scope: SettingsScope,
  key: string,
): ScopedValue<unknown> {
  return resolved.scoped[`${scope}:${key}`] ?? { state: "absent", value: null };
}

function stringPrefill(
  scope: SettingsScope,
  own: ScopedValue<unknown>,
  effective: EffectiveValue<unknown>,
): { value: string; placeholder: string } {
  if (own.state === "set" && typeof own.value === "string") {
    return { value: own.value, placeholder: "" };
  }
  const prefix = scope === "global" ? "Default" : "Inherited";
  const fallback =
    effective.state === "cleared"
      ? "Cleared"
      : effective.value === null
        ? "Not set"
        : String(effective.value);
  return { value: "", placeholder: `${prefix}: ${fallback}` };
}

export function isWebToolConfig(value: unknown): value is { driver: "builtin" | "deepseek" } {
  if (typeof value !== "object" || value === null || !("driver" in value)) {
    return false;
  }
  const driver = (value as { driver?: unknown }).driver;
  return driver === "builtin" || driver === "deepseek";
}

function ownWebValue(
  resolved: ResolvedSettings,
  scope: SettingsScope,
  key: string,
): { driver: "builtin" | "deepseek"; options?: Record<string, unknown> } | null {
  const own = ownValue(resolved, scope, key);
  return own.state === "set" && isWebToolConfig(own.value)
    ? (own.value as { driver: "builtin" | "deepseek"; options?: Record<string, unknown> })
    : null;
}

function scopeStateLabel(state: SettingsScopeState): string {
  if (state === "set") {
    return "Set";
  }
  return state === "cleared" ? "Cleared" : "Inherited";
}

function scopeDetailsFor(
  resolved: ResolvedSettings,
  scope: SettingsScope,
  key: string,
): SettingsScopeDetailProps[] {
  if (scope === "global") {
    return [];
  }
  return applicableSettingsScopes(scope).map((entry) => {
    const row = resolved.scoped[`${entry}:${key}`] ?? { state: "absent", value: null };
    return {
      scope: entry,
      label: settingsScopeLabel(entry),
      state: row.state,
      stateLabel: scopeStateLabel(row.state),
      valueText: row.state === "set" ? formatValue(row.value) : null,
    };
  });
}

function inheritAction(options: {
  scope: SettingsScope;
  ownState: SettingsScopeState;
  effective: EffectiveValue<unknown>;
}): SettingsRowActionProps | null {
  if (options.scope === "global") {
    return null;
  }
  if (options.ownState !== "absent") {
    return {
      visible: true,
      enabled: true,
      label: "Inherit",
      confirmLabel: null,
      reason: null,
      warning: null,
    };
  }
  const inherited =
    options.effective.source !== "default" &&
    (options.effective.state === "set" || options.effective.state === "cleared");
  const reason = inherited
    ? `Already inherited from ${settingsScopeLabel(options.effective.source as SettingsScope)}.`
    : "Already uses the default.";
  return {
    visible: true,
    enabled: false,
    label: "Inherit",
    confirmLabel: null,
    reason,
    warning: null,
  };
}

function clearAction(options: {
  scope: SettingsScope;
  ownState: SettingsScopeState;
  label: string;
  globalWarning: boolean;
}): SettingsRowActionProps {
  const warning =
    options.scope === "global" && options.globalWarning
      ? "Clearing here disables this setting for every application."
      : null;
  if (options.ownState === "cleared") {
    return {
      visible: true,
      enabled: false,
      label: "Clear",
      confirmLabel: options.label,
      reason: "Already cleared at this scope.",
      warning,
    };
  }
  return {
    visible: true,
    enabled: true,
    label: "Clear",
    confirmLabel: options.label,
    reason: null,
    warning,
  };
}

function rowActions(options: {
  scope: SettingsScope;
  ownState: SettingsScopeState;
  effective: EffectiveValue<unknown>;
  label: string;
  clearable: boolean;
  globalWarning?: boolean;
}): SettingsRowActionsProps {
  return {
    save: {
      visible: true,
      enabled: true,
      label: "Save",
      confirmLabel: null,
      reason: null,
      warning: null,
    },
    inherit: inheritAction({
      scope: options.scope,
      ownState: options.ownState,
      effective: options.effective,
    }),
    clear: options.clearable
      ? clearAction({
          scope: options.scope,
          ownState: options.ownState,
          label: options.label,
          globalWarning: options.globalWarning === true,
        })
      : null,
  };
}

function formProps(
  scope: SettingsScope,
  target: SettingsTarget,
  returnTo: string,
  action: string,
  successNotice: string,
): SettingsFormProps {
  return {
    action,
    method: "post",
    successNotice,
    returnTo,
    hidden: {
      scope,
      projectId: scope === "global" ? null : (target.projectId ?? ""),
      appKey: scope === "app" ? (target.appKey ?? "") : null,
      returnTo,
    },
  };
}

function selectOption(
  value: string,
  label: string,
  selected: boolean,
  disabled = false,
): SettingsSelectOptionProps {
  return { value, label, selected, disabled };
}

function modelProviderWarning(resolved: ResolvedSettings): string | undefined {
  const model = resolved.effective.llm.model.value;
  if (model === null) {
    return undefined;
  }
  const provider = model.split("/")[0] ?? "";
  const status = resolved.providerKeys[provider];
  if (status === undefined || status.state === "missing") {
    return `No provider key or host auth is configured for "${provider}". The selected model may fail to authenticate.`;
  }
  if (status.state === "cleared") {
    return `The provider key for "${provider}" is cleared and no wider scope provides one. The selected model may fail to authenticate.`;
  }
  if (status.state === "host" && status.authType !== "api") {
    return `Host auth for "${provider}" is ${status.authType}, not an API key. The selected model may fail to authenticate.`;
  }
  if (status.state === "error") {
    return `Provider "${provider}" has an unusable key: ${status.message}`;
  }
  return undefined;
}

function webToolWarning(
  key: string,
  effective: EffectiveValue<{ driver: "builtin" | "deepseek"; options?: { provider?: string } }>,
  resolved: ResolvedSettings,
): string | undefined {
  const value = effective.value;
  if (value === null) {
    return undefined;
  }
  if (value.driver === "builtin") {
    if (key === "web.search" && (process.env.HANSE_OMO_PLUGIN ?? "").trim().length === 0) {
      return "Built-in search requires the OMO baseline (HANSE_OMO_PLUGIN). No built-in search tool is available until OMO is installed and enabled.";
    }
    return undefined;
  }
  const provider = value.options?.provider ?? "";
  const status = resolved.providerKeys[provider];
  if (status === undefined || status.state === "missing") {
    return `No provider key or host auth is configured for "${provider}". The managed web tool will be unavailable.`;
  }
  if (status.state === "cleared") {
    return `The provider key for "${provider}" is cleared and no wider scope provides one. The managed web tool will be unavailable.`;
  }
  if (status.state === "host" && status.authType !== "api") {
    return `Host auth for "${provider}" is ${status.authType}, not an API key. The managed web tool will be unavailable.`;
  }
  if (status.state === "error") {
    return `Provider "${provider}" has an unusable key: ${status.message}`;
  }
  return undefined;
}

function providerStatusLabel(status: ProviderKeyStatus): string {
  switch (status.state) {
    case "set":
      return `Set at ${status.source}`;
    case "cleared":
      return `Cleared at ${status.source}`;
    case "host":
      return `Host auth (${status.authType})`;
    case "error":
      return `Error: ${status.message}`;
    default:
      return "Missing";
  }
}

function providerSourceLine(status: ProviderKeyStatus): string {
  if (status.state === "set") {
    return `from ${settingsScopeLabel(status.source)}`;
  }
  if (status.state === "cleared") {
    return `Cleared at ${settingsScopeLabel(status.source)}`;
  }
  if (status.state === "host") {
    return "from host auth";
  }
  if (status.state === "error") {
    return "error";
  }
  return "default";
}

function providerState(status: ProviderKeyStatus): SettingsProviderRowProps["state"] {
  return status.state;
}

function providerConfigured(status: ProviderKeyStatus): boolean {
  return status.state === "set" || status.state === "host";
}

function providerUsable(status: ProviderKeyStatus): boolean {
  return status.state === "set" || (status.state === "host" && status.authType === "api");
}

function providerActions(
  status: ProviderKeyStatus,
  scope: SettingsScope,
  provider: string,
): SettingsRowActionsProps {
  const inherit: SettingsRowActionProps | null =
    scope === "global"
      ? null
      : (status.state === "set" || status.state === "cleared") && status.source === scope
        ? {
            visible: true,
            enabled: true,
            label: "Inherit",
            confirmLabel: null,
            reason: null,
            warning: null,
          }
        : {
            visible: true,
            enabled: false,
            label: "Inherit",
            confirmLabel: null,
            reason: `Already inherited from ${
              status.state === "set" || status.state === "cleared"
                ? settingsScopeLabel(status.source)
                : status.state === "host"
                  ? "host auth"
                  : "default"
            }.`,
            warning: null,
          };
  const clear: SettingsRowActionProps =
    status.state === "cleared" && status.source === scope
      ? {
          visible: true,
          enabled: false,
          label: "Clear",
          confirmLabel: `${provider} key`,
          reason: "Already cleared at this scope.",
          warning: null,
        }
      : {
          visible: true,
          enabled: true,
          label: "Clear",
          confirmLabel: `${provider} key`,
          reason: null,
          warning: null,
        };
  return {
    save: {
      visible: true,
      enabled: true,
      label: "Save",
      confirmLabel: null,
      reason: null,
      warning: null,
    },
    inherit,
    clear,
  };
}

function gitAuthPillState(status: GitAuthStatus): SettingsGitCredentialProps["state"] {
  return status.state;
}

function gitAuthSourceLine(status: GitAuthStatus): string {
  if (status.state === "set") {
    return `from ${settingsScopeLabel(status.source)}`;
  }
  if (status.state === "cleared") {
    return `Cleared at ${settingsScopeLabel(status.source)}`;
  }
  return "default";
}

function gitAuthMetadata(status: GitAuthStatus): string {
  if (status.state === "set" && status.kind === "ssh") {
    return status.publicKey;
  }
  if (status.state === "set" && status.kind === "https") {
    return status.hosts.join(", ");
  }
  if (status.state === "cleared") {
    return "Cleared";
  }
  if (status.state === "error") {
    return "Error";
  }
  return "Not set";
}

function gitAuthScopeDetails(
  scoped: Record<SettingsScope, GitAuthScopedState>,
  scope: SettingsScope,
): SettingsScopeDetailProps[] {
  if (scope === "global") {
    return [];
  }
  return applicableSettingsScopes(scope).map((entry) => {
    const state = scoped[entry] ?? "absent";
    return {
      scope: entry,
      label: settingsScopeLabel(entry),
      state: state === "absent" ? "absent" : state,
      stateLabel: state === "absent" ? "Inherited" : state === "cleared" ? "Cleared" : "Set",
      valueText: null,
    };
  });
}

function formatModelsText(models: readonly ModelProviderModel[]): string {
  return models
    .map((model) =>
      [
        model.id,
        String(model.limit.context),
        String(model.limit.output),
        ...(model.name === undefined ? [] : [model.name]),
      ].join(" | "),
    )
    .join("\n");
}

function providerRowId(provider: string): string {
  return `provider-${encodeURIComponent(provider)}`;
}

/* ------------------------------------------------------------------------- */
/* Labels                                                                   */
/* ------------------------------------------------------------------------- */

const LABELS: SettingsLabelsProps = {
  nav: {
    ariaLabel: "Settings",
    scopeLabel: "Settings scope",
    sectionsLabel: "Settings sections",
    scopes: {
      global: "Global",
      project: "Project",
      app: "Application",
      applicationShort: "App",
    },
    sections: {
      agent: "Agent",
      web: "Web tools",
      context: "Context",
      git: "Git",
      restart: "Restart",
    },
  },
  sections: {
    agent: "Agent",
    web: "Web tools",
    context: "Context",
    git: "Git",
    restart: "Restart & pending",
  },
  actions: {
    save: "Save",
    inherit: "Inherit",
    clear: "Clear",
    clearTitle: "Clear setting at this scope?",
    clearBody:
      "Wider scopes will no longer apply. The setting stays disabled until you set it again.",
    clearConfirm: "Clear setting",
    cancel: "Cancel",
    restartAgent: "Restart agent",
    testConnection: "Test connection",
  },
  providers: {
    title: "Providers",
    hint: "Keys are encrypted at rest and never shown again. A cleared key suppresses wider scopes and host auth.",
    empty: "No providers are referenced by the effective model or web tools.",
    addTitle: "Add provider key",
    keyLabel: "API key",
    providerLabel: "Provider",
    providerPlaceholder: "deepseek",
    changeKey: "Change key",
    masked: "Not shown",
  },
  modelProviders: {
    title: "Custom model providers",
    hint: "Global OpenAI-compatible endpoints. The API key stays in the Providers block.",
    empty: "No custom providers yet.",
    addTitle: "Add custom provider",
    globalHint: "Custom model providers are global.",
    manage: "Manage in Global settings",
    name: "Name",
    baseUrl: "Base URL",
    models: "Models",
    modelsHint: "One per line: id | context | output | optional name.",
    providerId: "Provider id",
    providerIdPlaceholder: "llm-lan",
    namePlaceholder: "LLM LAN",
    baseUrlPlaceholder: "http://gateway.example:4000/v1",
    modelsPlaceholder: "deepseek | 1000000 | 64000",
    deleteConfirmPrefix: "Delete provider",
    modelsCount: "models",
  },
  git: {
    title: "Git",
    badge: "Identity and credentials",
    noscript: "Git credential changes require JavaScript.",
    user: "User name",
    email: "User email",
    ssh: "SSH credential",
    https: "HTTPS credential",
    key: {
      overline: "Public key",
      fingerprint: "Fingerprint",
      knownHosts: "known_hosts",
      knownHostsSet: "Set — strict host checking.",
      knownHostsUnset: "Not set — accept-new (TOFU) on first connection.",
      allowedHosts: "Allowed hosts",
      username: "Username",
      cleared:
        "A tombstone at this scope suppresses wider credentials; nothing is materialized for the app.",
      missing:
        "No credential is set or inherited; git operations that need a remote credential fail closed.",
    },
    testApp:
      "Test connection checks the draft values against the remote without saving them. The agent must be running.",
    credentialCheck: "Credential check",
    credentialCheckHint: "Run the remote check from an application settings page.",
    appSettings: "Application settings",
    testHint:
      "Test connection checks the draft values against the remote without saving them. The agent must be running.",
    securityNotes:
      "Passphrase-protected SSH keys are not supported in v1; use an unencrypted deploy key. Without known_hosts, SSH uses accept-new (TOFU) on first connection. HTTPS hosts are mandatory and matched exactly; remote URLs with a different host fail closed. Use scoped deploy keys or fine-grained tokens with the least privilege — the agent can read its own materialized credentials.",
  },
  restart: {
    title: "Restart & pending",
    badge: "Restart",
    hint: "Settings changes apply only on an explicit restart. A restart interrupts an active turn; sessions are kept.",
    empty: "No running agents are waiting for a restart.",
    profileWarnings: "OMO profile warnings",
  },
  warnings: "Warnings",
};

/* ------------------------------------------------------------------------- */
/* Assembly                                                                 */
/* ------------------------------------------------------------------------- */

export interface SettingsBuildInput {
  readonly deps: HttpDeps;
  readonly site: SiteModel;
  readonly scope: SettingsScope;
  readonly target: SettingsTarget;
  readonly notice?: Notice | null;
}

export function buildSettingsProps(input: SettingsBuildInput): SettingsProps | undefined {
  const settings = input.deps.settings;
  if (settings === undefined) {
    return undefined;
  }
  const { scope, target, site } = input;
  const entities = settingsPageEntities(site, scope, target);
  if (entities === undefined) {
    return undefined;
  }
  const project = entities.project;
  const app = entities.app;
  const resolved: ResolvedSettings & { pendingRestart: PendingRestart[] } = {
    ...settings.resolve(target),
    pendingRestart: pendingFor(input.deps, scope, target),
  };
  const returnTo = settingsPagePath(scope, target);
  const customProviders: readonly ModelProvider[] = input.deps.modelProviders?.list() ?? [];
  const providerKeyIds = new Set(settings.allProviderIds());

  const title =
    scope === "global"
      ? "Settings"
      : scope === "project" && project !== undefined
        ? `${project.name} settings`
        : `${app?.appKey ?? ""} settings`;
  const description =
    scope === "global"
      ? "Coordinator-wide defaults for models, provider keys, and web tools. Narrower scopes can override them."
      : scope === "project"
        ? `Project overrides for ${project?.name ?? ""}. Application scopes can override these values.`
        : `Application overrides for ${app?.appKey ?? ""}. These values are the narrowest scope.`;
  const breadcrumb =
    scope === "global"
      ? [{ label: "Workbench", href: "/" }, { label: "Settings" }]
      : scope === "project"
        ? [
            { label: "Projects", href: "/projects" },
            {
              label: project?.name ?? "",
              href: `/projects/${encodeURIComponent(project?.id ?? "")}`,
            },
            { label: "Settings" },
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
            { label: "Settings" },
          ];

  const projectHref =
    target.projectId === undefined
      ? null
      : `/projects/${encodeURIComponent(target.projectId)}/settings`;
  const appHref =
    target.projectId === undefined || target.appKey === undefined
      ? null
      : `/projects/${encodeURIComponent(target.projectId)}/apps/${encodeURIComponent(target.appKey)}/settings`;
  const skillsHref =
    scope === "global"
      ? "/skills"
      : scope === "project"
        ? `/projects/${encodeURIComponent(target.projectId ?? "")}/skills`
        : `/projects/${encodeURIComponent(target.projectId ?? "")}/apps/${encodeURIComponent(target.appKey ?? "")}/skills`;

  const projects: SettingsProjectOptionProps[] = site.projects.map((entry) => ({
    value: entry.id,
    label: entry.name,
    href: `/projects/${encodeURIComponent(entry.id)}/settings`,
    current: scope === "project" && target.projectId === entry.id,
    projectId: entry.id,
    apps: entry.apps.map((candidate) => ({
      value: `${entry.id}:${candidate.appKey}`,
      label: `${entry.name} / ${candidate.appKey}`,
      href: `/projects/${encodeURIComponent(entry.id)}/apps/${encodeURIComponent(candidate.appKey)}/settings`,
      current:
        scope === "app" && target.projectId === entry.id && target.appKey === candidate.appKey,
      appKey: candidate.appKey,
    })),
  }));

  const scopeProps: SettingsScopeProps = {
    scope,
    scopeLabel: settingsScopeLabel(scope),
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    appKey: app?.appKey ?? null,
    appId: app?.id ?? null,
    href: returnTo,
    settingsHref: returnTo,
    skillsHref,
    title,
    description,
    breadcrumb,
    nav: {
      globalHref: "/settings",
      projectHref,
      appHref,
      projectCurrent: scope === "project",
      appCurrent: scope === "app",
      projectShortLabel: "Project",
      appShortLabel: "Application",
    },
    hrefs: {
      global: "/settings",
      project: projectHref,
      app: appHref,
    },
    projects,
  };

  const modelEffective = resolved.effective.llm.model;
  const searchEffective = resolved.effective.web.search;
  const fetchEffective = resolved.effective.web.fetch;
  const enabledEffective = resolved.effective.context.autoCompact.enabled;
  const percentEffective = resolved.effective.context.autoCompact.percent;
  const gitNameEffective = resolved.effective.git.user.name;
  const gitEmailEffective = resolved.effective.git.user.email;

  const modelRow = buildRow({
    id: "setting-llm-model",
    key: "llm.model",
    title: "Model",
    hint: "Selected model applies to new sessions and OMO agents; existing sessions may keep their model.",
    kind: "model",
    scope,
    target,
    resolved,
    effective: modelEffective,
    warnings:
      modelProviderWarning(resolved) === undefined
        ? []
        : [modelProviderWarning(resolved) as string],
    effectiveText: effectiveText(modelEffective),
    clearable: false,
    text: {
      value: stringPrefill(scope, ownValue(resolved, scope, "llm.model"), modelEffective).value,
      placeholder: stringPrefill(scope, ownValue(resolved, scope, "llm.model"), modelEffective)
        .placeholder,
      required: true,
      autocomplete: "off",
      listId: modelOptions(customProviders).length === 0 ? null : "model-options",
      options: modelOptions(customProviders),
    },
    returnTo: `${returnTo}#setting-llm-model`,
    errorSlotId: "setting-llm-model-error",
  });

  const searchRow = buildWebRow({
    id: "setting-web-search",
    key: "web.search",
    title: "Web search",
    hint: "Built-in uses the existing OMO/opencode tools. DeepSeek uses the managed hanse_web MCP server.",
    effective: searchEffective as EffectiveValue<{
      driver: "builtin" | "deepseek";
      options?: Record<string, unknown>;
    }>,
    resolved,
    scope,
    target,
    returnTo,
    warning: webToolWarning(
      "web.search",
      searchEffective as EffectiveValue<{
        driver: "builtin" | "deepseek";
        options?: { provider?: string };
      }>,
      resolved,
    ),
  });

  const fetchRow = buildWebRow({
    id: "setting-web-fetch",
    key: "web.fetch",
    title: "Web fetch",
    hint: "Built-in uses opencode webfetch. DeepSeek uses the managed hanse_web MCP server.",
    effective: fetchEffective as EffectiveValue<{
      driver: "builtin" | "deepseek";
      options?: Record<string, unknown>;
    }>,
    resolved,
    scope,
    target,
    returnTo,
    warning: webToolWarning(
      "web.fetch",
      fetchEffective as EffectiveValue<{
        driver: "builtin" | "deepseek";
        options?: { provider?: string };
      }>,
      resolved,
    ),
  });

  const enabledRow = buildEnabledRow({
    scope,
    target,
    resolved,
    effective: enabledEffective,
    returnTo,
  });
  const percentRow = buildPercentRow({
    scope,
    target,
    resolved,
    effective: percentEffective,
    returnTo,
  });
  const gitNameRow = buildIdentityRow({
    key: "git.user.name",
    id: "setting-git-user-name",
    rowId: "git-identity-name",
    inputId: "git-user-name",
    title: "User name",
    scope,
    target,
    resolved,
    effective: gitNameEffective,
    returnTo,
  });
  const gitEmailRow = buildIdentityRow({
    key: "git.user.email",
    id: "setting-git-user-email",
    rowId: "git-identity-email",
    inputId: "git-user-email",
    title: "User email",
    scope,
    target,
    resolved,
    effective: gitEmailEffective,
    returnTo,
  });

  const providerEntries = Object.entries(resolved.providerKeys).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const providers: SettingsProviderRowProps[] = providerEntries.map(
    ([provider, status], index) => ({
      provider,
      status,
      state: providerState(status),
      configured: providerConfigured(status),
      usable: providerUsable(status),
      masked: LABELS.providers.masked,
      effectiveText: providerStatusLabel(status),
      sourceLine: providerSourceLine(status),
      warning: status.state === "error" ? status.message : null,
      rowId: providerRowId(provider),
      errorSlotId: `provider-error-${index}`,
      actions: providerActions(status, scope, provider),
      form: formProps(
        scope,
        target,
        `${returnTo}#providers`,
        "/api/settings/provider",
        "Provider key updated.",
      ),
    }),
  );

  const modelProviders: SettingsModelProvidersProps = {
    providers: customProviders.map((provider, index) => {
      const keyStatus = resolved.providerKeys[provider.id] ?? ({ state: "missing" } as const);
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        models: provider.models,
        modelsText: formatModelsText(provider.models),
        warnings: [
          ...collisionWarnings(provider.id, providerKeyIds),
          ...providerBaseUrlWarnings(provider.baseUrl),
        ],
        key: {
          status: keyStatus,
          state: providerState(keyStatus),
          label: providerStatusLabel(keyStatus),
          masked: LABELS.providers.masked,
        },
        rowId: `custom-provider-${encodeURIComponent(provider.id)}`,
        nameInputId: `custom-provider-name-${index}`,
        urlInputId: `custom-provider-url-${index}`,
        modelsInputId: `custom-provider-models-${index}`,
        errorId: `custom-provider-error-${index}`,
        actions: {
          update: "/api/settings/model-providers",
          delete: "/api/settings/model-providers",
          returnTo: "/settings#custom-providers",
        },
      };
    }),
    count: customProviders.length,
    add: {
      action: "/api/settings/model-providers",
      returnTo: "/settings#custom-providers",
      errorId: "custom-provider-add-error",
    },
    manageHref: "/settings#custom-providers",
  };

  const git = buildGitProps({
    scope,
    target,
    resolved,
    returnTo,
    testAppPath: scope === "app" ? null : (firstAppSettingsPath(site, project?.id) ?? null),
  });

  const profileWarnings =
    scope === "app" && app !== undefined ? (input.deps.manager?.profileWarnings(app.id) ?? []) : [];
  const restart: SettingsRestartProps = {
    pending: resolved.pendingRestart.map((entry) => ({
      appId: entry.appId,
      appKey: entry.appKey,
      projectId: entry.projectId,
      reasons: entry.reasons,
      reasonLabels: entry.reasons.map(settingsRestartReason),
      href: `/projects/${encodeURIComponent(entry.projectId)}/apps/${encodeURIComponent(entry.appKey)}`,
      restartAction: `/api/apps/${encodeURIComponent(entry.appKey)}/restart?project=${encodeURIComponent(entry.projectId)}`,
      returnTo,
    })),
    restartRequired: resolved.pendingRestart.length > 0,
    profileWarnings,
    returnTo,
    hint: LABELS.restart.hint,
  };

  return {
    scope: scopeProps,
    effective: resolved.effective,
    scoped: resolved.scoped,
    providerKeys: resolved.providerKeys,
    gitAuth: resolved.gitAuth,
    gitAuthScoped: resolved.gitAuthScoped,
    warnings: resolved.warnings,
    pendingRestart: resolved.pendingRestart,
    notice: input.notice ?? null,
    rows: {
      model: modelRow,
      webSearch: searchRow,
      webFetch: fetchRow,
      contextEnabled: enabledRow,
      contextPercent: percentRow,
      gitName: gitNameRow,
      gitEmail: gitEmailRow,
    },
    providers,
    modelProviders,
    git,
    restart,
    labels: LABELS,
    dialogs: {
      clear: {
        id: "settings-clear-dialog",
        titleId: "settings-clear-title",
        metaId: "settings-clear-meta",
        bodyId: "settings-clear-body",
        formId: "settings-clear-form",
        action: "/api/settings",
        title: LABELS.actions.clearTitle,
        body: LABELS.actions.clearBody,
        fieldError: "field-error",
        cancel: LABELS.actions.cancel,
        submit: LABELS.actions.clearConfirm,
      },
    },
    dirty: false,
    restartRequired: resolved.pendingRestart.length > 0,
  };
}

function modelOptions(providers: readonly ModelProvider[]): string[] {
  return [
    ...new Set(
      providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`)),
    ),
  ].sort();
}

function buildRow(options: {
  id: string;
  key: string;
  title: string;
  hint: string | null;
  kind: SettingsRowKind;
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings;
  effective: EffectiveValue<unknown>;
  warnings: readonly string[];
  effectiveText: string;
  clearable: boolean;
  globalWarning?: boolean;
  text?: SettingsTextControlProps;
  select?: SettingsSelectControlProps;
  number?: SettingsNumberControlProps;
  driver?: SettingsDriverControlProps;
  inheritedNote?: string | null;
  returnTo: string;
  errorSlotId: string;
}): SettingsRowProps {
  const own = ownValue(options.resolved, options.scope, options.key);
  return {
    id: options.id,
    key: options.key,
    title: options.title,
    hint: options.hint,
    kind: options.kind,
    effective: {
      value: options.effective.value,
      state: options.effective.state,
      source: options.effective.source,
      sources: options.effective.sources,
      text: options.effectiveText,
      sourceLine: sourceLine(options.effective),
    },
    effectiveText: options.effectiveText,
    sourceLine: sourceLine(options.effective),
    own,
    warnings: options.warnings,
    scopeDetails: scopeDetailsFor(options.resolved, options.scope, options.key),
    actions: rowActions({
      scope: options.scope,
      ownState: own.state,
      effective: options.effective,
      label: options.title,
      clearable: options.clearable,
      globalWarning: options.globalWarning === true,
    }),
    form: formProps(
      options.scope,
      options.target,
      options.returnTo,
      "/api/settings",
      "Settings saved.",
    ),
    text: options.text ?? null,
    select: options.select ?? null,
    number: options.number ?? null,
    driver: options.driver ?? null,
    inheritedNote: options.inheritedNote ?? null,
    errorSlotId: options.errorSlotId,
  };
}

function buildWebRow(options: {
  id: string;
  key: string;
  title: string;
  hint: string;
  effective: EffectiveValue<{ driver: "builtin" | "deepseek"; options?: Record<string, unknown> }>;
  resolved: ResolvedSettings;
  scope: SettingsScope;
  target: SettingsTarget;
  returnTo: string;
  warning: string | undefined;
}): SettingsRowProps {
  const own = ownValue(options.resolved, options.scope, options.key);
  const current = ownWebValue(options.resolved, options.scope, options.key);
  const driver = current?.driver;
  const placeholder = driver === undefined ? selectOption("", "Choose a driver", true, true) : null;
  const choices = webDriverDefinitions.map((definition) =>
    selectOption(definition.id, definition.label, driver === definition.id),
  );
  const options_ =
    (current as { driver: "builtin" | "deepseek"; options?: Record<string, unknown> } | null)
      ?.options ?? {};
  const deepseekVisible = driver === "deepseek";
  const fields: SettingsDriverFieldProps[] = DEEPSEEK_FIELDS.map((field) => {
    const raw = options_[field.name];
    return {
      name: field.name,
      label: field.label,
      type: field.type === "checkbox" ? "checkbox" : field.type === "number" ? "number" : "text",
      min: field.min ?? null,
      max: field.max ?? null,
      placeholder: field.placeholder ?? null,
      value: field.type === "checkbox" ? "1" : raw === undefined ? "" : String(raw),
      checked: field.type === "checkbox" && raw === true,
      required: field.required === true && deepseekVisible,
    };
  });
  const effectiveValue = options.effective.value;
  const effectiveTextValue =
    effectiveValue === null ? effectiveText(options.effective) : effectiveValue.driver;
  const inheritedNote =
    options.scope !== "global" && own.state === "absent" && options.effective.value !== null
      ? `This scope inherits ${options.effective.value.driver} from ${sourceName(options.effective.source)}. Saving creates an override.`
      : null;
  return buildRow({
    id: options.id,
    key: options.key,
    title: options.title,
    hint: options.hint,
    kind: "web",
    scope: options.scope,
    target: options.target,
    resolved: options.resolved,
    effective: options.effective,
    warnings: options.warning === undefined ? [] : [options.warning],
    effectiveText: effectiveTextValue,
    clearable: true,
    globalWarning: true,
    driver: {
      options: choices,
      placeholder,
      fields,
      showFields: deepseekVisible,
    },
    inheritedNote,
    returnTo: `${options.returnTo}#${options.key.replace(/\./g, "-")}`,
    errorSlotId: `${options.id}-error`,
  });
}

function buildEnabledRow(options: {
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings;
  effective: EffectiveValue<boolean>;
  returnTo: string;
}): SettingsRowProps {
  const own = ownValue(options.resolved, options.scope, "context.auto_compact.enabled");
  const prefill =
    own.state === "set" && typeof own.value === "boolean" ? (own.value ? "true" : "false") : "";
  const placeholder =
    prefill.length > 0
      ? null
      : selectOption(
          "",
          `${options.scope === "global" ? "Default" : "Inherited"}: ${options.effective.value === true ? "On" : "Off"}`,
          true,
          true,
        );
  return buildRow({
    id: "setting-context-auto-compact",
    key: "context.auto_compact.enabled",
    title: "Auto-compaction",
    hint: "Automatically compacts top-level sessions when context usage crosses the threshold. Live; no restart is required.",
    kind: "context-enabled",
    scope: options.scope,
    target: options.target,
    resolved: options.resolved,
    effective: options.effective,
    warnings: [],
    effectiveText: options.effective.value === true ? "On" : "Off",
    clearable: false,
    select: {
      options: [
        selectOption("true", "On", prefill === "true"),
        selectOption("false", "Off", prefill === "false"),
      ],
      placeholder,
    },
    returnTo: `${options.returnTo}#setting-context-auto-compact`,
    errorSlotId: "setting-context-auto-compact-error",
  });
}

function buildPercentRow(options: {
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings;
  effective: EffectiveValue<number>;
  returnTo: string;
}): SettingsRowProps {
  const own = ownValue(options.resolved, options.scope, "context.auto_compact.percent");
  const value = own.state === "set" && typeof own.value === "number" ? String(own.value) : "";
  const effectivePercent = options.effective.value ?? 80;
  const placeholder =
    value.length > 0
      ? ""
      : `${options.scope === "global" ? "Default" : "Inherited"}: ${effectivePercent}%`;
  return buildRow({
    id: "setting-context-auto-compact-percent",
    key: "context.auto_compact.percent",
    title: "Auto-compaction threshold",
    hint: "Percentage of the model context window used when auto-compaction is on. opencode's own overflow compaction remains a fallback.",
    kind: "context-percent",
    scope: options.scope,
    target: options.target,
    resolved: options.resolved,
    effective: options.effective,
    warnings: [],
    effectiveText:
      options.effective.value === null
        ? effectiveText(options.effective)
        : `${options.effective.value}%`,
    clearable: false,
    number: { value, placeholder, min: 1, max: 99, step: 1, required: true },
    returnTo: `${options.returnTo}#setting-context-auto-compact-percent`,
    errorSlotId: "setting-context-auto-compact-percent-error",
  });
}

function buildIdentityRow(options: {
  key: "git.user.name" | "git.user.email";
  id: string;
  rowId: string;
  inputId: string;
  title: string;
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings;
  effective: EffectiveValue<string | null>;
  returnTo: string;
}): SettingsRowProps {
  const own = ownValue(options.resolved, options.scope, options.key);
  const prefill = stringPrefill(options.scope, own, options.effective);
  return {
    ...buildRow({
      id: options.id,
      key: options.key,
      title: options.title,
      hint: null,
      kind: "git-identity",
      scope: options.scope,
      target: options.target,
      resolved: options.resolved,
      effective: options.effective,
      warnings: [],
      effectiveText: effectiveText(options.effective),
      clearable: true,
      text: {
        value: prefill.value,
        placeholder: prefill.placeholder,
        required: false,
        autocomplete: "off",
        listId: null,
        options: [],
      },
      returnTo: `${options.returnTo}#${options.rowId}`,
      errorSlotId: `${options.rowId}-error`,
    }),
    id: options.id,
  };
}

function buildGitProps(options: {
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings;
  returnTo: string;
  testAppPath: string | null;
}): SettingsGitProps {
  const credential = (kind: GitAuthKind, title: string): SettingsGitCredentialProps => {
    const status = options.resolved.gitAuth[kind];
    const scoped = options.resolved.gitAuthScoped[kind];
    const scopedState = scoped[options.scope] ?? "absent";
    const inheritReason =
      options.scope === "global" || scopedState !== "absent"
        ? null
        : status.state === "set" || status.state === "cleared"
          ? `Already inherited from ${settingsScopeLabel(status.source)}.`
          : "No credential is set at this scope.";
    const clearReason = scopedState === "cleared" ? "Already cleared at this scope." : null;
    const allowTest = options.scope === "app";
    return {
      kind,
      title,
      status,
      state: gitAuthPillState(status),
      configured: status.state === "set",
      hasSecret: status.state === "set",
      masked: LABELS.providers.masked,
      effectiveText: gitAuthMetadata(status),
      sourceLine: gitAuthSourceLine(status),
      scopedState,
      scoped,
      scopeDetails: gitAuthScopeDetails(scoped, options.scope),
      allowTest,
      inheritReason,
      clearReason,
      details: {
        publicKey: status.state === "set" && status.kind === "ssh" ? status.publicKey : null,
        fingerprint: status.state === "set" && status.kind === "ssh" ? status.fingerprint : null,
        hasKnownHosts:
          status.state === "set" && status.kind === "ssh" ? status.hasKnownHosts : null,
        hosts: status.state === "set" && status.kind === "https" ? status.hosts : null,
        username: status.state === "set" && status.kind === "https" ? status.username : null,
        error: status.state === "error" ? status.message : null,
      },
      actions: {
        action: "/api/settings/git",
        test: allowTest ? "/api/settings/git" : null,
        allowTest,
      },
      form: formProps(
        options.scope,
        options.target,
        `${options.returnTo}#setting-git-${kind}`,
        "/api/settings/git",
        "Settings saved.",
      ),
    };
  };
  return {
    identity: [],
    ssh: credential("ssh", LABELS.git.ssh),
    https: credential("https", LABELS.git.https),
    testAppPath: options.testAppPath,
    testCheck: {
      hint: options.scope === "app" ? LABELS.git.testHint : LABELS.git.credentialCheckHint,
      href: options.scope === "app" ? null : options.testAppPath,
    },
    securityNotes: LABELS.git.securityNotes,
  };
}
