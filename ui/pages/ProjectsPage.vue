<script setup lang="ts">
import { keepPreviousData, useQuery } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, apiQuery } from "../api.js";
import type { BootChrome, BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import NewProjectDialog from "../components/NewProjectDialog.vue";
import SmartLink from "../components/SmartLink.vue";
import { absoluteTime, timeAgo } from "../format.js";

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly appCount: number;
  readonly waitingCount: number;
  readonly updatedAt: string;
  readonly deleting: boolean;
}

interface ProjectsProps {
  readonly query: string;
  readonly rows: readonly ProjectRow[];
  readonly projectCount: number;
  readonly appCount: number;
  readonly matchedCount: number;
}

interface ProjectsResponse extends ProjectsProps {
  readonly chrome?: BootChrome;
}

const EMPTY: ProjectsProps = {
  query: "",
  rows: [],
  projectCount: 0,
  appCount: 0,
  matchedCount: 0,
};

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();

// A route reached by client navigation still receives the boot payload of the first document.
// Only trust it when it belongs to this page; otherwise fetch the current props.
const bootProps =
  props.boot.route.id === "projects" ? (props.boot.props as ProjectsProps) : undefined;
const initialQuery = typeof bootProps?.query === "string" ? bootProps.query : "";

const activeQuery = computed(() => {
  const raw = route.query.q;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
});

const searchInput = ref(activeQuery.value);
watch(activeQuery, (value) => {
  searchInput.value = value;
});

const projectsQuery = useQuery<ProjectsResponse>({
  queryKey: computed(() => ["projects", activeQuery.value]),
  queryFn: () =>
    apiQuery<ProjectsResponse>(
      activeQuery.value.length === 0
        ? "/api/ui/projects"
        : `/api/ui/projects?q=${encodeURIComponent(activeQuery.value)}`,
    ),
  initialData: () =>
    bootProps !== undefined && activeQuery.value === initialQuery ? bootProps : undefined,
  placeholderData: keepPreviousData,
  staleTime: 30_000,
  retry: false,
});

const view = computed<ProjectsProps>(() => projectsQuery.data.value ?? bootProps ?? EMPTY);
const hasData = computed(() => projectsQuery.data.value !== undefined || bootProps !== undefined);
const loading = computed(() => projectsQuery.isFetching.value);
const failed = computed(() => projectsQuery.isError.value);
const failure = computed(() => {
  const error = projectsQuery.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load projects.";
});

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function projectHref(row: ProjectRow): string {
  return `/projects/${encodeURIComponent(row.id)}`;
}

function onSearch(): void {
  const q = searchInput.value.trim();
  void router.push({ path: "/projects", query: q.length === 0 ? {} : { q } });
}

const newProjectDialog = ref<InstanceType<typeof NewProjectDialog> | null>(null);

function openDialog(): void {
  newProjectDialog.value?.open();
}
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Workbench</p>
      <h1 class="page-title">Projects</h1>
      <p class="page-description">
        Every project discovered under the workspace root, with its applications and handoff
        activity.
      </p>
      <div class="page-meta">
        <span class="mono">{{ plural(view.projectCount, "project") }}</span>
        <span class="mono">{{ plural(view.appCount, "application") }}</span>
      </div>
    </div>
    <div v-if="view.projectCount > 0" class="page-header__actions">
      <button class="btn btn-primary" type="button" @click="openDialog">
        <AppIcon name="plus" />New project
      </button>
    </div>
  </header>

  <div class="page__body">
    <p v-if="loading && hasData" class="hint" role="status" aria-live="polite">
      Updating projects…
    </p>

    <section v-if="failed" class="card" aria-labelledby="projects-error-title">
      <div class="card__head">
        <h2 class="card__title" id="projects-error-title">Projects could not be loaded</h2>
      </div>
      <div class="card__body stack--tight">
        <p class="form-error" role="alert">{{ failure }}</p>
        <div class="cluster">
          <button class="btn btn-secondary btn-sm" type="button" @click="projectsQuery.refetch()">
            <AppIcon name="refresh" />Retry
          </button>
          <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
        </div>
      </div>
    </section>

    <p v-else-if="!hasData" class="hint" role="status" aria-live="polite">Loading projects…</p>

    <template v-else-if="view.projectCount === 0">
      <div class="empty-state">
        <span class="empty-state__mark"><AppIcon name="folder" class-name="icon--lg" /></span>
        <h3 class="empty-state__title">No projects yet</h3>
        <p class="empty-state__body">
          Create a project, or mount a folder with .hanse/project.yaml and restart the coordinator.
        </p>
        <div class="cluster">
          <button class="btn btn-primary btn-sm" type="button" @click="openDialog">
            <AppIcon name="plus" />New project
          </button>
        </div>
      </div>
      <p class="hint">
        A project is a folder with a manifest. Applications are repositories inside it, each with an
        isolated agent state.
      </p>
    </template>

    <div v-else-if="view.matchedCount === 0" class="empty-state">
      <span class="empty-state__mark"><AppIcon name="search" class-name="icon--lg" /></span>
      <h3 class="empty-state__title">No matching projects</h3>
      <p class="empty-state__body">
        Nothing matches “{{ view.query }}”. Search by project name or root path.
      </p>
      <div class="cluster">
        <SmartLink class="btn btn-secondary btn-sm" to="/projects">Clear search</SmartLink>
      </div>
    </div>

    <template v-else>
      <!-- biome-ignore lint/a11y/useSemanticElements: keep the legacy form contract and classes -->
      <form
        class="toolbar"
        method="get"
        action="/projects"
        role="search"
        @submit.prevent="onSearch"
      >
        <label class="sr-only" for="project-search">Search projects</label>
        <input
          id="project-search"
          v-model="searchInput"
          class="input search-input"
          name="q"
          placeholder="Name or root path"
          autocomplete="off"
        >
        <button class="btn btn-secondary" type="submit"><AppIcon name="search" />Search</button>
        <SmartLink v-if="view.query.length > 0" class="btn btn-ghost" to="/projects">
          Clear search
        </SmartLink>
      </form>

      <section class="card" aria-labelledby="projects-table-title">
        <div class="card__head">
          <h2 class="card__title" id="projects-table-title">Project ledger</h2>
          <span class="mono">{{ plural(view.matchedCount, "project") }}</span>
        </div>
        <div class="card__body card__body--flush">
          <div class="table-wrap">
            <table class="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Root path</th>
                  <th scope="col">Apps</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Updated</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in view.rows" :key="row.id">
                  <td data-label="Project">
                    <div class="cluster">
                      <SmartLink class="table__primary" :to="projectHref(row)">
                        {{ row.name }}
                      </SmartLink>
                      <span v-if="row.deleting" class="status" data-state="failed">
                        <AppIcon name="alert-triangle" />Deletion incomplete
                      </span>
                    </div>
                  </td>
                  <td data-label="Root path"><span class="mono">{{ row.rootPath }}</span></td>
                  <td data-label="Apps" class="table__num">{{ row.appCount }}</td>
                  <td data-label="Waiting" class="table__num">{{ row.waitingCount }}</td>
                  <td data-label="Updated">
                    <span class="mono table__nowrap">
                      <time :datetime="row.updatedAt" :title="absoluteTime(row.updatedAt)">
                        {{ timeAgo(row.updatedAt) }}
                      </time>
                    </span>
                  </td>
                  <td data-label="Actions" class="table__actions">
                    <a
                      class="btn btn-ghost btn-icon btn-sm"
                      :href="projectHref(row)"
                      :aria-label="`Open ${row.name}`"
                    >
                      <AppIcon name="chevron-right" />
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </template>
  </div>

  <NewProjectDialog ref="newProjectDialog" />
</template>
