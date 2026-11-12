/**
 * Pure view-model helpers for the settings console.
 *
 * The server props stay unchanged; this module derives the console metadata, the per-row G/P/A
 * scope trace, the four-cell page summary, and the scope-count ladder from the existing settings
 * shape. Every function is pure so the page and the unit tests share one source of truth.
 */

import type {
  SettingsProps,
  SettingsRowProps,
  SettingsScope,
  SettingsScopeState,
} from "./settings-types.js";

export type SettingsSectionId = "agent" | "web" | "context" | "notifications" | "git" | "restart";

export interface SettingsSectionEntry {
  readonly id: SettingsSectionId;
  readonly icon: string;
  readonly order: number;
  /** Short pane subtitle; the section title comes from `props.labels.sections`. */
  readonly description: string;
}

/** The six real settings sections, ordered as the rail renders them. */
export const SETTINGS_SECTIONS: readonly SettingsSectionEntry[] = [
  {
    id: "agent",
    icon: "cpu",
    order: 0,
    description: "Choose the model new sessions use, and manage the provider key that backs it.",
  },
  {
    id: "web",
    icon: "globe",
    order: 1,
    description:
      "Route web search and fetch through the built-in tools or the managed DeepSeek driver.",
  },
  {
    id: "context",
    icon: "layers",
    order: 2,
    description: "Auto-compaction keeps long sessions within the model context window.",
  },
  {
    id: "notifications",
    icon: "bell",
    order: 3,
    description: "Telegram delivery for turn completion and attention events.",
  },
  {
    id: "git",
    icon: "git",
    order: 4,
    description: "Commit identity and credentials for remotes.",
  },
  {
    id: "restart",
    icon: "refresh",
    order: 5,
    description: "Settings apply on the next start; restart a waiting agent here.",
  },
] as const;

/** Launch-effective keys: changing them makes a running agent require a restart. */
export const RESTART_AFFECTING_KEYS: ReadonlySet<string> = new Set([
  "llm.model",
  "web.search",
  "web.fetch",
  "git.user.name",
  "git.user.email",
]);

/** Registry keys counted by `pageSummary` and `scopeCounts` (13 keys). */
const REGISTRY_KEYS: readonly string[] = [
  "llm.model",
  "web.search",
  "web.fetch",
  "context.auto_compact.enabled",
  "context.auto_compact.percent",
  "git.user.name",
  "git.user.email",
  "notifications.mode",
  "notifications.telegram.enabled",
  "notifications.telegram.chat_id",
  "notifications.public_base_url",
  "notifications.telegram.api_base_url",
  "notifications.include_answer",
];

const SCOPE_ORDER: readonly SettingsScope[] = ["global", "project", "app"];
const SCOPE_LETTER: Readonly<Record<SettingsScope, string>> = {
  global: "G",
  project: "P",
  app: "A",
};
const SCOPE_LABEL: Readonly<Record<SettingsScope, string>> = {
  global: "Global",
  project: "Project",
  app: "Application",
};
const GIT_KINDS = ["ssh", "https"] as const;

/** Scopes that exist for a page at the given scope. */
export function applicableScopes(scope: SettingsScope): readonly SettingsScope[] {
  return scope === "global"
    ? ["global"]
    : scope === "project"
      ? ["global", "project"]
      : SCOPE_ORDER;
}

/** All 13 registry rows in a stable order. Dynamic providers are deliberately excluded. */
export function registryRows(props: SettingsProps): readonly SettingsRowProps[] {
  return [
    props.rows.model,
    props.rows.webSearch,
    props.rows.webFetch,
    props.rows.contextEnabled,
    props.rows.contextPercent,
    props.rows.gitName,
    props.rows.gitEmail,
    props.notifications.rows.mode,
    props.notifications.rows.telegramEnabled,
    props.notifications.rows.chatId,
    props.notifications.rows.publicBaseUrl,
    props.notifications.rows.apiBaseUrl,
    props.notifications.rows.includeAnswer,
  ];
}

export type TraceStepState = "filled" | "cleared" | "hollow";

export interface TraceStep {
  readonly scope: SettingsScope;
  readonly letter: string;
  readonly label: string;
  readonly state: TraceStepState;
  readonly winning: boolean;
}

export interface RowTrace {
  readonly steps: readonly TraceStep[];
  /** Accessible text equivalent of the visual steps. */
  readonly text: string;
}

function traceState(state: SettingsScopeState): TraceStepState {
  if (state === "set") {
    return "filled";
  }
  return state === "cleared" ? "cleared" : "hollow";
}

function traceStep(scope: SettingsScope, state: TraceStepState, winning: boolean): TraceStep {
  return { scope, letter: SCOPE_LETTER[scope], label: SCOPE_LABEL[scope], state, winning };
}

function traceStateWord(state: TraceStepState): string {
  return state === "filled" ? "set" : state === "cleared" ? "cleared" : "not set";
}

function traceText(steps: readonly TraceStep[]): string {
  const parts = steps.map(
    (step) => `${step.label} ${traceStateWord(step.state)}${step.winning ? " and wins" : ""}`,
  );
  return `Scope trace: ${parts.join("; ")}.`;
}

/**
 * G/P/A scope trace for one row.
 *
 * Project/app pages carry one `scopeDetails` entry per applicable scope. The global page has no
 * wider scopes, so it synthesizes a single step from the row's current-scope state instead of
 * inventing Project/Application values.
 */
export function rowTrace(row: SettingsRowProps, pageScope: SettingsScope): RowTrace {
  if (row.scopeDetails.length === 0) {
    const step = traceStep(
      pageScope,
      traceState(row.own.state),
      row.effective.source === pageScope,
    );
    return { steps: [step], text: traceText([step]) };
  }
  const steps = row.scopeDetails.map((detail) =>
    traceStep(detail.scope, traceState(detail.state), row.effective.source === detail.scope),
  );
  return { steps, text: traceText(steps) };
}

export interface PageSummary {
  readonly setHere: number;
  readonly inherited: number;
  readonly attention: number;
  readonly restartPending: number;
}

function attentionMessages(props: SettingsProps): readonly string[] {
  const messages: string[] = [];
  const add = (message: string | null): void => {
    if (message !== null && message.trim().length > 0) {
      messages.push(message);
    }
  };
  for (const warning of props.warnings) {
    add(warning);
  }
  add(props.notifications.warning);
  for (const row of registryRows(props)) {
    for (const warning of row.warnings) {
      add(warning);
    }
  }
  for (const row of props.git.identity) {
    for (const warning of row.warnings) {
      add(warning);
    }
  }
  for (const provider of props.providers) {
    add(provider.warning);
  }
  for (const provider of props.modelProviders.providers) {
    for (const warning of provider.warnings) {
      add(warning);
    }
  }
  for (const kind of GIT_KINDS) {
    const status = props.git[kind].status;
    if (status.state === "error") {
      add(status.message);
    }
    add(props.git[kind].details.error);
  }
  for (const warning of props.restart.profileWarnings) {
    add(warning);
  }
  return [...new Set(messages)];
}

/**
 * Four-cell summary.
 *
 * - `setHere`: values explicitly set at the current scope.
 * - `inherited`: current-scope state absent and resolved from a wider scope or a default; a
 *   cleared value at any scope counts as neither.
 * - `attention`: deduplicated warning/error messages across storage, notifications, rows,
 *   providers, model providers, git, and restart profile warnings.
 * - `restartPending`: the number of agents in `restart.pending`; when that list is empty but
 *   `restartRequired` is set, count one pending restart rather than showing zero.
 */
export function pageSummary(props: SettingsProps): PageSummary {
  const scope = props.scope.scope;
  let setHere = 0;
  let inherited = 0;
  for (const row of registryRows(props)) {
    if (row.own.state === "set") {
      setHere += 1;
    } else if (row.own.state === "absent" && row.effective.state === "set") {
      inherited += 1;
    }
  }
  for (const kind of GIT_KINDS) {
    const state = props.gitAuthScoped[kind][scope];
    if (state === "set") {
      setHere += 1;
    } else if (state === "absent" && props.git[kind].status.state === "set") {
      inherited += 1;
    }
  }
  for (const secret of [
    props.notifications.secrets.botToken,
    props.notifications.secrets.proxyUrl,
  ]) {
    if (secret.status.state === "set") {
      if (secret.status.source === scope) {
        setHere += 1;
      } else {
        inherited += 1;
      }
    }
  }
  const restartPending =
    props.restart.pending.length > 0 ? props.restart.pending.length : props.restartRequired ? 1 : 0;
  return {
    setHere,
    inherited,
    attention: attentionMessages(props).length,
    restartPending,
  };
}

/**
 * Set-value counts per applicable scope for the scope ladder. Scopes outside the current target
 * return `null` so the UI hides the count instead of inventing one.
 */
export function scopeCounts(props: SettingsProps): Record<SettingsScope, number | null> {
  const counts: Record<SettingsScope, number | null> = { global: null, project: null, app: null };
  const current = props.scope.scope;
  for (const scope of applicableScopes(current)) {
    let count = 0;
    for (const key of REGISTRY_KEYS) {
      if (props.scoped[`${scope}:${key}`]?.state === "set") {
        count += 1;
      }
    }
    for (const kind of GIT_KINDS) {
      if (props.gitAuthScoped[kind][scope] === "set") {
        count += 1;
      }
    }
    for (const secret of [
      props.notifications.secrets.botToken,
      props.notifications.secrets.proxyUrl,
    ]) {
      if (secret.status.state === "set" && secret.status.source === scope) {
        count += 1;
      }
    }
    counts[scope] = count;
  }
  return counts;
}

/** Whether a row should show the subtle restart marker in its summary. */
export function showsRestartMarker(props: SettingsProps, row: SettingsRowProps): boolean {
  return props.restartRequired && row.own.state === "set" && RESTART_AFFECTING_KEYS.has(row.key);
}

function overridesHere(rows: readonly SettingsRowProps[]): number {
  return rows.filter((row) => row.own.state === "set").length;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Short, data-driven rail summary for each section. */
export function sectionSummaries(props: SettingsProps): Record<SettingsSectionId, string> {
  const model = props.rows.model.effectiveText;
  const modelOverrides = overridesHere([props.rows.model]);
  const web = props.rows.webSearch.effectiveText;
  const webOverrides = overridesHere([props.rows.webSearch, props.rows.webFetch]);
  const contextOn = props.rows.contextEnabled.effectiveText === "On";
  const notificationIssue =
    props.notifications.warning !== null ||
    props.notifications.rows.mode.warnings.length > 0 ||
    props.notifications.rows.telegramEnabled.warnings.length > 0;
  const gitOverrides = overridesHere([props.rows.gitName, props.rows.gitEmail]);
  const gitMissing = GIT_KINDS.filter((kind) => props.git[kind].status.state === "missing").length;
  const pending = props.restart.pending.length;
  return {
    agent:
      modelOverrides > 0 ? `${model} · ${plural(modelOverrides, "override", "overrides")}` : model,
    web: webOverrides > 0 ? `${web} · ${plural(webOverrides, "override", "overrides")}` : web,
    context: contextOn ? "Auto-compaction on" : "Auto-compaction off",
    notifications: props.notifications.enabled
      ? `Telegram on${notificationIssue ? " · issue" : ""}`
      : "Telegram off",
    git:
      gitOverrides > 0 || gitMissing > 0
        ? `${plural(gitOverrides, "override", "overrides")}${gitMissing > 0 ? ` · ${gitMissing} missing` : ""}`
        : "No overrides",
    restart: pending > 0 ? `${plural(pending, "agent", "agents")} waiting` : "Nothing pending",
  };
}

/**
 * Section that should own the summary's attention link. The first warning source wins, falling
 * back to the restart pane where page-level storage warnings are listed.
 */
export function attentionSection(props: SettingsProps): SettingsSectionId {
  const rowSection: Partial<Record<string, SettingsSectionId>> = {
    "llm.model": "agent",
    "web.search": "web",
    "web.fetch": "web",
    "context.auto_compact.enabled": "context",
    "context.auto_compact.percent": "context",
    "git.user.name": "git",
    "git.user.email": "git",
    "notifications.mode": "notifications",
    "notifications.telegram.enabled": "notifications",
    "notifications.telegram.chat_id": "notifications",
    "notifications.public_base_url": "notifications",
    "notifications.telegram.api_base_url": "notifications",
    "notifications.include_answer": "notifications",
  };
  for (const row of registryRows(props)) {
    if (row.warnings.length > 0) {
      return rowSection[row.key] ?? "restart";
    }
  }
  if (props.notifications.warning !== null) {
    return "notifications";
  }
  if (props.providers.some((provider) => provider.warning !== null)) {
    return "agent";
  }
  if (props.modelProviders.providers.some((provider) => provider.warnings.length > 0)) {
    return "agent";
  }
  if (
    props.git.ssh.status.state === "error" ||
    props.git.https.status.state === "error" ||
    props.git.ssh.details.error !== null ||
    props.git.https.details.error !== null
  ) {
    return "git";
  }
  return "restart";
}

/**
 * Map a location hash (including legacy detail anchors) to the section that owns it. Unknown
 * hashes return `undefined` so the page can keep its current section.
 */
export function sectionForHash(hash: string): SettingsSectionId | undefined {
  const value = hash.replace(/^#/, "");
  if (value.length === 0) {
    return undefined;
  }
  if (value.startsWith("settings-")) {
    const id = value.slice("settings-".length);
    if (isSectionId(id)) {
      return id;
    }
  }
  if (value === "providers" || value === "custom-providers" || value.startsWith("setting-llm")) {
    return "agent";
  }
  if (value.startsWith("setting-web")) {
    return "web";
  }
  if (value.startsWith("setting-context")) {
    return "context";
  }
  if (value.startsWith("setting-notifications") || value.startsWith("telegram-")) {
    return "notifications";
  }
  if (
    value.startsWith("setting-git") ||
    value.startsWith("git-") ||
    value === "settings-git-credentials"
  ) {
    return "git";
  }
  if (
    value.startsWith("restart-") ||
    value.startsWith("pending-") ||
    value.startsWith("profile-") ||
    value === "settings-warnings"
  ) {
    return "restart";
  }
  return undefined;
}

function isSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((entry) => entry.id === value);
}
