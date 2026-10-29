<script setup lang="ts">
import { ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { SettingsPendingRowProps, SettingsProps } from "../settings-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import SmartLink from "./SmartLink.vue";

defineProps<{ settings: SettingsProps }>();
const emit = defineEmits<{ changed: [message: string] }>();
const toasts = useToastStore();

const busy = ref<string | null>(null);

async function restart(entry: SettingsPendingRowProps): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  busy.value = entry.appId;
  try {
    const result = await apiMutation<{ restarted: boolean; reason?: string }>(entry.restartAction, {
      json: {},
    });
    const message = result.restarted
      ? "Agent restarted."
      : "Agent is not running; settings apply on next start.";
    emit("changed", message);
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not restart the agent.";
    toasts.push(message, "error");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section
    class="card settings-section"
    id="settings-restart"
    aria-labelledby="restart-pending-title"
  >
    <div class="card__head">
      <h2 class="card__title" id="restart-pending-title">
        {{ settings.labels.sections.restart }}
      </h2>
      <span class="badge">{{ settings.restart.pending.length }}</span>
    </div>
    <div class="card__body" id="restart-pending">
      <p class="hint">{{ settings.labels.restart.hint }}</p>
      <p v-if="settings.restart.pending.length === 0" class="hint">
        {{ settings.labels.restart.empty }}
      </p>
      <div v-else class="stack--tight">
        <div
          v-for="entry in settings.restart.pending"
          :key="entry.appId"
          class="cluster"
          :id="`pending-${entry.appId}`"
        >
          <span class="status" data-state="awaiting_approval">
            <AppIcon name="stamp" />Restart required
          </span>
          <SmartLink class="small" :to="entry.href">{{ entry.appKey }}</SmartLink>
          <span class="small">{{ entry.reasonLabels.join(", ") }}</span>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="busy !== null"
            @click="restart(entry)"
          >
            <AppIcon name="refresh" />{{ settings.labels.actions.restartAgent }}
          </button>
        </div>
      </div>
    </div>
    <section
      v-if="settings.restart.profileWarnings.length > 0"
      class="settings-warning settings-warning--profile"
      aria-labelledby="profile-warnings-title"
    >
      <p class="settings-warning__title" id="profile-warnings-title">
        <AppIcon name="alert-triangle" />{{ settings.labels.restart.profileWarnings }}
      </p>
      <div class="stack--tight">
        <p
          v-for="warning in settings.restart.profileWarnings"
          :key="warning"
          class="field-error"
          role="alert"
        >
          <AppIcon name="alert-triangle" />{{ warning }}
        </p>
      </div>
    </section>
  </section>
</template>
