<script setup lang="ts">
import { computed, watch } from "vue";
import { useChromeStore } from "../stores/chrome.js";
import AppIcon from "./AppIcon.vue";
import SmartLink from "./SmartLink.vue";

const chrome = useChromeStore();
const crumbs = computed(() => chrome.current?.breadcrumb ?? []);

watch(
  () => chrome.current?.active,
  (active) => {
    const host = document.getElementById("breadcrumb-host");
    if (host !== null) {
      host.dataset.navId = active ?? "none";
    }
  },
  { immediate: true, flush: "post" },
);
</script>

<template>
  <Teleport to="#breadcrumb-host">
    <template v-for="(crumb, index) in crumbs" :key="index">
      <span v-if="index === crumbs.length - 1" aria-current="page">{{ crumb.label }}</span>
      <SmartLink v-else-if="crumb.href !== undefined" :to="crumb.href">{{ crumb.label }}</SmartLink>
      <span v-else>{{ crumb.label }}</span>
      <AppIcon v-if="index < crumbs.length - 1 && crumb.href !== undefined" name="chevron-right" />
    </template>
  </Teleport>
</template>
