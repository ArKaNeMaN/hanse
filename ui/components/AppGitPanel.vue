<script setup lang="ts">
import { computed } from "vue";
import type { AppGitSummaryProps } from "../app-types.js";
import type { PillSpec } from "../status.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  summary: AppGitSummaryProps;
  refreshedLabel: string;
  refreshing: boolean;
}>();

const emit = defineEmits<{ refresh: [] }>();

const pill = computed<PillSpec>(() => {
  const summary = props.summary;
  if (!summary.loaded) {
    return { variant: "status", dataState: "cancelled", icon: "slash", label: "Unavailable" };
  }
  if (summary.conflicted) {
    return { variant: "status", dataState: "failed", icon: "alert-triangle", label: "Conflicts" };
  }
  if (summary.operation !== null && summary.operation.length > 0) {
    return {
      variant: "status",
      dataState: "in_progress",
      icon: "activity",
      label: "In progress",
    };
  }
  if (summary.detached) {
    return { variant: "status", dataState: "cancelled", icon: "slash", label: "Detached" };
  }
  if (summary.clean) {
    return { variant: "status", dataState: "delivered", icon: "check", label: "Clean" };
  }
  return {
    variant: "status",
    dataState: "awaiting_approval",
    icon: "stamp",
    label: "Changes",
  };
});

const branchLabel = computed(() => {
  const summary = props.summary;
  if (summary.detached) return "Detached HEAD";
  return summary.branch?.name ?? "Unknown branch";
});

const headLabel = computed(() => {
  const head = props.summary.branch?.head ?? null;
  if (head === null || head.length === 0) return "No commits";
  return head.slice(0, 12);
});

const counts = computed(() => {
  const value = props.summary.counts;
  return [
    { key: "staged", label: "Staged", count: value.staged },
    { key: "unstaged", label: "Unstaged", count: value.unstaged },
    { key: "untracked", label: "Untracked", count: value.untracked },
    { key: "conflicted", label: "Conflicted", count: value.conflicted },
  ] as const;
});

const changeTotal = computed(() => counts.value.reduce((total, group) => total + group.count, 0));
</script>

<template>
  <div class="stack">
    <section class="card" id="repository-card" aria-labelledby="repository-title">
      <div class="card__head">
        <h2 class="card__title" id="repository-title">Repository</h2>
        <div class="cluster">
          <span class="mono" id="git-refreshed">{{ refreshedLabel }}</span>
          <button
            class="btn btn-ghost btn-icon btn-sm"
            type="button"
            :disabled="refreshing"
            aria-label="Refresh repository status"
            title="Refresh repository status"
            @click="emit('refresh')"
          >
            <AppIcon name="refresh" />
          </button>
        </div>
      </div>
      <div class="card__body stack--tight">
        <p v-if="!summary.loaded" class="hint" id="git-unavailable">
          {{ summary.message ?? "Repository status is unavailable." }}
        </p>
        <template v-else>
          <div class="git-status__row">
            <div class="stack--tight">
              <span class="overline">Current branch</span>
              <div class="git-branch" id="git-branch">
                <AppIcon name="branch" />
                <span class="mono" :title="summary.branch?.name ?? undefined">{{
                  branchLabel
                }}</span>
              </div>
              <div class="cluster" id="git-upstream">
                <span class="caption">Upstream</span>
                <template v-if="summary.upstream !== null">
                  <span class="mono">{{ summary.upstream.name }}</span>
                  <span v-if="summary.ahead > 0" class="badge badge--mono">
                    {{ summary.ahead }}
                    ahead
                  </span>
                  <span v-if="summary.behind > 0" class="badge badge--mono">
                    {{ summary.behind }}
                    behind
                  </span>
                </template>
                <span v-else class="mono">No upstream</span>
              </div>
              <div class="cluster">
                <span class="caption">HEAD</span>
                <span class="mono" id="git-head">{{ headLabel }}</span>
              </div>
            </div>
            <div class="cluster"><StatusPill :pill="pill" /></div>
          </div>
          <p v-if="summary.message !== null" class="hint">{{ summary.message }}</p>
          <p v-if="summary.operation !== null" class="hint">
            Operation in progress: {{ summary.operation }}.
          </p>
        </template>
      </div>
    </section>

    <section class="card" id="changes-card" aria-labelledby="changes-title">
      <div class="card__head">
        <h2 class="card__title" id="changes-title">Changes</h2>
        <div class="cluster" id="git-change-counts">
          <span v-if="changeTotal === 0" class="mono">0 files</span>
          <template v-else>
            <span
              v-for="group in counts.filter((entry) => entry.count > 0)"
              :key="group.key"
              class="badge badge--mono"
            >
              {{ group.label }} {{ group.count }}
            </span>
          </template>
        </div>
      </div>
      <div class="card__body stack--tight">
        <p v-if="!summary.loaded" class="hint">Changes are unavailable for this repository.</p>
        <div v-else-if="changeTotal === 0" class="empty-state" id="git-clean">
          <span class="empty-state__mark"><AppIcon name="check" class-name="icon--lg" /></span>
          <h3 class="empty-state__title">Working tree clean</h3>
          <p class="empty-state__body">No staged, unstaged, untracked, or conflicted files.</p>
        </div>
        <div v-else class="stack--tight">
          <div v-for="group in counts" :key="group.key" class="summary-row">
            <span class="overline">{{ group.label }}</span>
            <span class="mono">{{ group.count }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
