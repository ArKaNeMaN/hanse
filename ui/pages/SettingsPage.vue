<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
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
import SmartLink from "../components/SmartLink.vue";
import { applyChrome } from "../composables/useChrome.js";
import type {
  SettingsProps,
  SettingsResponse,
  SettingsRowProps,
  SettingsScope,
} from "../settings-types.js";
import { useToastStore } from "../stores/toasts.js";

type SettingsRouteId = "settings-global" | "settings-project" | "settings-app";

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

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
});

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

async function refreshChromeAndProps(): Promise<void> {
  const result = await settingsQuery.refetch();
  const chrome = result.data?.chrome;
  if (chrome !== undefined) {
    applyChrome(chrome);
  }
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
  },
);
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Settings</p>
      <h1 class="page-title">{{ view?.scope.title ?? "Settings" }}</h1>
      <p class="page-description">{{ view?.scope.description ?? "Coordinator settings." }}</p>
      <div v-if="view !== undefined" class="page-meta">
        <span class="mono">{{ view.scope.scopeLabel }}</span>
        <span v-if="view.scope.projectName !== null" class="mono">
          {{ view.scope.projectName }}
        </span>
        <span v-if="view.scope.appKey !== null" class="mono">{{ view.scope.appKey }}</span>
        <span v-if="dirtyRows.size > 0" class="mono" role="status">Unsaved changes</span>
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
  </header>

  <div class="page__body">
    <p v-if="loading && view !== undefined" class="hint" role="status" aria-live="polite">
      Updating settings…
    </p>

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
          <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
        </div>
      </div>
    </section>

    <p v-else-if="view === undefined" class="hint" role="status" aria-live="polite">
      Loading settings…
    </p>

    <template v-else>
      <nav class="settings-nav" :aria-label="view.labels.nav.ariaLabel">
        <section
          v-if="view.scope.scope !== 'global'"
          class="settings-nav__scopes"
          :aria-label="view.labels.nav.scopeLabel"
        >
          <SmartLink class="settings-nav__link" :to="view.scope.nav.globalHref">
            {{ view.labels.nav.scopes.global }}
          </SmartLink>
          <button
            v-if="view.scope.nav.projectHref !== null"
            class="settings-nav__link"
            type="button"
            :aria-current="view.scope.nav.projectCurrent ? 'page' : undefined"
            @click="navigateScope('project')"
          >
            {{ view.labels.nav.scopes.project }}
          </button>
          <span v-else class="settings-nav__link" aria-current="page">
            <AppIcon name="check" />{{ view.labels.nav.scopes.project }}
          </span>
          <button
            v-if="view.scope.nav.appHref !== null"
            class="settings-nav__link"
            type="button"
            :aria-current="view.scope.nav.appCurrent ? 'page' : undefined"
            @click="navigateScope('app')"
          >
            {{ view.labels.nav.scopes.app }}
          </button>
          <span
            v-else-if="view.scope.scope === 'app'"
            class="settings-nav__link"
            aria-current="page"
          >
            <AppIcon name="check" />{{ view.labels.nav.scopes.app }}
          </span>
        </section>

        <form class="settings-nav__scopes" :aria-label="view.labels.nav.scopeLabel">
          <label class="label" for="settings-target">Scope target</label>
          <div class="select-wrap">
            <select
              id="settings-target"
              class="select"
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

        <div class="settings-nav__sections" :aria-label="view.labels.nav.sectionsLabel">
          <a class="settings-nav__link" href="#settings-agent">{{ view.labels.sections.agent }}</a>
          <a class="settings-nav__link" href="#settings-web">{{ view.labels.sections.web }}</a>
          <a class="settings-nav__link" href="#settings-context">
            {{ view.labels.sections.context }}
          </a>
          <a class="settings-nav__link" href="#settings-git">{{ view.labels.sections.git }}</a>
          <a class="settings-nav__link" href="#settings-restart">
            {{ view.labels.sections.restart }}
          </a>
        </div>
      </nav>

      <section
        v-if="view.restartRequired"
        class="settings-warning"
        aria-labelledby="settings-restart-banner-title"
      >
        <p class="settings-warning__title" id="settings-restart-banner-title">
          <AppIcon name="alert-triangle" />Restart required
        </p>
        <div class="stack--tight">
          <p class="hint">{{ view.labels.restart.hint }}</p>
          <a class="btn btn-secondary btn-sm" href="#settings-restart">Review restart</a>
        </div>
      </section>

      <section
        v-if="view.warnings.length > 0"
        class="settings-warning"
        aria-labelledby="settings-warnings-title"
      >
        <p class="settings-warning__title" id="settings-warnings-title">
          <AppIcon name="alert-triangle" />{{ view.labels.warnings }}
        </p>
        <div class="stack--tight">
          <p v-for="warning in view.warnings" :key="warning" class="field-error" role="alert">
            <AppIcon name="alert-triangle" />{{ warning }}
          </p>
        </div>
      </section>

      <div class="settings-sections">
        <section
          class="card settings-section"
          id="settings-agent"
          aria-labelledby="settings-agent-title"
        >
          <div class="card__head">
            <h2 class="card__title" id="settings-agent-title">
              {{ view.labels.sections.agent }}
            </h2>
            <span class="badge">Model and providers</span>
          </div>
          <div class="card__body card__body--flush">
            <SettingsRow
              :row="view.rows.model"
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
          class="card settings-section"
          id="settings-web"
          aria-labelledby="settings-web-title"
        >
          <div class="card__head">
            <h2 class="card__title" id="settings-web-title">{{ view.labels.sections.web }}</h2>
            <span class="badge">Search and fetch</span>
          </div>
          <div class="card__body card__body--flush">
            <SettingsRow
              :row="view.rows.webSearch"
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
          class="card settings-section"
          id="settings-context"
          aria-labelledby="settings-context-title"
        >
          <div class="card__head">
            <h2 class="card__title" id="settings-context-title">
              {{ view.labels.sections.context }}
            </h2>
            <span class="badge">Auto-compaction</span>
          </div>
          <div class="card__body card__body--flush">
            <SettingsRow
              :row="view.rows.contextEnabled"
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

        <section class="card settings-section" id="settings-git" aria-labelledby="git-title">
          <div class="card__head">
            <h2 class="card__title" id="git-title">{{ view.labels.sections.git }}</h2>
            <span class="badge">{{ view.labels.git.badge }}</span>
          </div>
          <div class="card__body card__body--flush" id="git">
            <SettingsRow
              :row="view.rows.gitName"
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

        <SettingsRestartSection :settings="view" @changed="onSectionChanged" />
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
