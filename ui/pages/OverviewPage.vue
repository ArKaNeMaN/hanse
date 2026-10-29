<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { ApiError, apiQuery } from "../api.js";
import type { BootChrome, BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import NewProjectDialog from "../components/NewProjectDialog.vue";
import RouteCard from "../components/RouteCard.vue";
import RouteText from "../components/RouteText.vue";
import SmartLink from "../components/SmartLink.vue";
import StatusPill from "../components/StatusPill.vue";
import { absoluteTime, timeAgo } from "../format.js";
import {
  type HandoffReplyState,
  type HandoffState,
  replyPill,
  runtimePill,
  statusPill,
} from "../status.js";

interface OverviewCounts {
  readonly projects: number;
  readonly applications: number;
  readonly running: number;
  readonly starting: number;
  readonly stopped: number;
  readonly error: number;
  readonly handoffsWaiting: number;
  readonly handoffsTotal: number;
}

interface OverviewProjectRow {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly appCount: number;
  readonly waitingCount: number;
  readonly lastActivity: string;
  readonly deleting: boolean;
}

interface OverviewHandoffRow {
  readonly id: string;
  readonly fromAppId: string;
  readonly toAppId: string;
  readonly fromAppKey: string;
  readonly toAppKey: string;
  readonly summary: string;
  readonly state: HandoffState;
  readonly replyState: HandoffReplyState;
  readonly updatedAt: string;
  readonly reviewHref: string;
}

interface OverviewWaitingHandoff extends OverviewHandoffRow {
  readonly displayState: HandoffState;
}

interface OverviewProps {
  readonly counts: OverviewCounts;
  readonly projects: readonly OverviewProjectRow[];
  readonly recentHandoffs: readonly OverviewHandoffRow[];
  readonly waitingHandoffs: readonly OverviewWaitingHandoff[];
}

interface OverviewResponse extends OverviewProps {
  readonly chrome?: BootChrome;
}

const EMPTY: OverviewProps = {
  counts: {
    projects: 0,
    applications: 0,
    running: 0,
    starting: 0,
    stopped: 0,
    error: 0,
    handoffsWaiting: 0,
    handoffsTotal: 0,
  },
  projects: [],
  recentHandoffs: [],
  waitingHandoffs: [],
};

const props = defineProps<{ boot: BootPayload }>();

// A route reached by client navigation still receives the boot payload of the first document.
// Only trust it when it belongs to this page; otherwise fetch the current props.
const bootProps =
  props.boot.route.id === "overview" ? (props.boot.props as OverviewProps) : undefined;

const overviewQuery = useQuery<OverviewResponse>({
  queryKey: ["overview"],
  queryFn: () => apiQuery<OverviewResponse>("/api/ui/overview"),
  initialData: () => bootProps,
  staleTime: 30_000,
  retry: false,
});

const view = computed<OverviewProps>(() => overviewQuery.data.value ?? bootProps ?? EMPTY);
const hasData = computed(() => overviewQuery.data.value !== undefined || bootProps !== undefined);
const loading = computed(() => overviewQuery.isFetching.value);
const failed = computed(() => overviewQuery.isError.value);
const failure = computed(() => {
  const error = overviewQuery.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load the fleet overview.";
});

const runtime = computed(() => [
  { label: "Starting", count: view.value.counts.starting, pill: runtimePill("starting") },
  { label: "Running", count: view.value.counts.running, pill: runtimePill("running") },
  { label: "Stopped", count: view.value.counts.stopped, pill: runtimePill("stopped") },
  { label: "Error", count: view.value.counts.error, pill: runtimePill("error") },
]);

const recentRows = computed(() =>
  view.value.recentHandoffs.map((handoff) => ({
    ...handoff,
    status: statusPill(handoff.state),
    reply: replyPill(handoff.replyState),
  })),
);

const newProjectDialog = ref<InstanceType<typeof NewProjectDialog> | null>(null);

function openNewProject(): void {
  newProjectDialog.value?.open();
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function projectHref(row: OverviewProjectRow): string {
  return `/projects/${encodeURIComponent(row.id)}`;
}
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Workbench</p>
      <h1 class="page-title">Fleet overview</h1>
      <p class="page-description">
        Current state of every project, application, and handoff in this workspace.
      </p>
      <div class="page-meta">
        <span class="mono">{{ plural(view.counts.projects, "project") }}</span>
        <span class="mono">{{ plural(view.counts.applications, "application") }}</span>
      </div>
    </div>
    <div v-if="view.counts.projects > 0" class="page-header__actions">
      <button
        class="btn btn-primary"
        type="button"
        data-dialog-open="new-project"
        @click="openNewProject"
      >
        <AppIcon name="plus" />New project
      </button>
    </div>
  </header>

  <div class="page__body">
    <p v-if="loading && hasData" class="hint" role="status" aria-live="polite">
      Updating overview…
    </p>

    <section v-if="failed" class="card" aria-labelledby="overview-error-title">
      <div class="card__head">
        <h2 class="card__title" id="overview-error-title">Fleet overview could not be loaded</h2>
      </div>
      <div class="card__body stack--tight">
        <p class="form-error" role="alert">{{ failure }}</p>
        <div class="cluster">
          <button class="btn btn-secondary btn-sm" type="button" @click="overviewQuery.refetch()">
            <AppIcon name="refresh" />Retry
          </button>
          <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
        </div>
      </div>
    </section>

    <p v-else-if="!hasData" class="hint" role="status" aria-live="polite">Loading overview…</p>

    <template v-else-if="view.counts.projects === 0">
      <div class="empty-state">
        <span class="empty-state__mark"><AppIcon name="folder" class-name="icon--lg" /></span>
        <h3 class="empty-state__title">No projects yet</h3>
        <p class="empty-state__body">
          Create a project, or mount a folder with .hanse/project.yaml and restart the coordinator.
        </p>
        <div class="cluster">
          <button class="btn btn-primary btn-sm" type="button" @click="openNewProject">
            <AppIcon name="plus" />New project
          </button>
        </div>
      </div>
      <p class="hint">
        The manifest is the source of truth: .hanse/project.yaml lists the project id, name, base
        branch, and applications.
      </p>
    </template>

    <template v-else>
      <div class="watch-strip watch-strip--4">
        <div class="watch">
          <p class="watch__value">{{ view.counts.projects }}</p>
          <p class="watch__label">Projects</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ view.counts.applications }}</p>
          <p class="watch__label">Applications</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ view.counts.running }}</p>
          <p class="watch__label">Agents running</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ view.counts.handoffsWaiting }}</p>
          <p class="watch__label">Handoffs waiting</p>
        </div>
      </div>

      <div class="workbench-grid section">
        <div class="stack">
          <section class="card" aria-labelledby="project-ledger-title">
            <div class="card__head">
              <h2 class="card__title" id="project-ledger-title">Project ledger</h2>
              <SmartLink class="btn btn-ghost btn-sm" to="/projects">
                All projects <AppIcon name="arrow-right" />
              </SmartLink>
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
                      <th scope="col">Last activity</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="project in view.projects" :key="project.id">
                      <td data-label="Project">
                        <div class="cluster">
                          <SmartLink class="table__primary" :to="projectHref(project)">
                            {{ project.name }}
                          </SmartLink>
                          <span v-if="project.deleting" class="status" data-state="failed">
                            <AppIcon name="alert-triangle" />Deletion incomplete
                          </span>
                        </div>
                      </td>
                      <td data-label="Root path">
                        <span class="mono">{{ project.rootPath }}</span>
                      </td>
                      <td data-label="Apps" class="table__num">{{ project.appCount }}</td>
                      <td data-label="Waiting" class="table__num">{{ project.waitingCount }}</td>
                      <td data-label="Last activity">
                        <span class="mono table__nowrap">
                          <time
                            :datetime="project.lastActivity"
                            :title="absoluteTime(project.lastActivity)"
                          >
                            {{ timeAgo(project.lastActivity) }}
                          </time>
                        </span>
                      </td>
                      <td data-label="Actions" class="table__actions">
                        <SmartLink
                          class="btn btn-ghost btn-icon btn-sm"
                          :to="projectHref(project)"
                          :aria-label="`Open ${project.name}`"
                        >
                          <AppIcon name="chevron-right" />
                        </SmartLink>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section class="card" aria-labelledby="recent-handoffs-title">
            <div class="card__head">
              <h2 class="card__title" id="recent-handoffs-title">Recent handoffs</h2>
              <SmartLink class="btn btn-ghost btn-sm" to="/handoffs">
                Handoffs inbox <AppIcon name="arrow-right" />
              </SmartLink>
            </div>
            <div
              class="card__body"
              :class="{ 'card__body--flush': view.recentHandoffs.length > 0 }"
            >
              <div v-if="view.recentHandoffs.length === 0" class="empty-state">
                <span class="empty-state__mark">
                  <AppIcon name="branch" class-name="icon--lg" />
                </span>
                <h3 class="empty-state__title">No handoffs yet</h3>
                <p class="empty-state__body">
                  Handoffs route work between applications. Open a project to create the first one.
                </p>
                <div class="cluster">
                  <SmartLink class="btn btn-secondary btn-sm" to="/projects">
                    Open a project
                  </SmartLink>
                </div>
              </div>
              <div v-else class="table-wrap">
                <table class="table table--stack table--handoffs">
                  <thead>
                    <tr>
                      <th scope="col">Route</th>
                      <th scope="col">Summary</th>
                      <th scope="col">State</th>
                      <th scope="col">Time</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="handoff in recentRows" :key="handoff.id">
                      <td data-label="Route">
                        <RouteText :from="handoff.fromAppKey" :to="handoff.toAppKey" />
                      </td>
                      <td data-label="Summary">
                        <span class="table__primary">{{ handoff.summary }}</span>
                      </td>
                      <td data-label="State">
                        <div class="cluster">
                          <StatusPill :pill="handoff.status" />
                          <StatusPill v-if="handoff.reply !== undefined" :pill="handoff.reply" />
                        </div>
                      </td>
                      <td data-label="Time">
                        <span class="mono table__nowrap">
                          <time
                            :datetime="handoff.updatedAt"
                            :title="absoluteTime(handoff.updatedAt)"
                          >
                            {{ timeAgo(handoff.updatedAt) }}
                          </time>
                        </span>
                      </td>
                      <td data-label="Actions" class="table__actions">
                        <SmartLink class="btn btn-ghost btn-sm" :to="handoff.reviewHref">
                          Review
                        </SmartLink>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>

        <aside class="rail-stack" aria-label="Attention and runtime">
          <section class="card" aria-labelledby="waiting-title">
            <div class="card__head">
              <h2 class="card__title" id="waiting-title">Waiting for approval</h2>
              <span class="mono">{{ view.waitingHandoffs.length }}</span>
            </div>
            <div class="card__body">
              <div v-if="view.waitingHandoffs.length === 0" class="empty-state">
                <span class="empty-state__mark">
                  <AppIcon name="inbox" class-name="icon--lg" />
                </span>
                <h3 class="empty-state__title">No handoffs waiting</h3>
                <p class="empty-state__body">
                  Requests that require operator approval arrive here.
                </p>
                <div class="cluster">
                  <SmartLink class="btn btn-secondary btn-sm" to="/handoffs">
                    Open inbox
                  </SmartLink>
                </div>
              </div>
              <div v-else class="stack">
                <RouteCard
                  v-for="handoff in view.waitingHandoffs"
                  :key="handoff.id"
                  :id="handoff.id"
                  :from="handoff.fromAppKey"
                  :to="handoff.toAppKey"
                  :summary="handoff.summary"
                  :state="handoff.displayState"
                  :updated-at="handoff.updatedAt"
                  :review-href="handoff.reviewHref"
                />
              </div>
            </div>
          </section>

          <section class="card" aria-labelledby="runtime-title">
            <div class="card__head">
              <h2 class="card__title" id="runtime-title">Runtime</h2>
              <span class="mono">{{ plural(view.counts.applications, "app") }}</span>
            </div>
            <div class="card__body stack--tight">
              <div v-for="row in runtime" :key="row.label" class="summary-row">
                <span class="small">{{ row.label }}</span>
                <span class="cluster">
                  <StatusPill :pill="row.pill" />
                  <span class="mono">{{ row.count }}</span>
                </span>
              </div>
            </div>
            <div class="card__foot">
              <SmartLink class="btn btn-ghost btn-sm" to="/projects">
                Inspect applications <AppIcon name="arrow-right" />
              </SmartLink>
            </div>
          </section>
        </aside>
      </div>
    </template>
  </div>

  <NewProjectDialog ref="newProjectDialog" />
</template>
