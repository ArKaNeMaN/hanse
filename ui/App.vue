<script setup lang="ts">
import { onErrorCaptured, ref } from "vue";
import { RouterView } from "vue-router";
import type { BootPayload } from "./boot.js";
import ToastHost from "./components/ToastHost.vue";
import RouteErrorPage from "./pages/RouteErrorPage.vue";

defineProps<{ boot: BootPayload }>();

const renderError = ref<string | undefined>(undefined);

onErrorCaptured((error) => {
  renderError.value = error instanceof Error ? error.message : String(error);
  return false;
});
</script>

<template>
  <span class="hanse-ui-sentinel" aria-hidden="true"></span>
  <RouteErrorPage v-if="renderError !== undefined" :message="renderError" />
  <RouterView v-else v-slot="{ Component }">
    <component :is="Component" :boot="boot" />
  </RouterView>
  <ToastHost :notice="boot.notice" />
</template>
