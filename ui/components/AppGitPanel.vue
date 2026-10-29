<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AppGitSummaryProps } from "../app-types.js";
import type { GitCommitError, GitLoadFailure, GitNotice } from "../composables/useAppGit.js";
import {
  changeCodeLabel,
  GIT_FILE_GROUPS,
  GIT_GROUP_LABEL,
  type GitControlRules,
  type GitFile,
  type GitFileGroup,
  type GitMutation,
  type GitRepoEmptyState,
  type GitStatus,
  gitRepoEmptyState,
  pushLabel,
} from "../git-types.js";
import type { PillSpec } from "../status.js";
import AppIcon from "./AppIcon.vue";
import SmartLink from "./SmartLink.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  summary: AppGitSummaryProps;
  status: GitStatus | null;
  rules: GitControlRules;
  hint: string;
  loading: boolean;
  busyAction: GitMutation | null;
  failure: GitLoadFailure | null;
  notice: GitNotice | null;
  commitDraft: string;
  commitError: GitCommitError | null;
  needsRefresh: boolean;
  refreshedLabel: string;
  ideHref: string;
  projectHref: string;
  liveMessage: string;
}>();

const emit = defineEmits<{
  refresh: [];
  action: [action: GitMutation, body: Record<string, string>];
  commit: [];
  switch: [branch: string];
  "update:commitDraft": [value: string];
}>();

const BUSY_LABEL: Record<GitMutation, string> = {
  fetch: "Fetching",
  update: "Updating",
  push: "Pushing",
  commit: "Committing",
  switch: "Switching",
};

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
  if (props.summary.detached) return "Detached HEAD";
  return props.summary.branch?.name ?? "Unknown branch";
});

const headLabel = computed(() => {
  const head = props.summary.branch?.head ?? null;
  if (head === null || head.length === 0) return "No commits";
  return head.slice(0, 12);
});

const counts = computed(() => {
  const value = props.summary.counts;
  return GIT_FILE_GROUPS.map((key) => ({
    key,
    label: GIT_GROUP_LABEL[key],
    count: value[key],
  }));
});

const changeTotal = computed(() => counts.value.reduce((total, group) => total + group.count, 0));
const files = computed<readonly GitFile[]>(() => props.status?.files ?? []);
const filesByGroup = computed(() => {
  const groups: Record<GitFileGroup, GitFile[]> = {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  for (const file of files.value) {
    groups[file.group].push(file);
  }
  return groups;
});
const visibleGroups = computed(() =>
  GIT_FILE_GROUPS.filter((group) => filesByGroup.value[group].length > 0),
);

const repositoryState = computed<GitRepoEmptyState | null>(() => {
  if (props.status === null || props.status.state === "ok") return null;
  return gitRepoEmptyState(props.status);
});

const controlsDisabled = computed(() => props.loading || props.busyAction !== null);
const showCommitForm = computed(
  () => props.status?.state === "ok" && files.value.length > 0 && props.failure === null,
);
const commitHint = computed(
  () =>
    props.rules.commitReason ??
    "Commits all staged, unstaged, and untracked changes. Ignored files stay out.",
);
const commitIdeLink = computed(
  () => props.rules.commitReason !== null && (props.rules.conflicts || props.rules.operation),
);

const branchChoices = computed(() => {
  const choices: string[] = [];
  for (const branch of props.status?.branches ?? []) {
    if (branch.length > 0 && !choices.includes(branch)) {
      choices.push(branch);
    }
  }
  const current =
    props.status?.branch?.detached === true ? null : (props.status?.branch?.name ?? null);
  if (current !== null && !choices.includes(current)) {
    choices.push(current);
  }
  return choices;
});

const currentBranch = computed(() =>
  props.status?.branch?.detached === true ? null : (props.status?.branch?.name ?? null),
);

const needsPlaceholder = computed(
  () =>
    props.status?.branch !== undefined &&
    (props.status.branch.detached === true ||
      props.status.branch.head === null ||
      props.status.branch.head === undefined),
);

const selectedBranch = ref(currentBranch.value ?? "");

watch(
  currentBranch,
  (current) => {
    selectedBranch.value = current ?? "";
  },
  { immediate: true },
);

const noBranches = computed(() => branchChoices.value.length === 0);
const showSwitchForm = computed(
  () =>
    branchChoices.value.length > 1 || (branchChoices.value.length > 0 && needsPlaceholder.value),
);
const onlyBranchLabel = computed(() => {
  const only = branchChoices.value.length === 1 ? branchChoices.value[0] : currentBranch.value;
  return `Only local branch: ${only ?? "none"}.`;
});

const noticeIcon = computed(() => {
  if (props.notice?.tone === "error") return "alert-triangle";
  if (props.notice?.tone === "warning") return "alert-circle";
  return "check";
});

function labelFor(action: GitMutation): string {
  if (action === "fetch") return "Fetch";
  if (action === "update") return "Update branch";
  if (action === "push") return pushLabel(props.rules);
  if (action === "commit") return "Commit all";
  return "Switch";
}

function buttonLabel(action: GitMutation): string {
  return props.busyAction === action ? BUSY_LABEL[action] : labelFor(action);
}

function run(action: GitMutation): void {
  if (props.busyAction !== null) return;
  emit("action", action, {});
}

function refresh(): void {
  if (props.loading || props.busyAction !== null) return;
  emit("refresh");
}

function commit(): void {
  if (props.rules.commit || controlsDisabled.value) return;
  emit("commit");
}

function commitInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement) {
    emit("update:commitDraft", target.value);
  }
}

function commitKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    commit();
  }
}

function branchInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLSelectElement) {
    selectedBranch.value = target.value;
  }
}

function submitSwitch(): void {
  if (props.rules.switch || controlsDisabled.value) return;
  emit("switch", selectedBranch.value);
}
</script>

<template>
  <div class="stack">
    <p id="git-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ liveMessage }}
    </p>

    <section class="card" id="repository-card" aria-labelledby="repository-title">
      <div class="card__head">
        <h2 class="card__title" id="repository-title">Repository</h2>
        <div class="cluster">
          <span class="mono" id="git-refreshed">{{ refreshedLabel }}</span>
          <button
            class="btn btn-ghost btn-icon btn-sm"
            type="button"
            id="git-refresh"
            :disabled="loading || busyAction !== null"
            :aria-busy="loading ? 'true' : undefined"
            aria-label="Refresh repository status"
            title="Refresh repository status"
            @click="refresh"
          >
            <span v-if="loading" class="spinner" aria-hidden="true" />
            <AppIcon v-else name="refresh" />
          </button>
        </div>
      </div>
      <div class="card__body stack--tight" id="git-repository-body">
        <div v-if="failure !== null" class="error-state" role="alert">
          <span class="error-state__mark">
            <AppIcon name="alert-triangle" class-name="icon--lg" />
          </span>
          <div>
            <h3 class="error-state__title">{{ failure.title }}</h3>
            <p class="error-state__body">{{ failure.message }}</p>
            <SmartLink v-if="failure.outside" class="btn btn-secondary btn-sm" :to="projectHref">
              <AppIcon name="folder" />Open project
            </SmartLink>
            <button v-else class="btn btn-secondary btn-sm" type="button" @click="refresh">
              Retry
            </button>
          </div>
        </div>

        <div v-else-if="repositoryState !== null" class="empty-state">
          <span class="empty-state__mark">
            <AppIcon :name="repositoryState.icon" class-name="icon--lg" />
          </span>
          <h3 class="empty-state__title">{{ repositoryState.title }}</h3>
          <p class="empty-state__body">{{ repositoryState.body }}</p>
          <p v-if="repositoryState.detail !== null" class="mono">{{ repositoryState.detail }}</p>
          <a
            v-if="repositoryState.action === 'ide'"
            class="btn btn-secondary btn-sm"
            :href="ideHref"
            target="_blank"
            rel="noreferrer"
          >
            <AppIcon name="external" />Open IDE
          </a>
          <SmartLink
            v-else-if="repositoryState.action === 'project'"
            class="btn btn-secondary btn-sm"
            :to="projectHref"
          >
            <AppIcon name="folder" />Open project
          </SmartLink>
        </div>

        <p v-else-if="!summary.loaded" class="hint" id="git-unavailable">
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

          <div class="git-actions" id="git-actions">
            <button
              class="btn btn-secondary"
              type="button"
              id="git-fetch"
              data-git-action="fetch"
              :disabled="rules.fetch || controlsDisabled"
              @click="run('fetch')"
            >
              <span v-if="busyAction === 'fetch'" class="spinner" aria-hidden="true" />
              <AppIcon v-else name="refresh" />
              <span class="btn__label">{{ buttonLabel("fetch") }}</span>
            </button>
            <button
              class="btn btn-secondary"
              type="button"
              id="git-update"
              data-git-action="update"
              :disabled="rules.update || controlsDisabled"
              @click="run('update')"
            >
              <span v-if="busyAction === 'update'" class="spinner" aria-hidden="true" />
              <span class="btn__label">{{ buttonLabel("update") }}</span>
            </button>
            <button
              class="btn btn-secondary"
              type="button"
              id="git-push"
              data-git-action="push"
              :disabled="rules.push || controlsDisabled || needsRefresh"
              @click="run('push')"
            >
              <span v-if="busyAction === 'push'" class="spinner" aria-hidden="true" />
              <AppIcon v-else name="arrow-right" />
              <span class="btn__label">{{ buttonLabel("push") }}</span>
            </button>
          </div>
          <p class="hint" id="git-actions-hint">{{ hint }}</p>

          <div
            v-if="notice !== null"
            class="git-notice"
            id="git-notice"
            :data-tone="notice.tone"
            :role="notice.tone === 'error' ? 'alert' : undefined"
          >
            <AppIcon :name="noticeIcon" />
            <span>
              <strong v-if="notice.title !== null">{{ notice.title }}. </strong>{{ notice.message }}
            </span>
          </div>

          <hr class="rule">

          <form
            v-if="showSwitchForm"
            class="git-switch"
            id="git-switch-form"
            @submit.prevent="submitSwitch"
          >
            <div class="field">
              <label class="label" for="git-branch-select">Switch branch</label>
              <div class="select-wrap">
                <select
                  class="select"
                  id="git-branch-select"
                  :value="selectedBranch"
                  :disabled="rules.switch || controlsDisabled"
                  @change="branchInput"
                >
                  <option v-if="needsPlaceholder || currentBranch === null" value="">
                    Choose a branch
                  </option>
                  <option v-for="branch in branchChoices" :key="branch" :value="branch">
                    {{ branch }}
                  </option>
                </select>
                <AppIcon name="chevron-down" />
              </div>
            </div>
            <button
              class="btn btn-secondary"
              type="submit"
              id="git-switch"
              :disabled="rules.switch || controlsDisabled"
            >
              <span v-if="busyAction === 'switch'" class="spinner" aria-hidden="true" />
              {{ buttonLabel("switch") }}
            </button>
          </form>
          <p v-else class="hint">
            {{ noBranches ? "No local branches available." : onlyBranchLabel }}
          </p>
        </template>
      </div>
    </section>

    <section class="card" id="changes-card" aria-labelledby="changes-title">
      <div class="card__head">
        <h2 class="card__title" id="changes-title" tabindex="-1">Changes</h2>
        <div class="cluster" id="git-change-counts">
          <span v-if="changeTotal === 0 || failure !== null" class="mono">0 files</span>
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
      <div class="card__body stack--tight" id="git-changes-body">
        <p v-if="failure !== null || (status !== null && status.state !== 'ok')" class="hint">
          Changes are unavailable for this repository.
        </p>
        <p v-else-if="!summary.loaded" class="hint">
          {{ loading ? "Loading changes." : "Changes are unavailable for this repository." }}
        </p>
        <div v-else-if="changeTotal === 0" class="empty-state" id="git-clean">
          <span class="empty-state__mark"><AppIcon name="check" class-name="icon--lg" /></span>
          <h3 class="empty-state__title">Working tree clean</h3>
          <p class="empty-state__body">No staged, unstaged, untracked, or conflicted files.</p>
        </div>
        <p v-else-if="files.length === 0" class="hint">Loading changes.</p>
        <template v-else>
          <div class="stack">
            <section
              v-for="group in visibleGroups"
              :key="group"
              class="git-group"
              :data-group="group"
            >
              <div class="git-group__head">
                <div class="cluster">
                  <AppIcon
                    v-if="group === 'conflicted'"
                    name="alert-triangle"
                    class-name="icon--sm"
                  />
                  <h3 class="overline">{{ GIT_GROUP_LABEL[group] }}</h3>
                </div>
                <span class="badge badge--mono">{{ filesByGroup[group].length }}</span>
              </div>
              <ul class="git-file-list">
                <li
                  v-for="file in filesByGroup[group]"
                  :key="`${file.group}:${file.path}`"
                  class="git-file"
                >
                  <span class="git-file__path mono" :title="file.oldPath ?? file.path">
                    {{ file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}` }}
                  </span>
                  <span class="sr-only">{{ changeCodeLabel(file.code) }}</span>
                  <span class="git-file__code" aria-hidden="true">{{ file.code || "?" }}</span>
                </li>
              </ul>
            </section>
          </div>

          <form
            v-if="showCommitForm"
            class="git-commit"
            id="git-commit-form"
            @submit.prevent="commit"
          >
            <div class="field">
              <label class="label" for="git-commit-message">Commit message (required)</label>
              <textarea
                class="textarea"
                id="git-commit-message"
                rows="3"
                maxlength="4000"
                :value="commitDraft"
                :disabled="busyAction !== null"
                :aria-invalid="commitError !== null ? 'true' : undefined"
                aria-required="true"
                aria-describedby="git-commit-hint git-commit-error"
                @input="commitInput"
                @keydown="commitKeydown"
              />
              <p class="hint" id="git-commit-hint">
                {{ commitHint }}
                <a v-if="commitIdeLink" :href="ideHref" target="_blank" rel="noreferrer"
                  >Open IDE</a
                >
              </p>
              <p v-if="commitError !== null" class="field-error" id="git-commit-error" role="alert">
                {{ commitError.title }} {{ commitError.message }}
              </p>
            </div>
            <div class="git-commit__foot">
              <button
                class="btn btn-primary"
                type="submit"
                id="git-commit"
                :disabled="rules.commit || controlsDisabled || needsRefresh"
              >
                <span v-if="busyAction === 'commit'" class="spinner" aria-hidden="true" />
                {{ buttonLabel("commit") }}
              </button>
            </div>
          </form>
        </template>
      </div>
    </section>
  </div>
</template>
