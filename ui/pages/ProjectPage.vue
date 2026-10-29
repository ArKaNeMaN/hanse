<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, nextTick, ref } from "vue";
import { useRoute } from "vue-router";
import { ApiError, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import AddAppDialog from "../components/AddAppDialog.vue";
import AppIcon from "../components/AppIcon.vue";
import HandoffReviewDialog from "../components/HandoffReviewDialog.vue";
import NewHandoffDialog from "../components/NewHandoffDialog.vue";
import ProjectDeleteDialog from "../components/ProjectDeleteDialog.vue";
import ProjectPolicyCard from "../components/ProjectPolicyCard.vue";
import RouteText from "../components/RouteText.vue";
import SmartLink from "../components/SmartLink.vue";
import StatusPill from "../components/StatusPill.vue";
import { applyChrome } from "../composables/useChrome.js";
import { absoluteTime, timeAgo } from "../format.js";
import type { ProjectHandoff, ProjectProps, ProjectResponse } from "../project-types.js";
import { replyPill, runtimePill, statusPill } from "../status.js";

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();

const projectId = computed(() => {
  const raw = route.params.id;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : "";
});

// A route reached by client navigation still receives the boot payload of the first document.
// Only trust it when it belongs to this exact project; otherwise fetch the current props.
const bootMatches = computed(
  () => props.boot.route.id === "project" && props.boot.route.params.id === projectId.value,
);
const bootProps = computed<ProjectProps | undefined>(() => {
  if (!bootMatches.value) return undefined;
  const value = props.boot.props;
  return typeof value === "object" && value !== null ? (value as ProjectProps) : undefined;
});

const projectQuery = useQuery<ProjectResponse>({
  queryKey: computed(() => ["project", projectId.value]),
  queryFn: () =>
    apiQuery<ProjectResponse>(`/api/ui/projects/${encodeURIComponent(projectId.value)}`),
  initialData: () => bootProps.value,
  staleTime: 30_000,
  retry: false,
});

const view = computed<ProjectProps | undefined>(() => projectQuery.data.value ?? bootProps.value);
const hasData = computed(() => view.value !== undefined);
const loading = computed(() => projectQuery.isFetching.value);
const failed = computed(() => projectQuery.isError.value);
const notFound = computed(() => {
  const error = projectQuery.error.value;
  return error instanceof ApiError && error.status === 404;
});
const failure = computed(() => {
  const error = projectQuery.error.value;
  if (notFound.value) {
    return "This project no longer exists. It may have been deleted or renamed.";
  }
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load this project.";
});

const masterSummary = computed(() =>
  view.value?.master === true ? view.value.masterSummary : null,
);

const apps = computed(() =>
  (view.value?.apps ?? []).map((app) => ({ ...app, pill: runtimePill(app.runtime) })),
);
const handoffs = computed(() =>
  [...(view.value?.handoffs ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((handoff) => ({
      ...handoff,
      statePill: statusPill(handoff.state),
      reply: replyPill(handoff.replyState),
    })),
);
const waiting = computed(() =>
  (view.value?.waitingHandoffs ?? []).map((handoff) => ({
    ...handoff,
    statePill: statusPill(handoff.displayState),
  })),
);

const addAppDialog = ref<InstanceType<typeof AddAppDialog> | null>(null);
const newHandoffDialog = ref<InstanceType<typeof NewHandoffDialog> | null>(null);
const deleteDialog = ref<InstanceType<typeof ProjectDeleteDialog> | null>(null);
const reviewDialog = ref<InstanceType<typeof HandoffReviewDialog> | null>(null);
const reviewHandoff = ref<ProjectHandoff | null>(null);

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

async function openReview(id: string): Promise<void> {
  const handoff = view.value?.handoffs.find((candidate) => candidate.id === id);
  if (handoff === undefined) return;
  reviewHandoff.value = handoff;
  await nextTick();
  reviewDialog.value?.open();
}

/** Refetch the project (and its chrome counters) after any successful mutation. */
async function refreshProject(): Promise<void> {
  const result = await projectQuery.refetch();
  const chrome = (result.data as ProjectResponse | undefined)?.chrome;
  if (chrome !== undefined) {
    applyChrome(chrome);
  }
}
</script>

<template>
  <template v-if="failed">
    <header class="page-header">
      <div class="page-header__main">
        <p class="overline">Project</p>
        <h1 class="page-title">Project</h1>
      </div>
    </header>
    <div class="page__body">
      <section class="card" aria-labelledby="project-error-title">
        <div class="card__head">
          <h2 class="card__title" id="project-error-title">
            {{ notFound ? "Project not found" : "Project could not be loaded" }}
          </h2>
        </div>
        <div class="card__body stack--tight">
          <p class="form-error" role="alert">{{ failure }}</p>
          <div class="cluster">
            <button class="btn btn-secondary btn-sm" type="button" @click="projectQuery.refetch()">
              <AppIcon name="refresh" />Retry
            </button>
            <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
          </div>
        </div>
      </section>
    </div>
  </template>

  <template v-else-if="view === undefined">
    <header class="page-header">
      <div class="page-header__main">
        <p class="overline">Project</p>
        <h1 class="page-title">Project</h1>
      </div>
    </header>
    <div class="page__body">
      <p class="hint" role="status" aria-live="polite">Loading project…</p>
    </div>
  </template>

  <template v-else-if="masterSummary !== null">
    <header class="page-header">
      <div class="page-header__main">
        <p class="overline">Master</p>
        <h1 class="page-title">Hanse master</h1>
        <p class="page-description">
          Built-in assistant that configures and operates this Hanse instance.
        </p>
        <div class="page-meta">
          <span class="mono">{{ masterSummary.runtime }}</span>
          <span class="mono">{{ masterSummary.path }}</span>
        </div>
      </div>
      <div class="page-header__actions">
        <a class="btn btn-primary" :href="masterSummary.chatHref">
          <AppIcon name="message" />Open chat
        </a>
        <a class="btn btn-secondary" :href="masterSummary.settingsHref">
          <AppIcon name="settings" />Settings
        </a>
      </div>
    </header>

    <div class="page__body">
      <div class="watch-strip watch-strip--2">
        <div class="watch">
          <p class="watch__value">
            <StatusPill :pill="runtimePill(masterSummary.runtime)" />
          </p>
          <p class="watch__label">Runtime</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ masterSummary.kind }}</p>
          <p class="watch__label">Kind</p>
        </div>
      </div>
      <section class="card section" aria-labelledby="master-card-title">
        <div class="card__head">
          <h2 class="card__title" id="master-card-title">Master agent</h2>
          <span class="badge badge--mono">system</span>
        </div>
        <div class="card__body stack--tight">
          <p class="small">
            The master runs as an isolated agent. It creates projects and applications, writes their
            instructions, changes non-secret settings, and starts or restarts application agents
            through its Hanse tools.
          </p>
          <p class="small">
            Its own directory is coordinator-managed and read-only inside its container. Its
            instructions are rewritten from the coordinator on every start.
          </p>
          <p class="small">
            Skills can be created, inspected, updated, enabled/disabled, and overridden from the
            master chat; deleting or renaming them stays operator-only. Provider keys, git
            credentials, image builds, and project deletion are operator-only UI actions.
          </p>
        </div>
        <div class="card__foot">
          <a class="btn btn-secondary btn-sm" :href="masterSummary.chatHref">
            <AppIcon name="message" />Open chat
          </a>
          <a class="btn btn-ghost btn-sm" :href="masterSummary.settingsHref">
            <AppIcon name="settings" />Application settings
          </a>
          <a class="btn btn-ghost btn-sm" :href="masterSummary.skillsHref">
            <AppIcon name="code" />Skills
          </a>
        </div>
      </section>
    </div>
  </template>

  <template v-else>
    <header class="page-header">
      <div class="page-header__main">
        <p class="overline">Project</p>
        <h1 class="page-title">{{ view.project.name }}</h1>
        <p class="page-description">
          Applications, handoff routes, and runtime state for this project.
        </p>
        <div class="page-meta">
          <span class="mono">{{ view.project.rootPath }}</span>
          <span class="mono">base {{ view.project.baseBranch }}</span>
          <span class="mono">{{ plural(view.apps.length, "application") }}</span>
          <span class="mono">{{ view.counts.waiting }} waiting</span>
        </div>
      </div>
      <div class="page-header__actions">
        <a class="btn btn-secondary" :href="view.hrefs.settings">
          <AppIcon name="settings" />Settings
        </a>
        <a class="btn btn-secondary" :href="view.hrefs.ide" target="_blank" rel="noreferrer">
          <AppIcon name="external" />Open IDE
        </a>
        <button class="btn btn-primary" type="button" @click="newHandoffDialog?.open()">
          <AppIcon name="branch" />New handoff
        </button>
      </div>
    </header>

    <div class="page__body">
      <p v-if="loading && hasData" class="hint" role="status" aria-live="polite">
        Updating project…
      </p>

      <div class="watch-strip watch-strip--4">
        <div class="watch">
          <p class="watch__value">{{ view.apps.length }}</p>
          <p class="watch__label">Applications</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ view.counts.running }}</p>
          <p class="watch__label">Running</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ view.counts.waiting }}</p>
          <p class="watch__label">Waiting</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ timeAgo(view.lastActivity) }}</p>
          <p class="watch__label">Last activity</p>
        </div>
      </div>

      <div class="workbench-grid workbench-grid--detail section">
        <div class="stack">
          <section class="card" aria-labelledby="apps-title">
            <div class="card__head">
              <h2 class="card__title" id="apps-title">Applications</h2>
              <div class="cluster">
                <span class="badge">{{ plural(view.apps.length, "app") }}</span>
                <button class="btn btn-ghost btn-sm" type="button" @click="addAppDialog?.open()">
                  <AppIcon name="plus" />Add app
                </button>
              </div>
            </div>
            <div class="card__body" :class="{ 'card__body--flush': view.apps.length > 0 }">
              <div v-if="view.apps.length === 0" class="empty-state">
                <span class="empty-state__mark">
                  <AppIcon name="folder" class-name="icon--lg" />
                </span>
                <h3 class="empty-state__title">No applications</h3>
                <p class="empty-state__body">
                  Add the first application to this project, then start a chat with its agent.
                </p>
                <div class="cluster">
                  <button
                    class="btn btn-secondary btn-sm"
                    type="button"
                    @click="addAppDialog?.open()"
                  >
                    <AppIcon name="plus" />Add application
                  </button>
                </div>
              </div>
              <div v-else class="table-wrap">
                <table class="table table--stack">
                  <thead>
                    <tr>
                      <th scope="col">Application</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Path</th>
                      <th scope="col">Runtime</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="app in apps" :key="app.id">
                      <td data-label="Application">
                        <div class="cluster">
                          <strong class="table__primary">
                            <SmartLink :to="app.href">{{ app.appKey }}</SmartLink>
                          </strong>
                          <span v-if="app.deleting" class="status" data-state="failed">
                            <AppIcon name="alert-triangle" />Deletion incomplete
                          </span>
                        </div>
                      </td>
                      <td data-label="Kind">
                        <span class="badge badge--mono">{{ app.kind }}</span>
                      </td>
                      <td data-label="Path"><span class="mono">{{ app.path }}</span></td>
                      <td data-label="Runtime">
                        <div class="cluster">
                          <StatusPill :pill="app.pill" />
                          <a
                            v-if="app.pendingRestart"
                            class="badge badge-warning"
                            :href="app.restartHref"
                          >
                            Restart required
                          </a>
                        </div>
                      </td>
                      <td data-label="Actions" class="table__actions">
                        <div class="table__action-group">
                          <a
                            v-if="app.chatHref !== null"
                            class="btn btn-ghost btn-sm"
                            :href="app.chatHref"
                          >
                            <AppIcon name="message" />Chat
                          </a>
                          <a
                            class="btn btn-ghost btn-icon btn-sm"
                            :href="app.ideHref"
                            target="_blank"
                            rel="noreferrer"
                            :aria-label="`Open ${app.appKey} in IDE`"
                            title="Open in IDE"
                          >
                            <AppIcon name="external" />
                          </a>
                          <SmartLink
                            class="btn btn-ghost btn-icon btn-sm"
                            :to="app.href"
                            :aria-label="`Open ${app.appKey} application`"
                            title="Open application"
                          >
                            <AppIcon name="chevron-right" />
                          </SmartLink>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section class="card" aria-labelledby="project-handoffs-title">
            <div class="card__head">
              <h2 class="card__title" id="project-handoffs-title">Handoffs</h2>
              <span class="mono">{{ view.counts.handoffs }}</span>
            </div>
            <div class="card__body" :class="{ 'card__body--flush': view.handoffs.length > 0 }">
              <div v-if="view.handoffs.length === 0" class="empty-state">
                <span class="empty-state__mark">
                  <AppIcon name="branch" class-name="icon--lg" />
                </span>
                <h3 class="empty-state__title">No handoffs yet</h3>
                <p class="empty-state__body">
                  Route a change to a sibling application. Approval keeps the request in the inbox
                  until an operator decides.
                </p>
                <div class="cluster">
                  <button
                    class="btn btn-secondary btn-sm"
                    type="button"
                    @click="newHandoffDialog?.open()"
                  >
                    <AppIcon name="plus" />New handoff
                  </button>
                </div>
              </div>
              <div v-else class="table-wrap">
                <table class="table table--stack table--handoffs">
                  <thead>
                    <tr>
                      <th scope="col">Route</th>
                      <th scope="col">State</th>
                      <th scope="col">Summary</th>
                      <th scope="col">Updated</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="handoff in handoffs" :id="`handoff-${handoff.id}`" :key="handoff.id">
                      <td data-label="Route">
                        <RouteText :from="handoff.fromAppKey" :to="handoff.toAppKey" />
                      </td>
                      <td data-label="State">
                        <div class="cluster">
                          <StatusPill :pill="handoff.statePill" />
                          <StatusPill v-if="handoff.reply !== undefined" :pill="handoff.reply" />
                        </div>
                      </td>
                      <td data-label="Summary">
                        <span class="table__primary">{{ handoff.summary }}</span>
                      </td>
                      <td data-label="Updated">
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
                        <button
                          class="btn btn-ghost btn-sm"
                          type="button"
                          @click="openReview(handoff.id)"
                        >
                          Review
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <ProjectPolicyCard
            :project-id="view.project.id"
            :policy="view.policy"
            :return-to="view.deletion.returnTo"
            @changed="refreshProject"
          />
        </div>

        <aside class="rail-stack" aria-label="Project attention">
          <section class="card" aria-labelledby="project-waiting-title">
            <div class="card__head">
              <h2 class="card__title" id="project-waiting-title">Waiting for approval</h2>
              <span class="mono">{{ view.waitingHandoffs.length }}</span>
            </div>
            <div class="card__body">
              <div v-if="waiting.length === 0" class="empty-state">
                <span class="empty-state__mark">
                  <AppIcon name="inbox" class-name="icon--lg" />
                </span>
                <h3 class="empty-state__title">Nothing waiting</h3>
                <p class="empty-state__body">Approval requests from this project appear here.</p>
                <div class="cluster">
                  <a class="btn btn-secondary btn-sm" href="/handoffs?filter=waiting">
                    Open inbox
                  </a>
                </div>
              </div>
              <div v-else class="stack">
                <article
                  v-for="handoff in waiting"
                  :key="handoff.id"
                  class="route-card"
                  :data-state="handoff.displayState"
                >
                  <div class="route-card__head">
                    <span class="mono table__nowrap">{{ handoff.id.slice(0, 8) }}</span>
                    <StatusPill :pill="handoff.statePill" />
                  </div>
                  <div
                    class="route"
                    :aria-label="`Handoff from ${handoff.fromAppKey} to ${handoff.toAppKey}`"
                  >
                    <span class="route__end">
                      <span class="route__app">{{ handoff.fromAppKey }}</span>
                      <span class="route__meta">origin</span>
                    </span>
                    <span class="route__track" aria-hidden="true">
                      <span class="route__node"></span>
                      <span class="route__seal"><AppIcon :name="handoff.statePill.icon" /></span>
                      <span class="route__node"></span>
                    </span>
                    <span class="route__end route__end--to">
                      <span class="route__app">{{ handoff.toAppKey }}</span>
                      <span class="route__meta">target</span>
                    </span>
                  </div>
                  <p class="route-card__summary">{{ handoff.summary }}</p>
                  <div class="route-card__foot">
                    <span class="mono table__nowrap">
                      <time :datetime="handoff.updatedAt" :title="absoluteTime(handoff.updatedAt)">
                        {{ timeAgo(handoff.updatedAt) }}
                      </time>
                    </span>
                    <button
                      class="btn btn-ghost btn-sm"
                      type="button"
                      @click="openReview(handoff.id)"
                    >
                      Review <AppIcon name="arrow-right" />
                    </button>
                  </div>
                </article>
              </div>
            </div>
          </section>

          <section class="card" aria-labelledby="manifest-title">
            <div class="card__head">
              <h2 class="card__title" id="manifest-title">Manifest</h2>
              <span class="badge badge--mono">project</span>
            </div>
            <div class="card__body stack--tight">
              <div class="stack--tight">
                <span class="overline">Manifest</span>
                <span class="mono">.hanse/project.yaml</span>
              </div>
              <div class="stack--tight">
                <span class="overline">Base branch</span>
                <span class="mono">{{ view.project.baseBranch }}</span>
              </div>
              <div class="stack--tight">
                <span class="overline">Applications</span>
                <span class="mono">{{ view.apps.length }}</span>
              </div>
              <div class="stack--tight">
                <span class="overline">Root path</span>
                <span class="mono">{{ view.project.rootPath }}</span>
              </div>
            </div>
            <div class="card__foot">
              <a
                class="btn btn-ghost btn-sm"
                :href="view.hrefs.ide"
                target="_blank"
                rel="noreferrer"
              >
                <AppIcon name="external" />Open IDE
              </a>
            </div>
          </section>
        </aside>
      </div>

      <section class="card section" id="danger-zone" aria-labelledby="danger-zone-title">
        <div class="card__head">
          <h2 class="card__title" id="danger-zone-title">Danger zone</h2>
          <span v-if="view.deletion.deleting" class="status" data-state="failed">
            <AppIcon name="alert-triangle" />Deletion incomplete
          </span>
          <span v-else class="badge">Destructive</span>
        </div>
        <div class="card__body stack--tight">
          <p v-if="view.deletion.deleting" class="small">
            A previous deletion did not finish. Retry to remove the remaining applications, records,
            and runtime resources. Chat and start stay disabled until deletion completes.
          </p>
          <p v-else class="small">
            Deleting this project removes every application, session, handoff, credential, and
            managed image. Source files are kept unless you choose to delete them too.
          </p>
        </div>
        <div class="card__foot">
          <button class="btn btn-danger" type="button" @click="deleteDialog?.open()">
            <AppIcon name="trash" />
            {{ view.deletion.deleting ? "Retry deletion" : "Delete project" }}
          </button>
        </div>
      </section>

      <AddAppDialog ref="addAppDialog" :dialog="view.dialogs.addApp" @saved="refreshProject" />
      <ProjectDeleteDialog ref="deleteDialog" :deletion="view.deletion" @deleted="refreshProject" />
      <NewHandoffDialog
        ref="newHandoffDialog"
        :dialog="view.dialogs.newHandoff"
        @saved="refreshProject"
      />
      <HandoffReviewDialog
        v-if="reviewHandoff !== null"
        ref="reviewDialog"
        :handoff="reviewHandoff"
        @changed="refreshProject"
      />
    </div>
  </template>
</template>
