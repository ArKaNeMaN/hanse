<script setup lang="ts">
import { computed, onErrorCaptured, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import type { BootOverride, BootPayload } from "./boot.js";
import AppSidebar from "./components/AppSidebar.vue";
import BreadcrumbBar from "./components/BreadcrumbBar.vue";
import ToastHost from "./components/ToastHost.vue";
import TopbarActions from "./components/TopbarActions.vue";
import ChatNoAppsPage from "./pages/ChatNoAppsPage.vue";
import NotFoundPage from "./pages/NotFoundPage.vue";
import RouteErrorPage from "./pages/RouteErrorPage.vue";
import { useChromeStore } from "./stores/chrome.js";
import { useShellStore } from "./stores/shell.js";

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const chrome = useChromeStore();
const shell = useShellStore();

const renderError = ref<string | undefined>(undefined);
const bootUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
const bootOverride = ref<BootOverride | undefined>(props.boot.override);

watch(
  () => route.fullPath,
  (fullPath) => {
    if (fullPath !== bootUrl) {
      bootOverride.value = undefined;
    }
  },
);

watch(
  () => chrome.current,
  (data) => {
    if (data !== undefined) {
      shell.setActive(data.active, data.activeProjectId);
    }
  },
  { immediate: true },
);

const workspace = computed<"chat" | "terminal" | undefined>(() => {
  if (route.name === "chat") {
    return "chat";
  }
  if (route.name === "terminal") {
    return "terminal";
  }
  return undefined;
});

const standalone = computed(() => route.name === "login" || props.boot.route.id === "login");

// Chat remounts on app/project changes; chat owns the stream/feed/draft lifecycle per workspace.
const viewKey = computed(() => {
  if (route.name === "chat") {
    const app = typeof route.query.app === "string" ? route.query.app : "";
    const project = typeof route.query.project === "string" ? route.query.project : "";
    return `chat:${app}:${project}`;
  }
  // Keep one inventory component alive across global/project/app scope switches so the previous
  // rows remain mounted while the next scope loads instead of flashing a blank page.
  if (
    route.name === "skills-global" ||
    route.name === "skills-project" ||
    route.name === "skills-app"
  ) {
    return "skills-inventory";
  }
  return route.fullPath;
});

const bootRoute = computed(() => props.boot.route.id);

onErrorCaptured((error) => {
  renderError.value = error instanceof Error ? error.message : String(error);
  return false;
});
</script>

<template>
  <span class="hanse-ui-sentinel" aria-hidden="true"></span>
  <RouteErrorPage v-if="renderError !== undefined" :message="renderError" />
  <NotFoundPage v-else-if="bootOverride === 'not-found'" :boot="boot" />
  <ChatNoAppsPage v-else-if="bootOverride === 'chat-no-apps'" :boot="boot" />
  <RouterView v-else v-slot="{ Component }">
    <component :is="Component" :key="viewKey" :boot="boot" :data-boot-route="bootRoute" />
  </RouterView>
  <AppSidebar v-if="!standalone" />
  <BreadcrumbBar v-if="!standalone" />
  <TopbarActions v-if="!standalone" :topbar="boot.topbar" :workspace="workspace" />
  <ToastHost :notice="boot.notice" />
</template>
