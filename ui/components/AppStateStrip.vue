<script setup lang="ts">
import { computed } from "vue";
import type { AppSettingsProps } from "../app-types.js";
import { type PillSpec, type RuntimeState, runtimePill } from "../status.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  runtimeState: RuntimeState;
  settings: AppSettingsProps;
  canRestart: boolean;
  runtimeError: string | null;
}>();

const emit = defineEmits<{ restart: [] }>();

const runtime = computed<PillSpec>(() => runtimePill(props.runtimeState));
const settingsPill = computed<PillSpec>(() => ({
  variant: "status",
  dataState: props.settings.tone,
  icon: props.settings.glyph,
  label: props.settings.label,
}));
</script>

<template>
  <section class="state-strip" id="app-state" aria-label="Application state">
    <div class="state-strip__cell" id="runtime-state">
      <span class="state-strip__label">Runtime</span>
      <div class="state-strip__value"><StatusPill :pill="runtime" /></div>
      <div class="state-strip__actions" id="runtime-actions">
        <button
          v-if="canRestart"
          class="btn btn-secondary btn-sm"
          id="app-restart"
          type="button"
          @click="emit('restart')"
        >
          <AppIcon name="refresh" />Restart agent
        </button>
      </div>
      <p v-if="runtimeError !== null" class="hint">{{ runtimeError }}</p>
    </div>
    <div class="state-strip__cell" id="settings-state">
      <span class="state-strip__label">Settings</span>
      <div class="state-strip__value"><StatusPill :pill="settingsPill" /></div>
      <p class="small">{{ settings.copy }}</p>
      <div v-if="settings.actionLabel !== null" class="state-strip__actions">
        <a class="btn btn-ghost btn-sm" :href="settings.href">{{ settings.actionLabel }}</a>
      </div>
    </div>
  </section>
</template>
