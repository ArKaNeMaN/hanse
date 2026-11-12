<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import SettingsConfirmDialog from "../components/SettingsConfirmDialog.vue";
import SettingsGitSection from "../components/SettingsGitSection.vue";
import SettingsModelProviderSection from "../components/SettingsModelProviderSection.vue";
import SettingsProviderSection from "../components/SettingsProviderSection.vue";
import SettingsRestartSection from "../components/SettingsRestartSection.vue";
import SettingsRow from "../components/SettingsRow.vue";
import SettingsTelegramSection from "../components/SettingsTelegramSection.vue";
import SmartLink from "../components/SmartLink.vue";
import { usePageChrome } from "../composables/usePageChrome.js";
import { useWorkspaceShell } from "../composables/useWorkspaceShell.js";
import type {
  SettingsProps,
  SettingsResponse,
  SettingsRowProps,
  SettingsScope,
} from "../settings-types.js";
import {
  attentionSection,
  pageSummary,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  scopeCounts,
  sectionForHash,
  sectionSummaries,
} from "../settings-view.js";
import { useToastStore } from "../stores/toasts.js";

type SettingsRouteId = "settings-global" | "settings-project" | "settings-app";

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

useWorkspaceShell("page--settings-console");

function queryString(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

function routeScopeId(): SettingsRouteId | undefined {
  const name = route.name;
  if (name === "settings-global" || name === "settings-project" || name === "settings-app") {
    return name;
  }
  return undefined;
}

function scopeForId(id: SettingsRouteId): SettingsScope {
  return id === "settings-global" ? "global" : id === "settings-project" ? "project" : "app";
}

const routeScope = computed<SettingsScope>(() => {
  const id = routeScopeId();
  return id === undefined ? "global" : scopeForId(id);
});
const routeProjectId = computed(() => queryString(route.params.id));
const routeAppKey = computed(() => queryString(route.params.app));

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function expectedHref(): string {
  if (routeScope.value === "global") {
    return "/settings";
  }
  if (routeScope.value === "project") {
    return `/projects/${encoded(routeProjectId.value)}/settings`;
  }
  return `/projects/${encoded(routeProjectId.value)}/apps/${encoded(routeAppKey.value)}/settings`;
}

const bootProps = computed<SettingsProps | undefined>(() => {
  const id = routeScopeId();
  if (id === undefined || props.boot.route.id !== id) {
    return undefined;
  }
  const value = props.boot.props;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as SettingsProps;
  return candidate.scope?.href === expectedHref() ? candidate : undefined;
});

const apiPath = computed(() => {
  const params = new URLSearchParams({ scope: routeScope.value });
  if (routeScope.value !== "global") {
    params.set("project", routeProjectId.value);
  }
  if (routeScope.value === "app") {
    params.set("app", routeAppKey.value);
  }
  return `/api/ui/settings?${params.toString()}`;
});

const settingsQuery = useQuery<SettingsResponse>({
  queryKey: computed(() => [
    "settings",
    routeScope.value,
    routeScope.value === "global" ? "" : routeProjectId.value,
    routeScope.value === "app" ? routeAppKey.value : "",
  ]),
  queryFn: () => apiQuery<SettingsResponse>(apiPath.value),
  initialData: () => bootProps.value,
  staleTime: 30_000,
  retry: false,
  refetchOnWindowFocus: false,
});

const { refreshing: visibilityRefreshing } = usePageChrome(settingsQuery, props.boot);

const view = computed<SettingsProps | undefined>(() => settingsQuery.data.value ?? bootProps.value);
const loading = computed(() => settingsQuery.isFetching.value);
const failed = computed(() => settingsQuery.isError.value);
const notFound = computed(() => {
  const error = settingsQuery.error.value;
  return error instanceof ApiError && error.status === 404;
});
const failure = computed(() => {
  const error = settingsQuery.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load settings.";
});

const busyRow = ref<string | null>(null);
const dirtyRows = ref<ReadonlySet<string>>(new Set());
const pendingClear = ref<SettingsRowProps | null>(null);

const targetValue = computed(() => view.value?.scope.href ?? "");

const summary = computed(() => (view.value === undefined ? undefined : pageSummary(view.value)));
const counts = computed(() => (view.value === undefined ? undefined : scopeCounts(view.value)));
const summaries = computed(() =>
  view.value === undefined ? undefined : sectionSummaries(view.value),
);
const attentionTarget = computed<SettingsSectionId>(() =>
  view.value === undefined ? "restart" : attentionSection(view.value),
);

function hashSection(): SettingsSectionId {
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  return sectionForHash(hash) ?? "agent";
}

const activeSection = ref<SettingsSectionId>(hashSection());

const scopeChain = computed(() => {
  const current = view.value?.scope.scope;
  if (view.value === undefined || current === undefined) {
    return [];
  }
  const scopes: readonly SettingsScope[] =
    current === "global"
      ? ["global"]
      : current === "project"
        ? ["global", "project"]
        : ["global", "project", "app"];
  return scopes.map((scope) => ({
    scope,
    label: view.value?.labels.nav.scopes[scope] ?? scope,
    count: counts.value?.[scope] ?? null,
    current: scope === current,
  }));
});

function sectionLabel(id: SettingsSectionId): string {
  return view.value?.labels.sections[id] ?? id;
}

function sectionDescription(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((entry) => entry.id === id)?.description ?? "";
}

function paneSummary(id: SettingsSectionId): string {
  return summaries.value?.[id] ?? "";
}

function countLabel(count: number): string {
  return count === 1 ? "value" : "values";
}

function scrollActiveRail(): void {
  const item = document.querySelector<HTMLElement>(
    ".settings-console__rail-item[aria-current='page']",
  );
  const nav = item?.parentElement;
  if (item === null || item === undefined || nav === null || nav === undefined) {
    return;
  }
  if (typeof nav.scrollTo !== "function" || nav.scrollWidth <= nav.clientWidth) {
    return;
  }
  nav.scrollTo({
    left: item.offsetLeft - nav.clientWidth / 2 + item.clientWidth / 2,
    behavior: "smooth",
  });
}

function selectSection(id: SettingsSectionId): void {
  activeSection.value = id;
  if (typeof window === "undefined") {
    return;
  }
  const hash = `#settings-${id}`;
  if (window.location.hash !== hash) {
    window.history.replaceState(null, "", hash);
  }
  void nextTick(scrollActiveRail);
}

function onHashChange(): void {
  activeSection.value = hashSection();
}

onMounted(() => {
  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("resize", scrollActiveRail);
    void nextTick(scrollActiveRail);
  }
});

onBeforeUnmount(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("resize", scrollActiveRail);
  }
});

async function refreshChromeAndProps(): Promise<void> {
  await settingsQuery.refetch();
}

async function refreshPage(): Promise<void> {
  await refreshChromeAndProps();
}

function markDirty(row: SettingsRowProps): void {
  if (dirtyRows.value.has(row.key)) {
    return;
  }
  const next = new Set(dirtyRows.value);
  next.add(row.key);
  dirtyRows.value = next;
}

function clearDirty(row: SettingsRowProps): void {
  if (!dirtyRows.value.has(row.key)) {
    return;
  }
  const next = new Set(dirtyRows.value);
  next.delete(row.key);
  dirtyRows.value = next;
}

function targetBody(row: SettingsRowProps): Record<string, unknown> {
  const scope = view.value?.scope;
  if (scope === undefined) {
    return {};
  }
  return {
    scope: scope.scope,
    ...(scope.scope === "global" ? {} : { projectId: scope.projectId ?? "" }),
    ...(scope.scope === "app" ? { appKey: scope.appKey ?? "" } : {}),
    key: row.key,
  };
}

async function mutateRow(
  row: SettingsRowProps,
  action: "set" | "inherit" | "clear",
  value?: unknown,
): Promise<void> {
  if (busyRow.value !== null) {
    return;
  }
  busyRow.value = row.key;
  try {
    await apiMutation(row.form.action, {
      json: { ...targetBody(row), action, ...(action === "set" ? { value } : {}) },
    });
    pendingClear.value = null;
    clearDirty(row);
    toasts.push(action === "clear" ? "Setting cleared." : row.form.successNotice, "success");
    await refreshChromeAndProps().catch((error: unknown) => {
      const message =
        error instanceof ApiError || error instanceof Error
          ? error.message
          : "The page could not be refreshed after saving.";
      toasts.push(message, "error");
    });
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not save the setting.";
    toasts.push(message, "error");
  } finally {
    busyRow.value = null;
  }
}

function onSectionChanged(message: string): void {
  toasts.push(message, "success");
  void refreshChromeAndProps().catch((error: unknown) => {
    const failure =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "The page could not be refreshed after saving.";
    toasts.push(failure, "error");
  });
}

async function confirmClearRow(): Promise<void> {
  const row = pendingClear.value;
  if (row === null || busyRow.value !== null) {
    return;
  }
  await mutateRow(row, "clear");
}

function navigateTarget(event: Event): void {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  const value = select.value;
  if (value.length > 0) {
    void router.push(value);
  }
}

function navigateScope(scope: SettingsScope): void {
  const hrefs = view.value?.scope.hrefs;
  if (hrefs === undefined) {
    return;
  }
  const href = hrefs[scope];
  if (href !== null) {
    void router.push(href);
  }
}

watch(
  () => view.value?.scope.href,
  () => {
    dirtyRows.value = new Set();
    activeSection.value = hashSection();
  },
);
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Settings</p>
      <h1 class="page-title">{{ view?.scope.title ?? "Settings" }}</h1>
      <p class="page-description">{{ view?.scope.description ?? "Coordinator settings." }}</p>
      <div
        v-if="view !== undefined && (dirtyRows.size > 0 || (loading && !visibilityRefreshing))"
        class="page-meta"
      >
        <span v-if="dirtyRows.size > 0" class="mono" role="status">Unsaved changes</span>
        <span v-if="loading && !visibilityRefreshing" class="mono" role="status" aria-live="polite">
          Updating settings…
        </span>
      </div>
    </div>
    <div class="page-header__actions">
      <button class="btn btn-secondary" type="button" @click="refreshPage">
        <AppIcon name="refresh" />Refresh
      </button>
      <SmartLink v-if="view !== undefined" class="btn btn-secondary" :to="view.scope.skillsHref">
        Skills
      </SmartLink>
    </div>

    <div v-if="view !== undefined" class="settings-scope">
      <div class="settings-scope__picker">
        <span class="overline">Scope</span>
        <span v-if="view.scope.scope === 'global'" class="settings-scope__global">
          All projects and applications
        </span>
        <form v-else class="settings-scope__target" @submit.prevent>
          <label class="sr-only" for="settings-target">Scope target</label>
          <div class="select-wrap">
            <select
              id="settings-target"
              class="select select-sm"
              :value="targetValue"
              name="target"
              @change="navigateTarget"
            >
              <option value="">Choose a project or application…</option>
              <optgroup
                v-for="project in view.scope.projects"
                :key="project.projectId"
                :label="project.label"
              >
                <option :value="project.href">{{ project.label }} (project)</option>
                <option v-for="app in project.apps" :key="app.value" :value="app.href">
                  {{ app.label }}
                </option>
              </optgroup>
            </select>
            <AppIcon name="chevron-down" />
          </div>
        </form>
      </div>

      <nav
        class="settings-scope__ladder"
        :class="{ 'is-single': scopeChain.length === 1 }"
        :aria-label="view.labels.nav.scopeLabel"
      >
        <template v-for="(node, index) in scopeChain" :key="node.scope">
          <span v-if="index > 0" class="settings-scope__link" aria-hidden="true">
            <span class="settings-scope__line"></span>
            <AppIcon name="chevron-right" />
          </span>
          <span
            v-if="node.current"
            class="settings-scope__node is-current"
            aria-current="page"
            :data-scope="node.scope"
          >
            <span class="settings-scope__row">
              <span class="settings-scope__name">{{ node.label }}</span>
              <span v-if="node.count !== null" class="settings-scope__count">
                <span class="mono">{{ node.count }}</span>
                {{ countLabel(node.count) }}
              </span>
            </span>
          </span>
          <button
            v-else
            class="settings-scope__node"
            type="button"
            :data-scope="node.scope"
            @click="navigateScope(node.scope)"
          >
            <span class="settings-scope__row">
              <span class="settings-scope__name">{{ node.label }}</span>
              <span v-if="node.count !== null" class="settings-scope__count">
                <span class="mono">{{ node.count }}</span>
                {{ countLabel(node.count) }}
              </span>
            </span>
          </button>
        </template>
      </nav>
    </div>
  </header>

  <div class="page__body page__body--settings-console">
    <section
      v-if="failed && view === undefined"
      class="card"
      aria-labelledby="settings-error-title"
    >
      <div class="card__head">
        <h2 class="card__title" id="settings-error-title">
          {{ notFound ? "Settings not found" : "Settings could not be loaded" }}
        </h2>
      </div>
      <div class="card__body stack--tight">
        <p class="form-error" role="alert">
          {{ notFound ? "This project or application settings scope does not exist." : failure }}
        </p>
        <div class="cluster">
          <button
            v-if="!notFound"
            class="btn btn-secondary btn-sm"
            type="button"
            @click="settingsQuery.refetch()"
          >
            <AppIcon name="refresh" />Retry
          </button>
          <RouterLink class="btn btn-secondary btn-sm" to="/settings">Global settings</RouterLink>
        </div>
      </div>
    </section>

    <p v-else-if="view === undefined" class="hint" role="status" aria-live="polite">
      Loading settings…
    </p>

    <template v-else>
      <section
        v-if="summary !== undefined"
        class="watch-strip watch-strip--4 settings-summary"
        aria-label="Resolved at this scope"
      >
        <div class="watch">
          <span class="watch__value">{{ summary.setHere }}</span>
          <span class="watch__label">set here</span>
        </div>
        <div class="watch">
          <span class="watch__value">{{ summary.inherited }}</span>
          <span class="watch__label">inherited</span>
        </div>
        <div class="watch">
          <span class="watch__value">{{ summary.attention }}</span>
          <span v-if="summary.attention > 0" class="settings-summary__flag" aria-hidden="true">
            <AppIcon name="alert-triangle" />
          </span>
          <span class="watch__label">needs attention</span>
          <button
            v-if="summary.attention > 0"
            class="settings-summary__review"
            type="button"
            @click="selectSection(attentionTarget)"
          >
            Review
          </button>
        </div>
        <div class="watch">
          <span class="watch__value">{{ summary.restartPending }}</span>
          <span class="watch__label">restart pending</span>
          <button
            v-if="summary.restartPending > 0"
            class="settings-summary__review"
            type="button"
            @click="selectSection('restart')"
          >
            Review
          </button>
        </div>
      </section>

      <div class="settings-console">
        <aside class="settings-console__rail" aria-label="Settings sections">
          <nav class="settings-console__rail-nav" :aria-label="view.labels.nav.sectionsLabel">
            <p class="nav-label">Sections</p>
            <button
              v-for="entry in SETTINGS_SECTIONS"
              :key="entry.id"
              class="settings-console__rail-item"
              :class="{ 'is-current': activeSection === entry.id }"
              type="button"
              :aria-current="activeSection === entry.id ? 'page' : undefined"
              :data-section="entry.id"
              @click="selectSection(entry.id)"
            >
              <AppIcon :name="entry.icon" />
              <span class="settings-console__rail-text">
                <span class="settings-console__rail-name">{{ sectionLabel(entry.id) }}</span>
                <span class="settings-console__rail-summary">{{ paneSummary(entry.id) }}</span>
              </span>
              <AppIcon name="check" class-name="settings-console__rail-mark" />
            </button>
          </nav>
          <section class="settings-console__legend" aria-label="Scope trace legend">
            <p class="settings-console__legend-title">Scope trace</p>
            <p class="settings-console__legend-keys">G Global · P Project · A Application</p>
            <ul class="settings-console__legend-list">
              <li><span class="trace-step is-set" aria-hidden="true">G</span> set</li>
              <li><span class="trace-step" aria-hidden="true">G</span> not set</li>
              <li><span class="trace-step is-win" aria-hidden="true">A</span> winning scope</li>
              <li><span class="trace-step is-cleared" aria-hidden="true">P</span> cleared</li>
            </ul>
          </section>
        </aside>

        <div class="settings-console__panes">
          <section
            class="settings-pane"
            id="settings-agent"
            :hidden="activeSection !== 'agent'"
            aria-labelledby="settings-agent-title"
          >
            <header class="settings-pane__head">
              <div class="settings-pane__title-row">
                <h2 class="settings-pane__title" id="settings-agent-title">
                  {{ sectionLabel("agent") }}
                </h2>
                <span class="badge">{{ paneSummary("agent") }}</span>
              </div>
              <p class="settings-pane__desc">{{ sectionDescription("agent") }}</p>
            </header>
            <div class="settings-pane__body">
              <SettingsRow
                :row="view.rows.model"
                :settings="view"
                :busy="busyRow === view.rows.model.key"
                :save-label="view.labels.actions.save"
                :inherit-label="view.labels.actions.inherit"
                :clear-label="view.labels.actions.clear"
                @set="(row, value) => mutateRow(row, 'set', value)"
                @inherit="mutateRow($event, 'inherit')"
                @clear="pendingClear = $event"
                @dirty="markDirty"
              />
              <SettingsProviderSection :settings="view" @changed="onSectionChanged" />
              <SettingsModelProviderSection :settings="view" @changed="onSectionChanged" />
            </div>
          </section>

          <section
            class="settings-pane"
            id="settings-web"
            :hidden="activeSection !== 'web'"
            aria-labelledby="settings-web-title"
          >
            <header class="settings-pane__head">
              <div class="settings-pane__title-row">
                <h2 class="settings-pane__title" id="settings-web-title">
                  {{ sectionLabel("web") }}
                </h2>
                <span class="badge">{{ paneSummary("web") }}</span>
              </div>
              <p class="settings-pane__desc">{{ sectionDescription("web") }}</p>
            </header>
            <div class="settings-pane__body">
              <SettingsRow
                :row="view.rows.webSearch"
                :settings="view"
                :busy="busyRow === view.rows.webSearch.key"
                :save-label="view.labels.actions.save"
                :inherit-label="view.labels.actions.inherit"
                :clear-label="view.labels.actions.clear"
                @set="(row, value) => mutateRow(row, 'set', value)"
                @inherit="mutateRow($event, 'inherit')"
                @clear="pendingClear = $event"
                @dirty="markDirty"
              />
              <SettingsRow
                :row="view.rows.webFetch"
                :settings="view"
                :busy="busyRow === view.rows.webFetch.key"
                :save-label="view.labels.actions.save"
                :inherit-label="view.labels.actions.inherit"
                :clear-label="view.labels.actions.clear"
                @set="(row, value) => mutateRow(row, 'set', value)"
                @inherit="mutateRow($event, 'inherit')"
                @clear="pendingClear = $event"
                @dirty="markDirty"
              />
            </div>
          </section>

          <section
            class="settings-pane"
            id="settings-context"
            :hidden="activeSection !== 'context'"
            aria-labelledby="settings-context-title"
          >
            <header class="settings-pane__head">
              <div class="settings-pane__title-row">
                <h2 class="settings-pane__title" id="settings-context-title">
                  {{ sectionLabel("context") }}
                </h2>
                <span class="badge">{{ paneSummary("context") }}</span>
              </div>
              <p class="settings-pane__desc">{{ sectionDescription("context") }}</p>
            </header>
            <div class="settings-pane__body">
              <SettingsRow
                :row="view.rows.contextEnabled"
                :settings="view"
                :busy="busyRow === view.rows.contextEnabled.key"
                :save-label="view.labels.actions.save"
                :inherit-label="view.labels.actions.inherit"
                :clear-label="view.labels.actions.clear"
                @set="(row, value) => mutateRow(row, 'set', value)"
                @inherit="mutateRow($event, 'inherit')"
                @clear="pendingClear = $event"
                @dirty="markDirty"
              />
              <SettingsRow
                :row="view.rows.contextPercent"
                :settings="view"
                :busy="busyRow === view.rows.contextPercent.key"
                :save-label="view.labels.actions.save"
                :inherit-label="view.labels.actions.inherit"
                :clear-label="view.labels.actions.clear"
                @set="(row, value) => mutateRow(row, 'set', value)"
                @inherit="mutateRow($event, 'inherit')"
                @clear="pendingClear = $event"
                @dirty="markDirty"
              />
            </div>
          </section>

          <section
            class="settings-pane"
            id="settings-notifications"
            :hidden="activeSection !== 'notifications'"
            aria-labelledby="settings-notifications-title"
          >
            <header class="settings-pane__head">
              <div class="settings-pane__title-row">
                <h2 class="settings-pane__title" id="settings-notifications-title">
                  {{ sectionLabel("notifications") }}
                </h2>
                <span class="badge">{{ paneSummary("notifications") }}</span>
              </div>
              <p class="settings-pane__desc">{{ sectionDescription("notifications") }}</p>
            </header>
            <div class="settings-pane__body">
              <SettingsTelegramSection
                :settings="view"
                @changed="onSectionChanged"
                @dirty="markDirty"
              />
            </div>
          </section>

          <section
            class="settings-pane"
            id="settings-git"
            :hidden="activeSection !== 'git'"
            aria-labelledby="settings-git-title"
          >
            <header class="settings-pane__head">
              <div class="settings-pane__title-row">
                <h2 class="settings-pane__title" id="settings-git-title">
                  {{ sectionLabel("git") }}
                </h2>
                <span class="badge">{{ paneSummary("git") }}</span>
              </div>
              <p class="settings-pane__desc">{{ sectionDescription("git") }}</p>
            </header>
            <div class="settings-pane__body">
              <SettingsRow
                :row="view.rows.gitName"
                :settings="view"
                :busy="busyRow === view.rows.gitName.key"
                :save-label="view.labels.actions.save"
                :inherit-label="view.labels.actions.inherit"
                :clear-label="view.labels.actions.clear"
                @set="(row, value) => mutateRow(row, 'set', value)"
                @inherit="mutateRow($event, 'inherit')"
                @clear="pendingClear = $event"
                @dirty="markDirty"
              />
              <SettingsRow
                :row="view.rows.gitEmail"
                :settings="view"
                :busy="busyRow === view.rows.gitEmail.key"
                :save-label="view.labels.actions.save"
                :inherit-label="view.labels.actions.inherit"
                :clear-label="view.labels.actions.clear"
                @set="(row, value) => mutateRow(row, 'set', value)"
                @inherit="mutateRow($event, 'inherit')"
                @clear="pendingClear = $event"
                @dirty="markDirty"
              />
              <SettingsGitSection :settings="view" @changed="onSectionChanged" />
            </div>
          </section>

          <section
            class="settings-pane"
            id="settings-restart"
            :hidden="activeSection !== 'restart'"
            aria-labelledby="settings-restart-title"
          >
            <header class="settings-pane__head">
              <div class="settings-pane__title-row">
                <h2 class="settings-pane__title" id="settings-restart-title">
                  {{ sectionLabel("restart") }}
                </h2>
                <span class="badge">{{ paneSummary("restart") }}</span>
              </div>
              <p class="settings-pane__desc">{{ sectionDescription("restart") }}</p>
            </header>
            <div class="settings-pane__body">
              <section
                v-if="view.warnings.length > 0"
                class="settings-warning settings-warning--console"
                id="settings-warnings"
                aria-labelledby="settings-warnings-title"
              >
                <p class="settings-warning__title" id="settings-warnings-title">
                  <AppIcon name="alert-triangle" />{{ view.labels.warnings }}
                </p>
                <div class="stack--tight">
                  <p
                    v-for="warning in view.warnings"
                    :key="warning"
                    class="field-error"
                    role="alert"
                  >
                    <AppIcon name="alert-triangle" />{{ warning }}
                  </p>
                </div>
              </section>
              <SettingsRestartSection :settings="view" @changed="onSectionChanged" />
            </div>
          </section>
        </div>
      </div>
    </template>

    <SettingsConfirmDialog
      :open="pendingClear !== null"
      :title="view?.dialogs.clear.title ?? 'Clear setting at this scope?'"
      :body="view?.dialogs.clear.body ?? ''"
      :submit-label="view?.dialogs.clear.submit ?? 'Clear setting'"
      :busy="busyRow !== null"
      @confirm="confirmClearRow"
      @cancel="pendingClear = null"
    />
  </div>
</template>
