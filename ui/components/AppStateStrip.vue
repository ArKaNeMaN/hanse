<script setup lang="ts">
import { computed } from "vue";
import type { AppSettingsProps } from "../app-types.js";
import { absoluteTime, timeAgo } from "../format.js";
import type { ProcessError, ProcessEvent, ProcessPhase } from "../process/types.js";
import {
  type PillSpec,
  processPhaseLabel,
  processPhasePill,
  processPill,
  type RuntimeState,
  runtimePill,
} from "../status.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

const props = withDefaults(
  defineProps<{
    runtimeState: RuntimeState;
    settings: AppSettingsProps;
    canRestart: boolean;
    runtimeError: string | null;
    processPhase?: ProcessPhase | null;
    processElapsed?: string;
    processError?: ProcessError | null;
    historyEvents?: readonly ProcessEvent[];
    historyLoading?: boolean;
    historyError?: string | null;
    historyHasMore?: boolean;
  }>(),
  {
    processPhase: null,
    processElapsed: "",
    processError: null,
    historyEvents: () => [],
    historyLoading: false,
    historyError: null,
    historyHasMore: false,
  },
);

const emit = defineEmits<{ restart: []; "load-history": []; "load-older": [] }>();

const runtime = computed<PillSpec>(() => {
  if (props.processPhase === "stopping") {
    return processPhasePill("stopping") ?? runtimePill(props.runtimeState);
  }
  return runtimePill(props.runtimeState);
});

const activity = computed<"starting" | "stopping" | null>(() => {
  if (props.processPhase === "stopping") return "stopping";
  if (props.runtimeState === "starting") return "starting";
  return null;
});

const activityLabel = computed(() => {
  if (activity.value === "stopping") return "Stopping…";
  if (activity.value === "starting") return "Starting…";
  return "";
});

const phaseDetail = computed(() => {
  if (activity.value === null) return "";
  const phase = props.processPhase;
  if (phase === null || phase === undefined) return "";
  const label = processPhaseLabel(phase);
  if (activity.value === "stopping" && phase === "stopping") return "";
  if (activity.value === "starting" && label === "Starting") return "";
  return label;
});

const errorMessage = computed<string | null>(() => {
  const message = props.processError?.message;
  if (typeof message === "string" && message.trim().length > 0) return message;
  if (props.runtimeState === "error") {
    return "The agent failed to start. No error details were recorded.";
  }
  return null;
});

const errorAt = computed<string | null>(() => {
  if (errorMessage.value === null) return null;
  return props.processError?.at ?? null;
});

const settingsPill = computed<PillSpec>(() => ({
  variant: "status",
  dataState: props.settings.tone,
  icon: props.settings.glyph,
  label: props.settings.label,
}));

function onHistoryToggle(event: Event): void {
  const target = event.currentTarget;
  if (target instanceof HTMLDetailsElement && target.open) emit("load-history");
}
</script>

<template>
  <section class="state-strip" id="app-state" aria-label="Application state">
    <div class="state-strip__cell" id="runtime-state">
      <span class="state-strip__label">Runtime</span>
      <div class="state-strip__value"><StatusPill :pill="runtime" /></div>
      <p
        v-if="activity !== null"
        class="small"
        id="process-activity"
        role="status"
        aria-live="polite"
      >
        {{ activityLabel }}<template v-if="phaseDetail"> · {{ phaseDetail }}</template
        ><template v-if="processElapsed">
          · <span class="mono">{{ processElapsed }}</span></template
        >
      </p>
      <p v-if="errorMessage !== null" class="field-error" id="process-error" role="alert">
        {{ errorMessage }}
        <time
          v-if="errorAt !== null"
          class="caption"
          :datetime="errorAt"
          :title="absoluteTime(errorAt)"
        >
          · {{ timeAgo(errorAt) }}
        </time>
      </p>
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
      <details class="disclosure" id="process-history" @toggle="onHistoryToggle">
        <summary>
          Process history<AppIcon name="chevron-down" class-name="disclosure__chevron" />
        </summary>
        <div class="stack--tight">
          <p v-if="historyError !== null" class="field-error" role="alert">{{ historyError }}</p>
          <p v-else-if="historyLoading && historyEvents.length === 0" class="hint" role="status">
            Loading process history…
          </p>
          <p v-else-if="historyEvents.length === 0" class="hint">No process events recorded.</p>
          <ol v-else class="stack--tight" id="process-history-events">
            <li v-for="event in historyEvents" :key="event.id" class="cluster" data-process-event>
              <span class="mono">
                <time :datetime="event.createdAt" :title="absoluteTime(event.createdAt)">{{
                  timeAgo(event.createdAt)
                }}</time>
              </span>
              <StatusPill :pill="processPill(event.state, event.phase)" />
              <span class="badge badge--mono">{{ event.source }}</span>
              <span v-if="event.reason !== null" class="small">{{ event.reason }}</span>
              <span v-if="event.message !== null" class="small">{{ event.message }}</span>
            </li>
          </ol>
          <button
            v-if="historyHasMore"
            class="btn btn-ghost btn-sm"
            id="process-history-load-older"
            type="button"
            :disabled="historyLoading"
            @click="emit('load-older')"
          >
            Load older
          </button>
        </div>
      </details>
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
