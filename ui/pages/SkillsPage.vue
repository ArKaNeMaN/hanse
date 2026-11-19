<script setup lang="ts">
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import ExternalSkillDrawer from "../components/ExternalSkillDrawer.vue";
import SkillBundleEditor from "../components/SkillBundleEditor.vue";
import SkillPreviewDrawer from "../components/SkillPreviewDrawer.vue";
import SkillsScopeNav from "../components/SkillsScopeNav.vue";
import SmartLink from "../components/SmartLink.vue";
import TargetSelector from "../components/TargetSelector.vue";
import { usePageChrome } from "../composables/usePageChrome.js";
import { absoluteTime } from "../format.js";
import { hasSkillsMutated, markSkillsMutated } from "../skills-mutation.js";
import { targetToSkillsHref } from "../skills-target.js";
import type {
  InventoryFilter,
  SkillDraft,
  SkillScope,
  SkillsInventoryProps,
  SkillsInventoryRowProps,
  SkillsResponse,
  SkillsScopeProps,
  SkillWorkspaceProps,
} from "../skills-types.js";
import { useToastStore } from "../stores/toasts.js";
import type { Target, TargetsProps } from "../target-types.js";

type InventoryRow = SkillsInventoryRowProps & { readonly updatedLabel: string };
type SkillsDensity = "cards" | "list";

type InventoryRouteId = "skills-global" | "skills-project" | "skills-app";
type SkillsRouteId = InventoryRouteId | "skills-new";

const FILTERS: readonly InventoryFilter[] = [
  "all",
  "defined",
  "inherited",
  "disabled",
  "invalid",
  "external",
  "attention",
];

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();
const toasts = useToastStore();
const queryClient = useQueryClient();

function queryString(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function routeId(): SkillsRouteId {
  const name = route.name;
  if (
    name === "skills-new" ||
    name === "skills-global" ||
    name === "skills-project" ||
    name === "skills-app"
  ) {
    return name;
  }
  return "skills-global";
}

const isCreate = computed(() => routeId() === "skills-new");

function scopeFromId(id: InventoryRouteId): SkillScope {
  return id === "skills-global" ? "global" : id === "skills-project" ? "project" : "app";
}

function pagePath(scope: SkillScope, projectId: string, appKey: string): string {
  if (scope === "global") {
    return "/skills";
  }
  const base = `/projects/${encoded(projectId)}/skills`;
  return scope === "project"
    ? base
    : `/projects/${encoded(projectId)}/apps/${encoded(appKey)}/skills`;
}

function parseFilter(value: string): InventoryFilter {
  return FILTERS.includes(value as InventoryFilter) ? (value as InventoryFilter) : "all";
}

/* ------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* ------------------------------------------------------------------------- */

const inventoryId = computed<InventoryRouteId>(() => {
  const id = routeId();
  return id === "skills-new" ? "skills-global" : id;
});
const inventoryScope = computed(() =>
  isCreate.value ? createScope.value : scopeFromId(inventoryId.value),
);
const inventoryProjectId = computed(() =>
  isCreate.value ? createProjectId.value : queryString(route.params.id),
);
const inventoryAppKey = computed(() =>
  isCreate.value ? createAppKey.value : queryString(route.params.app),
);
const inventoryHref = computed(() =>
  pagePath(inventoryScope.value, inventoryProjectId.value, inventoryAppKey.value),
);
const inventoryFilter = computed(() => parseFilter(queryString(route.query.filter)));
const inventorySearch = computed(() => queryString(route.query.q).trim());

const bootInventory = computed<SkillsInventoryProps | undefined>(() => {
  if (isCreate.value || props.boot.route.id !== inventoryId.value) {
    return undefined;
  }
  if (hasSkillsMutated()) {
    return undefined;
  }
  const value = props.boot.props;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as SkillsInventoryProps;
  if (candidate.scope?.href !== inventoryHref.value) {
    return undefined;
  }
  return candidate.filter === inventoryFilter.value &&
    candidate.search.query === inventorySearch.value
    ? candidate
    : undefined;
});

function inventoryApiPath(): string {
  const params = new URLSearchParams({ scope: inventoryScope.value });
  if (inventoryScope.value !== "global") {
    params.set("project", inventoryProjectId.value);
  }
  if (inventoryScope.value === "app") {
    params.set("app", inventoryAppKey.value);
  }
  if (inventoryFilter.value !== "all") {
    params.set("filter", inventoryFilter.value);
  }
  if (inventorySearch.value.length > 0) {
    params.set("q", inventorySearch.value);
  }
  return `/api/ui/skills?${params.toString()}`;
}

/* ------------------------------------------------------------------------- */
/* Create                                                                     */
/* ------------------------------------------------------------------------- */

const createScope = computed<SkillScope>(() => {
  const raw = queryString(route.query.scope);
  if (raw === "global" || raw === "project" || raw === "app") {
    return raw;
  }
  if (queryString(route.query.project).length > 0) {
    return queryString(route.query.app).length > 0 ? "app" : "project";
  }
  return "global";
});
const createProjectId = computed(() => queryString(route.query.project));
const createAppKey = computed(() => queryString(route.query.app));
const createContextPath = computed(() =>
  pagePath(createScope.value, createProjectId.value, createAppKey.value),
);

const bootCreate = computed<SkillWorkspaceProps | undefined>(() => {
  if (!isCreate.value || props.boot.route.id !== "skills-new") {
    return undefined;
  }
  const value = props.boot.props;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as SkillWorkspaceProps;
  return candidate.create === true && candidate.scope?.href === createContextPath.value
    ? candidate
    : undefined;
});

const inventoryQuery = useQuery<SkillsResponse>({
  queryKey: computed(() => [
    "skills-inventory",
    inventoryScope.value,
    inventoryScope.value === "global" ? "" : inventoryProjectId.value,
    inventoryScope.value === "app" ? inventoryAppKey.value : "",
    inventoryFilter.value,
    inventorySearch.value,
    isCreate.value ? "create" : "inventory",
  ]),
  queryFn: () => apiQuery<SkillsResponse>(inventoryApiPath()),
  initialData: () => bootInventory.value,
  placeholderData: keepPreviousData,
  staleTime: 30_000,
  retry: false,
  refetchOnWindowFocus: false,
  enabled: computed(() => !isCreate.value || bootCreate.value === undefined),
});

usePageChrome(inventoryQuery, props.boot);

const targetsQuery = useQuery<TargetsProps>({
  queryKey: ["targets"],
  queryFn: () => apiQuery<TargetsProps>("/api/ui/targets"),
  staleTime: 60_000,
  retry: false,
  refetchOnWindowFocus: false,
  enabled: computed(() => !isCreate.value),
});

const view = computed<SkillsInventoryProps | undefined>(
  () => inventoryQuery.data.value ?? bootInventory.value,
);
const loading = computed(() => inventoryQuery.isFetching.value);
const failed = computed(() => inventoryQuery.isError.value);
const notFound = computed(() => {
  const error = inventoryQuery.error.value;
  return error instanceof ApiError && error.status === 404;
});
const failure = computed(() => {
  const error = inventoryQuery.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load skills.";
});
const createFailed = computed(() => inventoryQuery.isError.value);

const targetsError = computed<string | null>(() => {
  const error = targetsQuery.error.value;
  if (error === null || error === undefined) {
    return null;
  }
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load targets.";
});

const rows = computed<readonly InventoryRow[]>(() =>
  (view.value?.rows ?? []).map((row) => ({
    ...row,
    updatedLabel: absoluteTime(
      row.mode === "external" && row.origin?.publishedAt != null
        ? row.origin.publishedAt
        : row.updatedAt,
    ),
  })),
);

function scopeToTarget(value: SkillsScopeProps): Target {
  if (value.scope === "project") {
    return { kind: "project", projectId: value.projectId ?? "" };
  }
  if (value.scope === "app") {
    return { kind: "app", projectId: value.projectId ?? "", appKey: value.appKey ?? "" };
  }
  return { kind: "global" };
}

const inventoryTarget = computed<Target>(() =>
  view.value === undefined ? { kind: "global" } : scopeToTarget(view.value.scope),
);

const inventoryTargetLabel = computed<string>(() => {
  const current = view.value?.scope;
  if (current === undefined || current.scope === "global") {
    return "Global";
  }
  if (current.scope === "project") {
    return current.projectName ?? "Project";
  }
  return current.appName ?? current.appKey ?? "Application";
});

function changeTarget(target: Target): void {
  void router.push(targetToSkillsHref(target));
}

const inventoryMeta = computed<readonly string[]>(() => {
  const current = view.value;
  if (current === undefined) {
    return [];
  }
  const entries: string[] = [`${current.allCount} skills`, `${current.matchedCount} matched`];
  if (current.warnings.length > 0) {
    entries.push(
      `${current.warnings.length} ${current.warnings.length === 1 ? "warning" : "warnings"}`,
    );
  }
  if (current.pending.length > 0) {
    entries.push(
      `${current.pending.length} ${
        current.pending.length === 1 ? "app needs" : "apps need"
      } restart`,
    );
  }
  return entries;
});

const externalRow = ref<SkillsInventoryRowProps | null>(null);
const previewRow = ref<SkillsInventoryRowProps | null>(null);
const railCollapsed = ref(false);

function openRow(row: InventoryRow): void {
  if (row.mode === "external") {
    externalRow.value = row;
    return;
  }
  previewRow.value = row;
}

function stateTone(state: string): string {
  if (state === "enabled") {
    return "badge-success";
  }
  if (state === "disabled") {
    return "badge-warning";
  }
  if (state === "invalid") {
    return "badge-error";
  }
  return "badge-ghost";
}

const GROUPS: readonly {
  readonly key: string;
  readonly heading: string;
  readonly scope: SkillScope | null;
  readonly external: boolean;
}[] = [
  { key: "global", heading: "Global", scope: "global", external: false },
  { key: "project", heading: "Project", scope: "project", external: false },
  { key: "app", heading: "Application", scope: "app", external: false },
  { key: "external", heading: "External", scope: null, external: true },
];

const groupedRows = computed(() =>
  GROUPS.map((group) => ({
    ...group,
    rows: rows.value.filter((row) =>
      group.external
        ? row.mode === "external"
        : row.mode !== "external" && (row.scope ?? "global") === group.scope,
    ),
  })).filter((group) => group.rows.length > 0),
);

function scopeLabel(value: SkillScope): string {
  return value === "app" ? "Application" : value === "project" ? "Project" : "Global";
}

interface RowNote {
  readonly tone: "invalid" | "collision" | "disabled";
  readonly text: string;
}

function rowNote(row: InventoryRow): RowNote | null {
  if (row.mode === "external") {
    return null;
  }
  const issue = row.issues[0];
  if (issue !== undefined) {
    return { tone: "invalid", text: issue.message };
  }
  const collision = row.collisions[0];
  if (collision !== undefined) {
    return { tone: "collision", text: collision.text };
  }
  if (row.state === "disabled" && row.shadows.length > 0) {
    return {
      tone: "disabled",
      text: `Tombstone hides ${row.shadows.map(scopeLabel).join(", ")}`,
    };
  }
  if (row.shadowed) {
    return { tone: "disabled", text: "Shadowed by a narrower skill" };
  }
  return null;
}

function rowOrigin(row: InventoryRow): { readonly badge: string; readonly text: string } {
  if (row.mode === "external" && row.origin !== null) {
    return {
      badge: "Source",
      text: `${row.origin.sourceName} · ${row.origin.bucket} · ${row.origin.revision.slice(0, 7)}`,
    };
  }
  return {
    badge:
      row.originScope === "app"
        ? "Application"
        : row.originScope === "project"
          ? "Project"
          : "Global",
    text: row.originText,
  };
}

/* ------------------------------------------------------------------------- */
/* Density                                                                    */
/* ------------------------------------------------------------------------- */

const DENSITY_KEY = "hanse.skills.density";

function readDensity(): SkillsDensity {
  try {
    return window.localStorage.getItem(DENSITY_KEY) === "list" ? "list" : "cards";
  } catch {
    return "cards";
  }
}

const density = ref<SkillsDensity>(readDensity());

watch(density, (value) => {
  try {
    window.localStorage.setItem(DENSITY_KEY, value);
  } catch {
    // Local storage can be unavailable in hardened browser modes; density is a preference only.
  }
});

/* ------------------------------------------------------------------------- */
/* Search                                                                     */
/* ------------------------------------------------------------------------- */

const searchInput = ref(inventorySearch.value);
const searchEl = ref<HTMLInputElement | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function clearSearchTimer(): void {
  if (searchTimer !== undefined) {
    clearTimeout(searchTimer);
    searchTimer = undefined;
  }
}

watch(inventorySearch, (value) => {
  if (searchInput.value.trim() !== value) {
    searchInput.value = value;
  }
});

watch(searchInput, (value) => {
  clearSearchTimer();
  if (value.trim() === inventorySearch.value) {
    return;
  }
  searchTimer = setTimeout(() => {
    searchTimer = undefined;
    void applySearch(value, "replace");
  }, 250);
});

function searchHref(needle: string): string {
  const params = new URLSearchParams();
  if (inventoryFilter.value !== "all") {
    params.set("filter", inventoryFilter.value);
  }
  if (needle.length > 0) {
    params.set("q", needle);
  }
  const query = params.toString();
  return query.length === 0 ? inventoryHref.value : `${inventoryHref.value}?${query}`;
}

async function applySearch(raw: string, mode: "push" | "replace"): Promise<void> {
  const needle = raw.trim();
  if (needle === inventorySearch.value) {
    return;
  }
  const href = searchHref(needle);
  if (mode === "push") {
    await router.push(href);
  } else {
    await router.replace(href);
  }
}

function submitSearch(): void {
  clearSearchTimer();
  void applySearch(searchInput.value, "push");
}

function clearSearch(): void {
  clearSearchTimer();
  searchInput.value = "";
  void applySearch("", "replace");
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (isCreate.value || event.defaultPrevented) {
    return;
  }
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (isTypingTarget(event.target)) {
    return;
  }
  event.preventDefault();
  searchEl.value?.focus();
}

onMounted(() => {
  document.addEventListener("keydown", onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onDocumentKeydown);
  clearSearchTimer();
});

/* ------------------------------------------------------------------------- */
/* Create draft and submission                                                */
/* ------------------------------------------------------------------------- */

interface CreateModel {
  readonly scope: SkillsScopeProps;
  readonly repository: {
    readonly labels: SkillsInventoryProps["labels"];
    readonly contextPage: string;
  };
}

const createModel = computed<CreateModel | undefined>(() => {
  const boot = bootCreate.value;
  if (boot !== undefined) {
    return {
      scope: boot.scope,
      repository: { labels: boot.labels, contextPage: boot.contextPage },
    };
  }
  const inventory = inventoryQuery.data.value ?? bootInventory.value;
  if (inventory === undefined) {
    return undefined;
  }
  return {
    scope: inventory.scope,
    repository: { labels: inventory.labels, contextPage: inventory.scope.href },
  };
});

const KNOWN_KEYS = new Set([
  "domain",
  "role",
  "scope",
  "output-format",
  "triggers",
  "related-skills",
  "version",
  "author",
]);

function draftFromBoot(boot: SkillWorkspaceProps): SkillDraft {
  const knownMetadata: Record<string, string> = {};
  const customMetadata: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(boot.values.bundle.metadata)) {
    if (KNOWN_KEYS.has(key)) {
      knownMetadata[key] = value;
    } else {
      customMetadata.push({ key, value });
    }
  }
  return {
    name: boot.values.name,
    description: boot.values.description,
    content: boot.values.content,
    enabled: boot.values.enabled,
    license: boot.values.bundle.license ?? "",
    compatibility: boot.values.bundle.compatibility ?? "",
    knownMetadata,
    customMetadata,
    metadataRaw: boot.values.bundle.metadataRaw,
    references: boot.values.bundle.references.map((reference) => ({
      path: reference.path,
      content: reference.content,
    })),
  };
}

function emptyDraft(): SkillDraft {
  return {
    name: "",
    description: "",
    content: "",
    enabled: true,
    license: "",
    compatibility: "",
    knownMetadata: {},
    customMetadata: [],
    metadataRaw: null,
    references: [],
  };
}

const draft = ref<SkillDraft>(emptyDraft());
watch(
  [bootCreate, isCreate],
  () => {
    const boot = bootCreate.value;
    draft.value = boot === undefined ? emptyDraft() : draftFromBoot(boot);
  },
  { immediate: true },
);

const createError = ref<{ message: string; field: string | null } | null>(null);
const submitting = ref(false);
const editor = ref<InstanceType<typeof SkillBundleEditor> | null>(null);

const createOverline = computed(
  () => `${(createModel.value?.scope.scopeLabel ?? "Global").toUpperCase()} SKILL`,
);

async function submitCreate(): Promise<void> {
  const model = createModel.value;
  const form = editor.value;
  if (model === undefined || form === null || submitting.value) {
    return;
  }
  createError.value = null;
  const invalid = form.validate();
  if (invalid !== undefined) {
    createError.value = { message: invalid.message, field: invalid.field };
    return;
  }
  submitting.value = true;
  try {
    const bundle = form.bundlePayload();
    const response = await apiMutation<{ skill: { id: number } }>("/api/skills", {
      json: {
        action: "create",
        scope: createScope.value,
        ...(createScope.value === "global" ? {} : { project: createProjectId.value }),
        ...(createScope.value === "app" ? { app: createAppKey.value } : {}),
        return_to: model.repository.contextPage,
        name: draft.value.name,
        description: draft.value.description,
        content: draft.value.content,
        enabled: draft.value.enabled,
        ...bundle,
      },
    });
    markSkillsMutated();
    queryClient.removeQueries({ queryKey: ["skills-inventory"] });
    toasts.push("Skill created.", "success");
    const id = response.skill?.id;
    void router.push(Number.isSafeInteger(id) ? `/skills/${id}` : model.repository.contextPage);
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "The skill could not be created.";
    const field = error instanceof ApiError ? (error.code ?? null) : null;
    const duplicate = error instanceof ApiError && error.status === 409;
    createError.value = {
      message: duplicate ? "A skill with this name already exists at this scope." : message,
      field: duplicate ? "name" : field,
    };
    toasts.push(createError.value.message, "error");
  } finally {
    submitting.value = false;
  }
}

function discardCreate(): void {
  void router.push(createModel.value?.repository.contextPage ?? "/skills");
}
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">
        {{
          isCreate
            ? createOverline
            : view !== undefined
              ? `Skills · ${view.scope.scopeLabel}`
              : "Skills"
        }}
      </p>
      <h1 class="page-title">{{ isCreate ? "New skill" : "Skills" }}</h1>
      <p class="page-description">
        {{
          isCreate
            ? "Create a reusable procedure for agents to load at start. Details, the body, and references save as one bundle."
            : (view?.description ?? "Reusable procedures every application can load.")
        }}
      </p>
      <div v-if="!isCreate && view !== undefined" class="page-meta">
        <span v-if="inventoryMeta.length > 0" class="mono" data-skill-meta>
          {{ inventoryMeta.join(" · ") }}
        </span>
      </div>
      <div v-else-if="isCreate && createModel !== undefined" class="page-meta">
        <span class="mono">{{ createModel.scope.scopeLabel }}</span>
        <span v-if="createModel.scope.projectName !== null" class="mono">
          {{ createModel.scope.projectName }}
        </span>
        <span v-if="createModel.scope.appKey !== null" class="mono">
          {{ createModel.scope.appKey }}
        </span>
      </div>
    </div>
    <div class="page-header__actions">
      <template v-if="isCreate">
        <SmartLink
          v-if="createModel !== undefined"
          class="btn btn-ghost"
          :to="createModel.repository.contextPage"
        >
          {{ createModel.repository.labels.backToSkills }}
        </SmartLink>
        <button v-else class="btn btn-ghost" type="button" disabled>Back to skills</button>
      </template>
      <SmartLink
        v-else-if="view !== undefined"
        class="btn btn-primary"
        :to="view.createHref"
        data-skill-create
      >
        <AppIcon name="plus" />{{ view.createLabel }}
      </SmartLink>
    </div>
  </header>

  <div class="page__body">
    <!-- Create ------------------------------------------------------------- -->
    <template v-if="isCreate">
      <section v-if="createFailed && createModel === undefined" class="card">
        <div class="card__head">
          <h2 class="card__title">Skills scope not found</h2>
        </div>
        <div class="card__body stack--tight">
          <p class="form-error" role="alert">
            {{ notFound ? "This project or application skills scope does not exist." : failure }}
          </p>
          <div class="cluster">
            <RouterLink class="btn btn-secondary btn-sm" to="/skills">Global skills</RouterLink>
          </div>
        </div>
      </section>

      <p v-else-if="createModel === undefined" class="hint" role="status" aria-live="polite">
        Loading skill scope…
      </p>

      <template v-else>
        <SkillsScopeNav :model="createModel.scope" />
        <div class="cluster section">
          <span class="badge badge-info">Draft</span>
          <SmartLink class="small" :to="createModel.repository.contextPage">
            {{ createModel.repository.labels.backToSkills }}
          </SmartLink>
        </div>

        <form
          class="stack skill-bundle-form"
          method="post"
          action="/api/skills"
          data-skill-form
          data-skill-mode="create"
          :data-skill-name="draft.name"
          @submit.prevent="submitCreate"
        >
          <div class="skill-editbar" data-skill-editbar>
            <p class="hint" data-skill-status role="status">
              {{ submitting ? "Creating…" : "Not saved yet" }}
            </p>
            <button
              class="btn btn-primary"
              type="submit"
              name="action"
              value="create"
              data-skill-save
              :disabled="submitting"
            >
              Create skill
            </button>
            <button
              class="btn btn-ghost"
              type="button"
              data-skill-discard
              :disabled="submitting"
              @click="discardCreate"
            >
              Discard
            </button>
          </div>

          <div v-if="createError !== null" class="settings-warning" role="alert">
            <p class="settings-warning__title">
              <AppIcon name="alert-triangle" />{{ createError.message }}
            </p>
          </div>

          <SkillBundleEditor
            ref="editor"
            :draft="draft"
            :editable="true"
            mode="create"
            :error="createError"
            :name-field="null"
            :stored-issues="[]"
          />
        </form>
      </template>
    </template>

    <!-- Inventory ---------------------------------------------------------- -->
    <template v-else>
      <section v-if="failed && view === undefined" class="card">
        <div class="card__head">
          <h2 class="card__title">
            {{ notFound ? "Skills scope not found" : "Skills could not be loaded" }}
          </h2>
        </div>
        <div class="card__body stack--tight">
          <p class="form-error" role="alert">
            {{ notFound ? "This project or application skills scope does not exist." : failure }}
          </p>
          <div class="cluster">
            <button
              v-if="!notFound"
              class="btn btn-secondary btn-sm"
              type="button"
              @click="inventoryQuery.refetch()"
            >
              <AppIcon name="refresh" />Retry
            </button>
            <RouterLink class="btn btn-secondary btn-sm" to="/skills">Global skills</RouterLink>
          </div>
        </div>
      </section>

      <p v-else-if="view === undefined" class="hint" role="status" aria-live="polite">
        Loading skills…
      </p>

      <template v-else>
        <div
          class="skills-layout section"
          :class="{ 'skills-layout--rail-collapsed': railCollapsed }"
          :aria-busy="loading"
        >
          <div class="skills-main">
            <div class="toolbar skill-toolbar skills-toolbar" data-skill-inventory-toolbar>
              <form class="skills-search" aria-label="Search skills" @submit.prevent="submitSearch">
                <label class="sr-only" for="skill-search">Search skills</label>
                <input
                  v-if="view.search.hiddenFilter !== null"
                  type="hidden"
                  name="filter"
                  :value="view.search.hiddenFilter"
                >
                <span class="skills-search__field">
                  <AppIcon name="search" class="skills-search__icon" />
                  <input
                    id="skill-search"
                    ref="searchEl"
                    v-model="searchInput"
                    class="input skills-search__input"
                    type="search"
                    name="q"
                    placeholder="Search skills"
                    autocomplete="off"
                    @keydown.escape.prevent="clearSearch"
                  >
                  <button
                    v-if="searchInput.length > 0"
                    class="btn btn-ghost btn-icon btn-sm skills-search__clear"
                    type="button"
                    aria-label="Clear search"
                    @click="clearSearch"
                  >
                    <AppIcon name="x" />
                  </button>
                </span>
                <button class="btn btn-secondary" type="submit">
                  <AppIcon name="search" />Search
                </button>
              </form>

              <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: the filter strip scrolls horizontally and is keyboard-scrollable -->
              <section class="segmented skills-filters" aria-label="Filter skills" tabindex="0">
                <SmartLink
                  v-for="entry in view.filters"
                  :key="entry.value"
                  class="segmented__item"
                  :to="entry.href"
                  :aria-current="entry.current ? 'page' : undefined"
                >
                  {{ entry.label }}
                </SmartLink>
              </section>

              <div class="skills-controls">
                <TargetSelector
                  :config="{ mode: 'scope', root: 'global' }"
                  :current="inventoryTarget"
                  :current-label="inventoryTargetLabel"
                  :catalog="targetsQuery.data.value"
                  :loading="targetsQuery.isPending.value"
                  :error="targetsError"
                  @change="changeTarget"
                  @retry="targetsQuery.refetch()"
                />
                <section class="segmented skills-density" aria-label="Skill density">
                  <button
                    class="segmented__item"
                    type="button"
                    :aria-pressed="density === 'cards'"
                    @click="density = 'cards'"
                  >
                    Cards
                  </button>
                  <button
                    class="segmented__item"
                    type="button"
                    :aria-pressed="density === 'list'"
                    @click="density = 'list'"
                  >
                    List
                  </button>
                </section>
              </div>
            </div>

            <section
              v-if="view.attention.count > 0 || inventoryFilter === 'attention'"
              class="skills-attention"
              :data-active="view.attention.active ? 'true' : 'false'"
              aria-label="Needs attention"
            >
              <div class="skills-attention__lead">
                <AppIcon name="alert-triangle" class="skills-attention__glyph" />
                <span class="skills-attention__title">Needs attention</span>
                <span class="badge badge-warning">{{ view.attention.count }}</span>
              </div>
              <ul v-if="view.attention.items.length > 0" class="skills-attention__items">
                <li
                  v-for="item in view.attention.items"
                  :key="item.key"
                  class="skills-attention__item"
                  :data-tone="item.tone"
                >
                  <span class="mono skills-attention__name">{{ item.name }}</span>
                  <span class="small skills-attention__reason">{{ item.reason }}</span>
                </li>
              </ul>
              <span v-if="view.attention.omitted > 0" class="hint skills-attention__more">
                +{{ view.attention.omitted }}
                more
              </span>
              <div class="skills-attention__actions">
                <template v-if="view.attention.active">
                  <span class="small">Showing only</span>
                  <SmartLink class="btn btn-ghost btn-sm" :to="view.attention.clearHref">
                    Clear
                  </SmartLink>
                </template>
                <SmartLink v-else class="btn btn-secondary btn-sm" :to="view.attention.href">
                  Show only
                </SmartLink>
              </div>
            </section>

            <p class="hint" data-skill-count>
              {{ view.matchedCount }} of {{ view.allCount }} skills at this scope
            </p>

            <div v-if="view.empty !== null" class="empty-state">
              <div class="empty-state__mark">
                <AppIcon :name="view.empty.iconName" />
              </div>
              <h2 class="empty-state__title">{{ view.empty.title }}</h2>
              <p class="empty-state__body">{{ view.empty.body }}</p>
              <SmartLink
                class="btn"
                :class="`btn-${view.empty.actionStyle}`"
                :to="view.empty.actionHref"
              >
                <AppIcon v-if="view.empty.actionIcon !== null" :name="view.empty.actionIcon" />
                {{ view.empty.actionLabel }}
              </SmartLink>
            </div>

            <div v-else class="skills-inventory" data-skill-inventory>
              <template v-if="density === 'cards'">
                <section v-for="group in groupedRows" :key="group.key" class="skills-group">
                  <header class="skills-group__head">
                    <h2 class="skills-group__title">{{ group.heading }}</h2>
                    <span class="badge">{{ group.rows.length }}</span>
                  </header>
                  <div class="skills-cards">
                    <button
                      v-for="row in group.rows"
                      :key="row.externalKey ?? String(row.id)"
                      class="skill-card"
                      type="button"
                      data-skill-row
                      :data-skill-name="row.name"
                      :data-skill-state="row.state"
                      :data-skill-state-label="row.stateLabel"
                      :data-skill-mode="row.mode"
                      @click="openRow(row)"
                    >
                      <span class="skill-card__head">
                        <span class="skill-card__name mono">{{ row.name }}</span>
                        <span v-if="row.mode === 'external'" class="badge">
                          <AppIcon name="lock" />{{ row.stateLabel }}
                        </span>
                        <span v-else class="badge" :class="stateTone(row.state)">
                          {{ row.stateLabel }}
                        </span>
                      </span>
                      <span class="skill-card__description">{{ row.description }}</span>
                      <span
                        v-if="rowNote(row) !== null"
                        class="skill-card__note"
                        :data-tone="rowNote(row)?.tone"
                      >
                        {{ rowNote(row)?.text }}
                      </span>
                      <span class="skill-card__foot">
                        <span class="badge">{{ rowOrigin(row).badge }}</span>
                        <span class="small skill-card__origin">{{ rowOrigin(row).text }}</span>
                        <span class="small skill-card__files mono">
                          {{ row.fileCount }}
                          files · {{ row.references }} refs
                        </span>
                        <span class="small skill-card__updated" :title="row.updatedAt">
                          {{ row.updatedLabel }}
                        </span>
                        <AppIcon name="chevron-right" class="skill-card__chevron" />
                      </span>
                    </button>
                  </div>
                </section>
              </template>

              <div v-else class="skills-list">
                <div class="skills-list__head" aria-hidden="true">
                  <span>State</span>
                  <span>Skill</span>
                  <span>Origin</span>
                  <span>Files/Refs</span>
                  <span>Updated</span>
                </div>
                <section v-for="group in groupedRows" :key="group.key" class="skills-group">
                  <header class="skills-group__head">
                    <h2 class="skills-group__title">{{ group.heading }}</h2>
                    <span class="badge">{{ group.rows.length }}</span>
                  </header>
                  <button
                    v-for="row in group.rows"
                    :key="row.externalKey ?? String(row.id)"
                    class="skill-list-row"
                    type="button"
                    data-skill-row
                    :data-skill-name="row.name"
                    :data-skill-state="row.state"
                    :data-skill-state-label="row.stateLabel"
                    :data-skill-mode="row.mode"
                    @click="openRow(row)"
                  >
                    <span class="skill-list-row__state">
                      <span v-if="row.mode === 'external'" class="badge">
                        <AppIcon name="lock" />{{ row.stateLabel }}
                      </span>
                      <span v-else class="badge" :class="stateTone(row.state)">
                        {{ row.stateLabel }}
                      </span>
                    </span>
                    <span class="skill-list-row__skill">
                      <span class="mono">{{ row.name }}</span>
                      <span class="small skill-list-row__description">{{ row.description }}</span>
                      <span
                        v-if="rowNote(row) !== null"
                        class="skill-list-row__note"
                        :data-tone="rowNote(row)?.tone"
                      >
                        {{ rowNote(row)?.text }}
                      </span>
                    </span>
                    <span class="skill-list-row__origin">
                      <span class="badge">{{ rowOrigin(row).badge }}</span>
                      <span class="small">{{ rowOrigin(row).text }}</span>
                    </span>
                    <span class="skill-list-row__files mono">
                      {{ row.fileCount }}
                      / {{ row.references }}
                    </span>
                    <span class="skill-list-row__updated mono" :title="row.updatedAt">
                      {{ row.updatedLabel }}
                    </span>
                  </button>
                </section>
              </div>
            </div>
          </div>

          <aside class="skills-rail" aria-label="Skills information">
            <div class="skills-rail__head">
              <h2 class="skills-rail__title">Overview</h2>
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                :aria-expanded="railCollapsed ? 'false' : 'true'"
                @click="railCollapsed = !railCollapsed"
              >
                {{ railCollapsed ? "Show" : "Hide" }}
              </button>
            </div>

            <div v-if="!railCollapsed" class="skills-rail__body rail-stack">
              <section class="card">
                <div class="card__head">
                  <h3 class="card__title">Scope &amp; inheritance</h3>
                </div>
                <div class="card__body stack--tight">
                  <p class="small">
                    Skills resolve global → project → application. The narrowest row wins by name; a
                    disabled row hides wider skills without deleting them.
                  </p>
                  <p class="hint">
                    Repository and plugin skills are outside this hierarchy and may shadow a
                    same-named managed skill.
                  </p>
                  <p class="hint">Collisions are reported on an application's Skills page.</p>
                </div>
              </section>

              <section v-if="view.warnings.length > 0 || view.truncated !== null" class="card">
                <div class="card__head">
                  <h3 class="card__title">Skill root warnings</h3>
                  <span class="badge">{{ view.warnings.length }}</span>
                </div>
                <div class="card__body stack--tight">
                  <p
                    v-for="warning in view.warnings"
                    :key="`${warning.code}-${warning.root}-${warning.name}`"
                    class="field-error"
                    role="alert"
                  >
                    <AppIcon name="alert-triangle" />{{ warning.text }}
                  </p>
                  <p v-if="view.truncated !== null" class="hint">
                    {{ view.truncated }} more collision warnings omitted.
                  </p>
                </div>
              </section>

              <section class="card">
                <div class="card__head">
                  <h3 class="card__title">Summary</h3>
                </div>
                <div class="card__body stack--tight">
                  <p class="mono">
                    {{ view.counts.enabled }} enabled · {{ view.counts.inherited }} inherited
                  </p>
                  <p class="mono">
                    {{ view.counts.disabled }} disabled · {{ view.counts.invalid }} invalid
                  </p>
                  <p class="mono">{{ view.counts.external }} external · not counted as inherited</p>
                  <p class="hint">
                    Counts are Hanse-effective at this scope, not every skill on disk.
                  </p>
                </div>
              </section>

              <section v-if="view.pending.length > 0" class="card" data-skill-restart-rail>
                <div class="card__head">
                  <h3 class="card__title">Restart required</h3>
                  <span class="badge">{{ view.pending.length }}</span>
                </div>
                <div class="card__body stack--tight">
                  <p class="hint">
                    Skills changed. A restart applies the effective set; it is never automatic.
                  </p>
                  <div v-for="entry in view.pending" :key="entry.appKey" class="cluster">
                    <SmartLink class="small" :to="entry.href">{{ entry.appKey }}</SmartLink>
                    <span class="status" data-state="awaiting_approval">
                      <AppIcon name="stamp" />Restart required
                    </span>
                  </div>
                </div>
              </section>
            </div>
          </aside>
        </div>

        <ExternalSkillDrawer
          :open="externalRow !== null"
          :row="externalRow"
          @close="externalRow = null"
        />
        <SkillPreviewDrawer
          :open="previewRow !== null"
          :row="previewRow"
          :from="inventoryHref"
          @close="previewRow = null"
        />
      </template>
    </template>
  </div>
</template>
