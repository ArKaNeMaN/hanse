<script setup lang="ts">
import { computed, onErrorCaptured, ref } from "vue";
import { RouterView, useRoute } from "vue-router";
import type { BootPayload } from "./boot.js";
import ToastHost from "./components/ToastHost.vue";
import TopbarActions from "./components/TopbarActions.vue";
import RouteErrorPage from "./pages/RouteErrorPage.vue";

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();

const renderError = ref<string | undefined>(undefined);

const workspace = computed<"chat" | "terminal" | undefined>(() => {
  if (route.name === "chat") {
    return "chat";
  }
  if (route.name === "terminal") {
    return "terminal";
  }
  return undefined;
});

// Chat remounts on app/project changes; chat owns the stream/feed/draft lifecycle per workspace.
const viewKey = computed(() => {
  if (route.name === "chat") {
    const app = typeof route.query.app === "string" ? route.query.app : "";
    const project = typeof route.query.project === "string" ? route.query.project : "";
    return `chat:${app}:${project}`;
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
  <RouterView v-else v-slot="{ Component }">
    <component :is="Component" :key="viewKey" :boot="boot" :data-boot-route="bootRoute" />
  </RouterView>
  <TopbarActions :topbar="boot.topbar" :workspace="workspace" />
  <ToastHost :notice="boot.notice" />
</template>
