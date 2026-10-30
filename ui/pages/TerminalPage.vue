<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ApiError, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import TerminalBanner from "../components/TerminalBanner.vue";
import TerminalStoppedState from "../components/TerminalStoppedState.vue";
import TerminalToolbar from "../components/TerminalToolbar.vue";
import TerminalView from "../components/TerminalView.vue";
import { applyChrome } from "../composables/useChrome.js";
import { useWorkspaceShell } from "../composables/useWorkspaceShell.js";
import type { TerminalStatusKind } from "../terminal/socket.js";
import type { TerminalPageProps, TerminalResponse } from "../terminal/types.js";

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();

useWorkspaceShell("page--terminal");

function queryString(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

const projectId = computed(() => queryString(route.query.project));
const appKey = computed(() => queryString(route.query.app));

const bootProps = computed<TerminalPageProps | undefined>(() => {
  if (props.boot.route.id !== "terminal") {
    return undefined;
  }
  const value = props.boot.props;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as TerminalPageProps;
  if (candidate.app?.projectId !== projectId.value || candidate.app?.appKey !== appKey.value) {
    return undefined;
  }
  return candidate;
});

const apiPath = computed(
  () =>
    `/api/ui/terminal?app=${encodeURIComponent(appKey.value)}&project=${encodeURIComponent(projectId.value)}`,
);

const terminalQuery = useQuery<TerminalResponse>({
  queryKey: computed(() => ["terminal", projectId.value, appKey.value]),
  queryFn: () => apiQuery<TerminalResponse>(apiPath.value),
  initialData: () => bootProps.value as TerminalResponse | undefined,
  initialDataUpdatedAt: 0,
  staleTime: 30_000,
  retry: false,
  enabled: computed(() => appKey.value.length > 0 && projectId.value.length > 0),
});

const view = computed<TerminalPageProps | undefined>(() => terminalQuery.data.value);
const loading = computed(() => terminalQuery.isFetching.value);
const failed = computed(() => terminalQuery.isError.value);
const notFound = computed(() => {
  const error = terminalQuery.error.value;
  return error instanceof ApiError && error.status === 404;
});
const failure = computed(() => {
  const error = terminalQuery.error.value;
  if (notFound.value) {
    return "This terminal does not exist. The application may have been deleted or renamed.";
  }
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load this terminal.";
});

watch(
  () => terminalQuery.data.value?.chrome,
  (chrome) => {
    if (chrome !== undefined) {
      applyChrome(chrome);
    }
  },
  { immediate: true },
);

const status = ref<TerminalStatusKind>("connecting");
const detail = ref<string | undefined>(undefined);
const banner = ref<string | null>(null);
const copyEnabled = ref(false);
const announcement = ref("");
const engineUnavailable = ref(false);
const viewRef = ref<InstanceType<typeof TerminalView> | null>(null);

const chatHref = computed(
  () =>
    view.value?.links.chat ??
    `/chat?app=${encodeURIComponent(appKey.value)}&project=${encodeURIComponent(projectId.value)}`,
);

const legacyHref = computed(() => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(route.query)) {
    if (key === "legacy") {
      continue;
    }
    if (typeof value === "string") {
      params.set(key, value);
    }
  }
  params.set("legacy", "1");
  return `${route.path}?${params.toString()}`;
});

function reconnect(): void {
  engineUnavailable.value = false;
  viewRef.value?.reconnect();
}

function copySelection(): void {
  void viewRef.value?.copySelection();
}

function closeTerminal(): void {
  viewRef.value?.close();
}

function retryEngine(): void {
  engineUnavailable.value = false;
}
</script>

<template>
  <div class="page__body page__body--terminal">
    <section v-if="failed" class="card section" aria-labelledby="terminal-error-title">
      <div class="card__head">
        <h2 class="card__title" id="terminal-error-title">
          {{ notFound ? "Terminal not found" : "Terminal could not be loaded" }}
        </h2>
      </div>
      <div class="card__body stack--tight">
        <p class="form-error" role="alert">{{ failure }}</p>
        <div class="cluster">
          <button class="btn btn-secondary btn-sm" type="button" @click="terminalQuery.refetch()">
            <AppIcon name="refresh" />Retry
          </button>
          <a class="btn btn-ghost btn-sm" :href="legacyHref">Use the classic interface</a>
        </div>
      </div>
    </section>

    <p v-else-if="view === undefined" class="hint" role="status" aria-live="polite">
      {{ loading ? "Connecting to the application…" : "Terminal unavailable." }}
    </p>

    <section v-else class="terminal-shell" id="terminal" aria-labelledby="terminal-title">
      <TerminalToolbar
        :title="`${view.app.appKey} / Operator terminal`"
        :runtime="view.runtime.state"
        :status="status"
        :detail="detail"
        :copy-enabled="copyEnabled"
        @copy="copySelection"
        @reconnect="reconnect"
        @close="closeTerminal"
      />
      <TerminalBanner :text="banner" />

      <div v-if="engineUnavailable" class="terminal-host" id="terminal-host">
        <div class="empty-state terminal-empty">
          <span class="empty-state__mark">
            <AppIcon name="terminal" class-name="icon--lg" />
          </span>
          <h3 class="empty-state__title">Terminal engine unavailable</h3>
          <p class="empty-state__body">
            The terminal engine did not load. Retry, or use the classic interface until this build
            is reloaded.
          </p>
          <div class="cluster">
            <button class="btn btn-secondary" type="button" @click="retryEngine">
              <AppIcon name="refresh" />Retry
            </button>
            <a class="btn btn-ghost" :href="legacyHref">Use the classic interface</a>
          </div>
        </div>
      </div>

      <TerminalView
        v-if="!engineUnavailable"
        v-show="status !== 'stopped'"
        ref="viewRef"
        :ws-path="view.runtime.wsPath"
        :runtime-url="view.runtime.runtimeUrl"
        @status="status = $event"
        @detail="detail = $event"
        @banner="banner = $event"
        @selection="copyEnabled = $event"
        @announce="announcement = $event"
        @engine-error="engineUnavailable = true"
      />

      <div v-if="status === 'stopped' && !engineUnavailable" class="terminal-host">
        <TerminalStoppedState :chat-href="chatHref" @reconnect="reconnect" />
      </div>

      <p
        class="sr-only"
        id="terminal-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ announcement }}
      </p>
    </section>
  </div>
</template>
