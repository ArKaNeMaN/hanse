<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { AppDeleteResult, AppProps, AppResponse, AppRuntimeLive } from "../app-types.js";
import type { BootPayload } from "../boot.js";
import AppDeleteDialog from "../components/AppDeleteDialog.vue";
import AppGitPanel from "../components/AppGitPanel.vue";
import AppGitRemotes from "../components/AppGitRemotes.vue";
import AppIcon from "../components/AppIcon.vue";
import AppImagePanel from "../components/AppImagePanel.vue";
import AppRestartDialog from "../components/AppRestartDialog.vue";
import AppSshPanel from "../components/AppSshPanel.vue";
import AppStateStrip from "../components/AppStateStrip.vue";
import { useAppGit } from "../composables/useAppGit.js";
import { useAppImage } from "../composables/useAppImage.js";
import { applyChrome } from "../composables/useChrome.js";
import { absoluteTime, timeAgo } from "../format.js";
import type { RuntimeState } from "../status.js";
import { useToastStore } from "../stores/toasts.js";

const RUNTIME_POLL_MS = 10_000;

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

function queryString(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

const projectId = computed(() => queryString(route.params.id));
const appKey = computed(() => queryString(route.params.app));

// A route reached by client navigation still receives the first document's boot payload. Trust it
// only for this exact application; otherwise fetch `/api/ui/apps/:app?project=`.
const bootProps = computed<AppProps | undefined>(() => {
  if (props.boot.route.id !== "app") return undefined;
  if (props.boot.route.params.id !== projectId.value) return undefined;
  if (props.boot.route.params.app !== appKey.value) return undefined;
  const value = props.boot.props;
  return typeof value === "object" && value !== null ? (value as AppProps) : undefined;
});

const apiPath = computed(
  () =>
    `/api/ui/apps/${encodeURIComponent(appKey.value)}?project=${encodeURIComponent(projectId.value)}`,
);

const appQuery = useQuery<AppResponse>({
  queryKey: computed(() => ["app", projectId.value, appKey.value]),
  queryFn: () => apiQuery<AppResponse>(apiPath.value),
  initialData: () => bootProps.value,
  initialDataUpdatedAt: 0,
  // Boot props never carry the git read summary; refetch on mount so the workbench fills in.
  staleTime: 0,
  refetchOnMount: "always",
  retry: false,
});

const view = computed<AppProps | undefined>(() => appQuery.data.value ?? bootProps.value);
const hasData = computed(() => view.value !== undefined);
const loading = computed(() => appQuery.isFetching.value);
const failed = computed(() => appQuery.isError.value);
const notFound = computed(() => {
  const error = appQuery.error.value;
  return error instanceof ApiError && error.status === 404;
});
const failure = computed(() => {
  const error = appQuery.error.value;
  if (notFound.value) {
    return "This application no longer exists. It may have been deleted or renamed.";
  }
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load this application.";
});

watch(
  () => appQuery.data.value?.chrome,
  (chrome) => {
    if (chrome !== undefined) {
      applyChrome(chrome);
    }
  },
  { immediate: true },
);

const projectHref = computed(() =>
  view.value === undefined ? "" : `/projects/${encodeURIComponent(view.value.identity.projectId)}`,
);

const {
  gitStatus,
  summary: gitSummary,
  rules: gitRules,
  hint: gitHint,
  loading: gitLoading,
  busyAction: gitBusyAction,
  failure: gitFailure,
  notice: gitNotice,
  commitDraft: gitCommitDraft,
  commitError: gitCommitError,
  needsRefresh: gitNeedsRefresh,
  liveMessage: gitLiveMessage,
  refreshedLabel: gitRefreshedLabel,
  loadStatus: refreshGit,
  runAction: runGitAction,
  submitCommit: submitGitCommit,
  requestSwitch: requestGitSwitch,
} = useAppGit(
  computed(() => view.value?.git),
  {
    onChanged: () => {
      void refreshApp();
    },
  },
);

const gitUnavailable = computed(
  () => gitFailure.value !== null || (gitStatus.value !== null && gitStatus.value.state !== "ok"),
);

function isRuntimeState(value: unknown): value is RuntimeState {
  return value === "starting" || value === "running" || value === "stopped" || value === "error";
}

// Runtime is polled; image status polls only while a build is active (inside useAppImage). The page
// shows boot props immediately; these reads keep the strip and the rail truthful after a restart or
// a build started in another tab.
const runtimeState = ref<RuntimeState>("stopped");
const runtimeImageRef = ref<string | null>(null);
const runtimeError = ref<string | null>(null);
let runtimeTimer: ReturnType<typeof setInterval> | undefined;

watch(
  () => view.value?.runtime.state,
  (state) => {
    if (isRuntimeState(state)) {
      runtimeState.value = state;
    }
  },
  { immediate: true },
);

const runtimeHref = computed(() => view.value?.image.hrefs.runtime ?? "");

async function refreshRuntime(): Promise<void> {
  const href = runtimeHref.value;
  if (href.length === 0) return;
  try {
    const data = await apiQuery<AppRuntimeLive>(href);
    if (isRuntimeState(data.state)) {
      runtimeState.value = data.state;
    }
    runtimeImageRef.value =
      typeof data.imageRef === "string" && data.imageRef.length > 0 ? data.imageRef : null;
    runtimeError.value = null;
  } catch (error) {
    // Runtime is secondary here; keep the last known state and surface the read failure.
    runtimeError.value =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Runtime status is unavailable.";
  }
}

const {
  live: imageLive,
  liveError: imageLiveError,
  logs: imageLogs,
  logsError: imageLogsError,
  logsOpen: imageLogsOpen,
  busy: imageBusy,
  refreshStatus: refreshImage,
  refreshLogs: refreshImageLogs,
  setLogsOpen: setImageLogsOpen,
  build: buildImage,
  rollback: rollbackImage,
  check: checkImage,
} = useAppImage(
  computed(() => view.value?.image),
  {
    onChanged: () => refreshApp(),
  },
);

watch(
  runtimeHref,
  (href) => {
    if (href.length > 0) void refreshRuntime();
  },
  { immediate: true },
);

onMounted(() => {
  runtimeTimer = setInterval(() => {
    void refreshRuntime();
  }, RUNTIME_POLL_MS);
});

onUnmounted(() => {
  if (runtimeTimer !== undefined) {
    clearInterval(runtimeTimer);
  }
});

const canRestart = computed(() => {
  const current = view.value;
  if (current === undefined) return false;
  if (current.delete.pending) return false;
  return runtimeState.value === "running" || runtimeState.value === "starting";
});

const lastCommit = computed(() => gitSummary.value.lastCommit ?? null);
const deletionPending = computed(() => view.value?.delete.pending === true);
const deletionBanner = computed(() => view.value?.delete.banner ?? null);

async function refreshApp(): Promise<void> {
  const result = await appQuery.refetch();
  const chrome = (result.data as AppResponse | undefined)?.chrome;
  if (chrome !== undefined) {
    applyChrome(chrome);
  }
  void refreshRuntime();
  void refreshImage();
}

const appDeleteDialog = ref<InstanceType<typeof AppDeleteDialog> | null>(null);

function onDeleted(result: AppDeleteResult): void {
  const warningCount = result.warnings.length;
  const base = result.kind === "project" ? "Project deleted." : "Application deleted.";
  const message =
    warningCount === 0
      ? base
      : `${base} Completed with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`;
  toasts.push(message, warningCount === 0 ? "success" : "error");
  if (result.kind === "project") {
    void router.push("/projects");
  } else {
    void router.push(`/projects/${encodeURIComponent(result.projectId)}`);
  }
}

const restartDialog = ref<InstanceType<typeof AppRestartDialog> | null>(null);
const restartBusy = ref(false);

async function restartAgent(): Promise<void> {
  const current = view.value;
  if (current === undefined || restartBusy.value) return;
  restartBusy.value = true;
  try {
    const result = await apiMutation<{ restarted: boolean; reason?: string }>(
      current.restart.action,
      { json: {} },
    );
    const message = result.restarted
      ? "Agent restarted."
      : "Agent is not running; settings apply on next start.";
    toasts.push(message, "success");
    restartDialog.value?.close();
    await refreshApp();
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not restart the agent.";
    toasts.push(message, "error");
  } finally {
    restartBusy.value = false;
  }
}
</script>

<template>
  <template v-if="failed">
    <header class="page-header">
      <div class="page-header__main">
        <p class="overline">Application</p>
        <h1 class="page-title">Application</h1>
      </div>
    </header>
    <div class="page__body">
      <section class="card" aria-labelledby="app-error-title">
        <div class="card__head">
          <h2 class="card__title" id="app-error-title">
            {{ notFound ? "Application not found" : "Application could not be loaded" }}
          </h2>
        </div>
        <div class="card__body stack--tight">
          <p class="form-error" role="alert">{{ failure }}</p>
          <div class="cluster">
            <button class="btn btn-secondary btn-sm" type="button" @click="appQuery.refetch()">
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
        <p class="overline">Application</p>
        <h1 class="page-title">Application</h1>
      </div>
    </header>
    <div class="page__body">
      <p class="hint" role="status" aria-live="polite">Loading application…</p>
    </div>
  </template>

  <template v-else-if="view.master">
    <header class="page-header">
      <div class="page-header__main">
        <p class="overline">{{ view.header.overline }}</p>
        <h1 class="page-title">{{ view.header.title }}</h1>
        <p class="page-description">{{ view.header.description }}</p>
        <div class="page-meta">
          <span v-for="item in view.header.meta" :key="item" class="mono">{{ item }}</span>
        </div>
      </div>
      <div class="page-header__actions">
        <a class="btn btn-secondary" :href="view.links.chat">
          <AppIcon name="message" />Open chat
        </a>
        <a class="btn btn-secondary" :href="view.links.terminal">
          <AppIcon name="terminal" />Terminal
        </a>
        <a class="btn btn-secondary" :href="view.links.settings">
          <AppIcon name="settings" />Settings
        </a>
        <a class="btn btn-ghost" :href="view.links.skills"><AppIcon name="code" />Skills</a>
        <a class="btn btn-ghost" :href="view.links.ide" target="_blank" rel="noreferrer">
          <AppIcon name="external" />Open IDE
        </a>
      </div>
    </header>

    <div class="page__body">
      <p v-if="loading && hasData" class="hint" role="status" aria-live="polite">
        Updating application…
      </p>
      <AppStateStrip
        :runtime-state="runtimeState"
        :settings="view.settings"
        :can-restart="canRestart"
        :runtime-error="runtimeError"
        @restart="restartDialog?.open()"
      />
      <section class="card section" id="master-panel" aria-labelledby="master-panel-title">
        <div class="card__head">
          <h2 class="card__title" id="master-panel-title">Master workspace</h2>
          <span class="badge badge--mono">system</span>
        </div>
        <div class="card__body stack--tight">
          <div class="stack--tight">
            <span class="overline">Directory</span>
            <span class="mono">{{ view.identity.folder }}</span>
          </div>
          <p class="small">
            The master's directory is coordinator-managed and read-only inside its container. Its
            instructions are rewritten on every coordinator start.
          </p>
          <p class="small">
            Workspace changes go through the master's Hanse tools. Skills can be created, inspected,
            updated, enabled/disabled, and overridden from the master chat; deleting or renaming
            them remains operator-only. Provider keys, git credentials, image builds, and project
            deletion are operator-only UI actions.
          </p>
        </div>
        <div class="card__foot">
          <a class="btn btn-secondary btn-sm" :href="view.links.settings">
            <AppIcon name="settings" />Application settings
          </a>
          <a class="btn btn-ghost btn-sm" :href="view.links.skills">
            <AppIcon name="code" />Skills
          </a>
        </div>
      </section>
      <AppRestartDialog
        v-if="canRestart"
        ref="restartDialog"
        :restart="view.restart"
        :busy="restartBusy"
        @confirm="restartAgent"
      />
    </div>
  </template>

  <template v-else>
    <header class="page-header">
      <div class="page-header__main">
        <p class="overline">{{ view.header.overline }}</p>
        <h1 class="page-title">{{ view.header.title }}</h1>
        <p class="page-description">{{ view.header.description }}</p>
        <div class="page-meta">
          <span v-for="item in view.header.meta" :key="item" class="mono">{{ item }}</span>
        </div>
      </div>
      <div class="page-header__actions">
        <template v-if="view.header.showChatTerminal">
          <a class="btn btn-secondary" :href="view.links.chat">
            <AppIcon name="message" />Open chat
          </a>
          <a class="btn btn-secondary" :href="view.links.terminal">
            <AppIcon name="terminal" />Terminal
          </a>
        </template>
        <a class="btn btn-secondary" :href="view.links.settings">
          <AppIcon name="settings" />Settings
        </a>
        <a class="btn btn-ghost" :href="view.links.skills"><AppIcon name="code" />Skills</a>
        <a class="btn btn-ghost" :href="view.links.ide" target="_blank" rel="noreferrer">
          <AppIcon name="external" />Open IDE
        </a>
      </div>
    </header>

    <div class="page__body">
      <p v-if="loading && hasData" class="hint" role="status" aria-live="polite">
        Updating application…
      </p>

      <div v-if="deletionPending" class="error-state section" id="deletion-banner" role="alert">
        <span class="error-state__mark">
          <AppIcon name="alert-triangle" class-name="icon--lg" />
        </span>
        <div>
          <h3 class="error-state__title">
            {{ deletionBanner?.title ?? "Deletion incomplete" }}
          </h3>
          <p class="error-state__body">
            {{
              deletionBanner?.body ??
              "Chat, terminal, and start actions stay disabled until the deletion completes."
            }}
          </p>
        </div>
      </div>

      <AppStateStrip
        :runtime-state="runtimeState"
        :settings="view.settings"
        :can-restart="canRestart"
        :runtime-error="runtimeError"
        @restart="restartDialog?.open()"
      />

      <div id="git-panel">
        <div class="workbench-grid workbench-grid--detail section">
          <AppGitPanel
            v-model:commit-draft="gitCommitDraft"
            :summary="gitSummary"
            :status="gitStatus"
            :rules="gitRules"
            :hint="gitHint"
            :loading="gitLoading"
            :busy-action="gitBusyAction"
            :failure="gitFailure"
            :notice="gitNotice"
            :commit-error="gitCommitError"
            :needs-refresh="gitNeedsRefresh"
            :refreshed-label="gitRefreshedLabel"
            :ide-href="view.links.ide"
            :project-href="projectHref"
            :live-message="gitLiveMessage"
            @refresh="refreshGit"
            @action="runGitAction"
            @commit="submitGitCommit"
            @switch="requestGitSwitch"
          />
          <aside class="rail-stack" aria-label="Application details">
            <AppImagePanel
              :logs-open="imageLogsOpen"
              :image="view.image"
              :live="imageLive"
              :live-error="imageLiveError"
              :logs="imageLogs"
              :logs-error="imageLogsError"
              :busy-action="imageBusy"
              :runtime-active="runtimeState === 'running' || runtimeState === 'starting'"
              :runtime-image-ref="runtimeImageRef"
              :ide-href="view.links.ide"
              @build="buildImage"
              @rollback="rollbackImage"
              @check="checkImage"
              @refresh="refreshImage"
              @refresh-logs="refreshImageLogs"
              @update:logs-open="setImageLogsOpen"
            />
            <AppGitRemotes
              :status="gitStatus"
              :failure="gitFailure !== null"
              :loaded="gitSummary.loaded"
            />
            <section class="card" id="last-commit-card" aria-labelledby="last-commit-title">
              <div class="card__head">
                <h2 class="card__title" id="last-commit-title">Last commit</h2>
              </div>
              <div class="card__body stack--tight">
                <p v-if="gitUnavailable || !gitSummary.loaded" class="hint">
                  Commit history is unavailable for this repository.
                </p>
                <div v-else-if="lastCommit === null" class="empty-state">
                  <span class="empty-state__mark">
                    <AppIcon name="branch" class-name="icon--lg" />
                  </span>
                  <h3 class="empty-state__title">No commits yet.</h3>
                  <p class="empty-state__body">The first commit will appear here.</p>
                </div>
                <template v-else>
                  <p class="body">{{ lastCommit.subject }}</p>
                  <div class="cluster">
                    <span class="mono" :title="lastCommit.hash">{{ lastCommit.shortHash }}</span>
                    <span class="caption">{{ lastCommit.author }}</span>
                    <time
                      class="caption"
                      :datetime="lastCommit.committedAt"
                      :title="absoluteTime(lastCommit.committedAt)"
                    >
                      {{ timeAgo(lastCommit.committedAt) }}
                    </time>
                  </div>
                </template>
              </div>
            </section>
          </aside>
        </div>
      </div>

      <AppSshPanel
        :ssh="view.ssh"
        :project-id="view.identity.projectId"
        :app-key="view.identity.appKey"
        :disabled="deletionPending"
        @changed="refreshApp"
      />

      <section class="card section" id="danger-zone" aria-labelledby="danger-zone-title">
        <div class="card__head">
          <h2 class="card__title" id="danger-zone-title">Danger zone</h2>
          <span v-if="view.delete.statusLabel !== null" class="badge">
            {{ view.delete.statusLabel }}
          </span>
          <span v-else class="badge">Destructive</span>
        </div>
        <div class="card__body stack--tight">
          <p class="small">
            Deleting this application removes its sessions, handoffs, credentials, and managed
            images. Source files are kept unless you choose to delete them too.
          </p>
        </div>
        <div class="card__foot">
          <button
            class="btn btn-danger"
            id="app-delete"
            type="button"
            @click="appDeleteDialog?.open()"
          >
            <AppIcon name="trash" />
            {{ view.delete.pending ? "Retry deletion" : "Delete application" }}
          </button>
        </div>
      </section>

      <AppDeleteDialog ref="appDeleteDialog" :deletion="view.delete" @deleted="onDeleted" />

      <AppRestartDialog
        v-if="canRestart"
        ref="restartDialog"
        :restart="view.restart"
        :busy="restartBusy"
        @confirm="restartAgent"
      />
    </div>
  </template>
</template>
