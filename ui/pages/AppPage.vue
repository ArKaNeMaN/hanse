<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { AppImageLive, AppProps, AppResponse, AppRuntimeLive } from "../app-types.js";
import type { BootPayload } from "../boot.js";
import AppGitPanel from "../components/AppGitPanel.vue";
import AppIcon from "../components/AppIcon.vue";
import AppImagePanel from "../components/AppImagePanel.vue";
import AppRestartDialog from "../components/AppRestartDialog.vue";
import AppSshPanel from "../components/AppSshPanel.vue";
import AppStateStrip from "../components/AppStateStrip.vue";
import { applyChrome } from "../composables/useChrome.js";
import { absoluteTime, timeAgo } from "../format.js";
import type { RuntimeState } from "../status.js";
import { useToastStore } from "../stores/toasts.js";

const RUNTIME_POLL_MS = 10_000;
const IMAGE_POLL_MS = 3_000;

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
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

function isRuntimeState(value: unknown): value is RuntimeState {
  return value === "starting" || value === "running" || value === "stopped" || value === "error";
}

// Runtime and image are polled. The page shows boot props immediately; these reads keep the strip
// and the rail truthful after a restart or a build started in another tab.
const runtimeState = ref<RuntimeState>("stopped");
const runtimeError = ref<string | null>(null);
const imageLive = ref<AppImageLive | null>(null);
const imageLiveError = ref<string | null>(null);
let runtimeTimer: ReturnType<typeof setInterval> | undefined;
let imageTimer: ReturnType<typeof setTimeout> | undefined;

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
    runtimeError.value = null;
  } catch (error) {
    // Runtime is secondary here; keep the last known state and surface the read failure.
    runtimeError.value =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Runtime status is unavailable.";
  }
}

function stopImagePoll(): void {
  if (imageTimer !== undefined) {
    clearTimeout(imageTimer);
    imageTimer = undefined;
  }
}

function scheduleImagePoll(): void {
  if (imageTimer !== undefined) return;
  imageTimer = setTimeout(() => {
    imageTimer = undefined;
    void refreshImage();
  }, IMAGE_POLL_MS);
}

async function refreshImage(): Promise<void> {
  const href = view.value?.image.hrefs.image ?? "";
  if (href.length === 0) return;
  try {
    const data = await apiQuery<AppImageLive>(href);
    imageLive.value = data;
    imageLiveError.value = null;
    if (data.status === "building") {
      scheduleImagePoll();
    } else {
      stopImagePoll();
    }
  } catch (error) {
    imageLiveError.value =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Image status is unavailable.";
    if (view.value?.image.building === true) {
      scheduleImagePoll();
    } else {
      stopImagePoll();
    }
  }
}

watch(
  runtimeHref,
  (href) => {
    if (href.length > 0) void refreshRuntime();
  },
  { immediate: true },
);

watch(
  () => view.value?.image.hrefs.image,
  (href) => {
    if (href !== undefined && href.length > 0) void refreshImage();
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
  stopImagePoll();
});

const refreshedAt = ref(0);
const nowTick = ref(Date.now());
let labelTimer: ReturnType<typeof setInterval> | undefined;
watch(
  () => view.value?.git.summary.loaded,
  (loaded) => {
    if (loaded === true) {
      refreshedAt.value = Date.now();
      nowTick.value = Date.now();
    }
  },
  { immediate: true },
);
onMounted(() => {
  labelTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 30_000);
});
onUnmounted(() => {
  if (labelTimer !== undefined) {
    clearInterval(labelTimer);
  }
});

const refreshedLabel = computed(() => {
  if (view.value === undefined) return "Loading status";
  if (!view.value.git.summary.loaded) return "Status unavailable";
  if (refreshedAt.value === 0) return "Loading status";
  const minutes = Math.floor((nowTick.value - refreshedAt.value) / 60_000);
  return minutes < 1 ? "Refreshed just now" : `Refreshed ${minutes}m ago`;
});

const canRestart = computed(() => {
  const current = view.value;
  if (current === undefined) return false;
  if (current.delete.pending) return false;
  return runtimeState.value === "running" || runtimeState.value === "starting";
});

const lastCommit = computed(() => view.value?.git.summary.lastCommit ?? null);
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
            :summary="view.git.summary"
            :refreshed-label="refreshedLabel"
            :refreshing="loading"
            @refresh="refreshApp"
          />
          <aside class="rail-stack" aria-label="Application details">
            <AppImagePanel :image="view.image" :live="imageLive" :live-error="imageLiveError" />
            <section class="card" id="last-commit-card" aria-labelledby="last-commit-title">
              <div class="card__head">
                <h2 class="card__title" id="last-commit-title">Last commit</h2>
              </div>
              <div class="card__body stack--tight">
                <p v-if="!view.git.summary.loaded" class="hint">
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

      <AppSshPanel :ssh="view.ssh" />

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
