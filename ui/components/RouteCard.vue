<script setup lang="ts">
import { computed } from "vue";
import { absoluteTime, timeAgo } from "../format.js";
import { type HandoffState, statusPill } from "../status.js";
import AppIcon from "./AppIcon.vue";
import SmartLink from "./SmartLink.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  id: string;
  from: string;
  to: string;
  summary: string;
  state: HandoffState;
  updatedAt: string;
  reviewHref: string;
}>();

const pill = computed(() => statusPill(props.state));
</script>

<template>
  <article class="route-card" :data-state="state">
    <div class="route-card__head">
      <span class="mono table__nowrap">{{ id.slice(0, 8) }}</span>
      <StatusPill :pill="pill" />
    </div>
    <div class="route" :aria-label="`Handoff from ${from} to ${to}`">
      <span class="route__end">
        <span class="route__app">{{ from }}</span>
        <span class="route__meta">origin</span>
      </span>
      <span class="route__track" aria-hidden="true">
        <span class="route__node"></span>
        <span class="route__seal"><AppIcon :name="pill.icon" /></span>
        <span class="route__node"></span>
      </span>
      <span class="route__end route__end--to">
        <span class="route__app">{{ to }}</span>
        <span class="route__meta">target</span>
      </span>
    </div>
    <p class="route-card__summary">{{ summary }}</p>
    <div class="route-card__foot">
      <span class="mono table__nowrap">
        <time :datetime="updatedAt" :title="absoluteTime(updatedAt)">
          {{ timeAgo(updatedAt) }}
        </time>
      </span>
      <SmartLink class="btn btn-ghost btn-sm" :to="reviewHref">
        Review <AppIcon name="arrow-right" />
      </SmartLink>
    </div>
  </article>
</template>
