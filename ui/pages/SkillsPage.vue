<script setup lang="ts">
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import SkillBundleEditor from "../components/SkillBundleEditor.vue";
import SkillsScopeNav from "../components/SkillsScopeNav.vue";
import SmartLink from "../components/SmartLink.vue";
import { absoluteTime } from "../format.js";
import { hasSkillsMutated, markSkillsMutated } from "../skills-mutation.js";
import type {
  InventoryFilter,
  SkillDraft,
  SkillScope,
  SkillsInventoryProps,
  SkillsResponse,
  SkillsScopeProps,
  SkillWorkspaceProps,
} from "../skills-types.js";
import { useToastStore } from "../stores/toasts.js";

type InventoryRouteId = "skills-global" | "skills-project" | "skills-app";
type SkillsRouteId = InventoryRouteId | "skills-new";

const FILTERS: readonly InventoryFilter[] = ["all", "defined", "inherited", "disabled", "invalid"];

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
  staleTime: 30_000,
  retry: false,
  enabled: computed(() => !isCreate.value || bootCreate.value === undefined),
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

const rows = computed(() =>
  (view.value?.rows ?? []).map((row) => ({
    ...row,
    updatedLabel: absoluteTime(row.updatedAt),
  })),
);

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

const searchInput = ref(inventorySearch.value);
watch(inventorySearch, (value) => {
  searchInput.value = value;
});

function submitSearch(): void {
  const params = new URLSearchParams();
  if (inventoryFilter.value !== "all") {
    params.set("filter", inventoryFilter.value);
  }
  const needle = searchInput.value.trim();
  if (needle.length > 0) {
    params.set("q", needle);
  }
  const query = params.toString();
  void router.push(query.length === 0 ? inventoryHref.value : `${inventoryHref.value}?${query}`);
}

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
      <p class="overline">{{ isCreate ? createOverline : (view?.overline ?? "Skills") }}</p>
      <h1 class="page-title">{{ isCreate ? "New skill" : (view?.title ?? "Skills") }}</h1>
      <p class="page-description">
        {{
          isCreate
            ? "Create a reusable procedure for agents to load at start. Details, the body, and references save as one bundle."
            : (view?.description ?? "Reusable procedures every application can load.")
        }}
      </p>
      <div v-if="!isCreate && view !== undefined" class="page-meta">
        <span v-for="entry in view.meta" :key="entry" class="mono">{{ entry }}</span>
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
            <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
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
      <p v-if="loading && view !== undefined" class="hint" role="status" aria-live="polite">
        Updating skills…
      </p>

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
            <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
          </div>
        </div>
      </section>

      <p v-else-if="view === undefined" class="hint" role="status" aria-live="polite">
        Loading skills…
      </p>

      <template v-else>
        <SkillsScopeNav :model="view.scope" />

        <div class="workbench-grid section">
          <div class="stack">
            <div class="toolbar skill-toolbar" data-skill-inventory-toolbar>
              <form class="cluster" aria-label="Search skills" @submit.prevent="submitSearch">
                <label class="sr-only" for="skill-search">Search skills</label>
                <input
                  v-if="view.search.hiddenFilter !== null"
                  type="hidden"
                  name="filter"
                  :value="view.search.hiddenFilter"
                >
                <input
                  id="skill-search"
                  v-model="searchInput"
                  class="input search-input"
                  type="search"
                  name="q"
                  placeholder="Search skills"
                  autocomplete="off"
                >
                <button class="btn btn-secondary" type="submit">
                  <AppIcon name="search" />Search
                </button>
              </form>
              <section class="segmented" aria-label="Filter skills">
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
            </div>

            <p class="hint" data-skill-count>
              {{ view.matchedCount }} of {{ view.allCount }} skills at this scope
            </p>

            <div v-if="view.empty !== null" class="empty-state">
              <div class="empty-state__icon">
                <AppIcon :name="view.empty.iconName" />
              </div>
              <h2 class="h3">{{ view.empty.title }}</h2>
              <p class="body">{{ view.empty.body }}</p>
              <SmartLink
                class="btn"
                :class="`btn-${view.empty.actionStyle}`"
                :to="view.empty.actionHref"
              >
                <AppIcon v-if="view.empty.actionIcon !== null" :name="view.empty.actionIcon" />
                {{ view.empty.actionLabel }}
              </SmartLink>
            </div>

            <div v-else class="table-wrap card" data-skill-inventory>
              <table class="table table--stack skill-inventory-table">
                <thead>
                  <tr>
                    <th scope="col">Skill</th>
                    <th scope="col">Origin</th>
                    <th scope="col">State</th>
                    <th scope="col">References</th>
                    <th scope="col">Updated</th>
                    <th scope="col"><span class="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in rows"
                    :key="`${row.id}-${row.state}`"
                    :data-skill-name="row.name"
                    :data-skill-state="row.state"
                    :data-skill-state-label="row.stateLabel"
                  >
                    <td class="table__primary" data-label="Skill">
                      <SmartLink class="mono" :to="row.href">{{ row.name }}</SmartLink>
                      <p class="small">{{ row.description }}</p>
                      <SmartLink
                        v-if="row.effectiveHref !== null"
                        class="small"
                        :to="row.effectiveHref"
                        data-skill-effective-link
                      >
                        Open effective source
                      </SmartLink>
                    </td>
                    <td data-label="Origin">
                      <span class="cluster">
                        <span class="badge">{{
                          row.originScope === "app"
                            ? "Application"
                            : row.originScope === "project"
                              ? "Project"
                              : "Global"
                        }}</span>
                        <span class="small">{{ row.originText }}</span>
                      </span>
                    </td>
                    <td data-label="State">
                      <span class="cluster">
                        <span class="badge" :class="stateTone(row.state)">{{
                          row.stateLabel
                        }}</span>
                        <span
                          v-if="row.issues.length > 0"
                          class="status"
                          data-state="failed"
                          :title="row.issues[0]?.message"
                        >
                          <AppIcon name="alert-triangle" />
                          <span class="sr-only">Invalid</span>
                        </span>
                        <span
                          v-if="row.collisions.length > 0"
                          class="status"
                          data-state="awaiting_approval"
                          :title="row.collisions[0]?.text"
                        >
                          <AppIcon name="alert-triangle" />
                          <span class="sr-only">Collision</span>
                        </span>
                      </span>
                    </td>
                    <td data-label="References">
                      <span v-if="row.references === 0" class="hint mono">0</span>
                      <span v-else class="mono">{{ row.references }}</span>
                    </td>
                    <td data-label="Updated">
                      <span class="mono" :title="row.updatedAt">{{ row.updatedLabel }}</span>
                    </td>
                    <td class="table__actions">
                      <SmartLink
                        class="btn btn-ghost btn-icon"
                        :to="row.href"
                        :aria-label="row.actionLabel"
                      >
                        <AppIcon name="chevron-right" />
                      </SmartLink>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <aside class="rail-stack" aria-label="Skills information">
            <section class="card">
              <div class="card__head">
                <h2 class="card__title">Scope &amp; inheritance</h2>
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
                <h2 class="card__title">Skill root warnings</h2>
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
                <h2 class="card__title">Summary</h2>
              </div>
              <div class="card__body stack--tight">
                <p class="mono">
                  {{ view.counts.enabled }} enabled · {{ view.counts.inherited }} inherited
                </p>
                <p class="mono">
                  {{ view.counts.disabled }} disabled · {{ view.counts.invalid }} invalid
                </p>
                <p class="hint">
                  Counts are Hanse-effective at this scope, not every skill on disk.
                </p>
              </div>
            </section>

            <section v-if="view.pending.length > 0" class="card" data-skill-restart-rail>
              <div class="card__head">
                <h2 class="card__title">Restart required</h2>
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
          </aside>
        </div>
      </template>
    </template>
  </div>
</template>
