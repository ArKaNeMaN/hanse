<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, onMounted, ref, watch } from "vue";
import { ApiError, apiQuery } from "../api.js";
import { absoluteTime, timeAgo } from "../format.js";
import type {
  SkillSourceAction,
  SkillSourceSkillsResponse,
  SkillSourceView,
  SnapshotSkill,
  SourceFilePreview,
} from "../skill-sources-types.js";
import type { PillSpec } from "../status.js";
import AppIcon from "./AppIcon.vue";
import SafeMarkdown from "./SafeMarkdown.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  open: boolean;
  sourceId: string | null;
  fallbackSource?: SkillSourceView | null;
  busy?: boolean;
  syncing?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  action: [action: SkillSourceAction, source: SkillSourceView];
}>();

const dialogEl = ref<HTMLDialogElement | null>(null);
const expandedKey = ref<string | null>(null);
const previewKey = ref<string | null>(null);
const previews = ref<
  Record<string, { loading: boolean; error: string | null; data: SourceFilePreview | null }>
>({});
const copiedEndpoint = ref(false);

const detail = useQuery<SkillSourceSkillsResponse>({
  queryKey: computed(() => ["skill-source-skills", props.sourceId ?? ""]),
  queryFn: () =>
    apiQuery<SkillSourceSkillsResponse>(
      `/api/skill-sources/${encodeURIComponent(props.sourceId ?? "")}/skills`,
    ),
  enabled: computed(() => props.open && props.sourceId !== null),
  retry: false,
  refetchOnWindowFocus: false,
});

const source = computed<SkillSourceView | null>(
  () => detail.data.value?.source ?? props.fallbackSource ?? null,
);
const skills = computed<readonly SnapshotSkill[]>(() => detail.data.value?.skills ?? []);
const loading = computed(() => detail.isPending.value && detail.data.value === undefined);
const failed = computed(() => detail.isError.value);
const failure = computed(() => {
  const error = detail.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load source skills.";
});

function statusPill(value: SkillSourceView, syncing: boolean): PillSpec {
  if (syncing || value.state === "syncing") {
    return { variant: "status", dataState: "in_progress", icon: "loader", label: "Syncing" };
  }
  switch (value.state) {
    case "never_synced":
      return { variant: "status", dataState: "queued", icon: "clock", label: "Never synced" };
    case "ready":
      return { variant: "status", dataState: "delivered", icon: "check", label: "Ready" };
    case "degraded":
      return {
        variant: "status",
        dataState: "awaiting_approval",
        icon: "alert-triangle",
        label: "Degraded",
      };
    case "error":
      return { variant: "status", dataState: "failed", icon: "alert-triangle", label: "Error" };
    case "disabled":
      return { variant: "status", dataState: "cancelled", icon: "slash", label: "Disabled" };
    default:
      return { variant: "status", dataState: "queued", icon: "clock", label: "Unknown" };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(iso: string | null): string {
  return iso === null ? "Never" : timeAgo(iso);
}

function whenTitle(iso: string | null): string | undefined {
  return iso === null ? undefined : absoluteTime(iso);
}

function shortRevision(revision: string | null): string {
  return revision === null ? "—" : revision.slice(0, 7);
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

async function copyEndpoint(value: string): Promise<void> {
  if (navigator.clipboard === undefined) {
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    copiedEndpoint.value = true;
    setTimeout(() => {
      copiedEndpoint.value = false;
    }, 1500);
  } catch {
    copiedEndpoint.value = false;
  }
}

function bucketsLabel(value: SkillSourceView): string {
  return value.config.buckets.length === 0 ? "All buckets" : value.config.buckets.join(", ");
}

function skillsBytes(value: SnapshotSkill): number {
  return value.files.reduce((total, file) => total + file.size, 0);
}

function skillKey(value: SnapshotSkill): string {
  return `${value.bucket}/${value.name}`;
}

function fileKey(value: SnapshotSkill, path: string): string {
  return `${value.bucket}/${value.name}/${path}`;
}

function toggleSkill(value: SnapshotSkill): void {
  const key = skillKey(value);
  expandedKey.value = expandedKey.value === key ? null : key;
}

function emptyKind(value: SkillSourceView): "disabled" | "never" | "empty" | null {
  if (skills.value.length > 0) {
    return null;
  }
  if (value.state === "disabled") {
    return "disabled";
  }
  if (value.activeSnapshotId === null && value.lastSuccessAt === null) {
    return "never";
  }
  return "empty";
}

function emitAction(action: SkillSourceAction): void {
  const current = source.value;
  if (current === null || props.busy === true) {
    return;
  }
  emit("action", action, current);
}

function isMarkdownPath(value: string): boolean {
  return /\.(md|markdown)$/i.test(value);
}

function previewOf(key: string): {
  loading: boolean;
  error: string | null;
  data: SourceFilePreview | null;
} {
  return previews.value[key] ?? { loading: false, error: null, data: null };
}

async function toggleFile(value: SnapshotSkill, path: string): Promise<void> {
  const key = fileKey(value, path);
  if (previewKey.value === key) {
    previewKey.value = null;
    return;
  }
  previewKey.value = key;
  const current = source.value;
  const snapshotId = current?.activeSnapshotId ?? null;
  if (current === null || snapshotId === null) {
    return;
  }
  if (previews.value[key]?.data !== undefined && previews.value[key]?.data !== null) {
    return;
  }
  previews.value = {
    ...previews.value,
    [key]: { loading: true, error: null, data: null },
  };
  const params = new URLSearchParams({
    snapshotId,
    bucket: value.bucket,
    name: value.name,
    path,
  });
  try {
    const data = await apiQuery<SourceFilePreview>(
      `/api/skill-sources/${encodeURIComponent(current.id)}/files?${params.toString()}`,
    );
    if (source.value?.activeSnapshotId !== snapshotId) {
      return;
    }
    previews.value = { ...previews.value, [key]: { loading: false, error: null, data } };
  } catch (error) {
    if (source.value?.activeSnapshotId !== snapshotId) {
      return;
    }
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not load the file.";
    previews.value = { ...previews.value, [key]: { loading: false, error: message, data: null } };
  }
}

function syncOpenState(): void {
  const dialog = dialogEl.value;
  if (dialog === null) {
    return;
  }
  if (props.open && !dialog.open) {
    dialog.showModal();
  } else if (!props.open && dialog.open) {
    dialog.close();
  }
}

watch(() => props.open, syncOpenState);
onMounted(syncOpenState);

watch(
  () => props.sourceId,
  () => {
    expandedKey.value = null;
    previewKey.value = null;
    previews.value = {};
  },
);

// A sync can replace the active snapshot while the drawer stays open. Previews are resolved
// against that snapshot, so a cached body from the previous revision must not survive it.
watch(
  () => detail.data.value?.source.activeSnapshotId ?? null,
  (snapshotId, previous) => {
    if (snapshotId === previous) {
      return;
    }
    previewKey.value = null;
    previews.value = {};
  },
);

function close(): void {
  if (props.busy === true) {
    return;
  }
  emit("close");
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog source-drawer"
    aria-labelledby="skill-source-drawer-title"
    @cancel.prevent="close"
  >
    <div class="dialog__frame source-drawer__frame">
      <header class="source-drawer__head">
        <div class="source-drawer__identity">
          <p class="source-drawer__overline">Skill source</p>
          <h2 class="dialog__title" id="skill-source-drawer-title">
            {{ source?.name ?? "Skill source" }}
          </h2>
          <p v-if="source !== null" class="dialog__meta mono">
            {{ source.slug }} · {{ hostOf(source.endpoint) }}
          </p>
        </div>
        <div class="source-drawer__status">
          <StatusPill v-if="source !== null" :pill="statusPill(source, syncing === true)" />
          <span v-if="source?.stale === true" class="badge badge-warning">
            <AppIcon name="hourglass" />Stale
          </span>
          <span v-if="source?.mode === 'pinned'" class="badge">
            <AppIcon name="lock" />Pinned
          </span>
        </div>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          aria-label="Close skill source details"
          :disabled="busy"
          @click="close"
        >
          <AppIcon name="x" />
        </button>
      </header>

      <div class="source-drawer__body">
        <p v-if="loading" class="hint" role="status" aria-live="polite">Loading source…</p>

        <div v-else-if="failed && source === null" class="error-state" role="alert">
          <span class="error-state__mark"><AppIcon name="alert-triangle" /></span>
          <div>
            <h3 class="error-state__title">Source could not be loaded</h3>
            <p class="error-state__body">{{ failure }}</p>
            <button class="btn btn-secondary btn-sm" type="button" @click="detail.refetch()">
              <AppIcon name="refresh" />Retry
            </button>
          </div>
        </div>

        <template v-else-if="source !== null">
          <section
            v-if="source.lastErrorCode !== null"
            class="error-state"
            aria-labelledby="skill-source-drawer-error"
          >
            <span class="error-state__mark"><AppIcon name="alert-triangle" /></span>
            <div>
              <h3 class="error-state__title" id="skill-source-drawer-error">Source sync failed</h3>
              <p class="error-state__body">
                {{ source.lastErrorMessage ?? "The last sync attempt failed." }}
              </p>
              <p class="mono">{{ source.lastErrorCode }}</p>
              <button
                v-if="source.state !== 'disabled'"
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="busy || syncing"
                @click="emitAction('sync')"
              >
                <AppIcon name="refresh" />Retry sync
              </button>
            </div>
          </section>

          <section class="source-drawer__section" aria-labelledby="source-summary-title">
            <h3 class="source-drawer__subtitle" id="source-summary-title">Summary</h3>
            <dl class="skill-source-summary">
              <div class="skill-source-summary__row">
                <dt>Endpoint</dt>
                <dd class="cluster">
                  <span class="mono">{{ source.endpoint }}</span>
                  <button
                    class="btn btn-ghost btn-icon btn-sm"
                    type="button"
                    aria-label="Copy endpoint"
                    @click="copyEndpoint(source.endpoint)"
                  >
                    <AppIcon name="copy" />
                  </button>
                  <span class="sr-only" role="status">{{
                    copiedEndpoint ? "Endpoint copied" : ""
                  }}</span>
                </dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Kind</dt>
                <dd class="mono">{{ source.kind }}</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Buckets</dt>
                <dd class="mono">{{ bucketsLabel(source) }}</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Priority</dt>
                <dd class="mono">{{ source.priority }}</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Sync interval</dt>
                <dd class="mono">{{ source.syncIntervalSec }}s</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Stale after</dt>
                <dd class="mono">{{ source.staleAfterSec }}s</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Request timeout</dt>
                <dd class="mono">{{ source.requestTimeoutMs }}ms</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Last attempt</dt>
                <dd>
                  <time
                    v-if="source.lastAttemptAt"
                    :datetime="source.lastAttemptAt"
                    :title="whenTitle(source.lastAttemptAt)"
                  >
                    {{ formatWhen(source.lastAttemptAt) }}
                  </time>
                  <span v-else class="hint">Never</span>
                </dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Last success</dt>
                <dd>
                  <time
                    v-if="source.lastSuccessAt"
                    :datetime="source.lastSuccessAt"
                    :title="whenTitle(source.lastSuccessAt)"
                  >
                    {{ formatWhen(source.lastSuccessAt) }}
                  </time>
                  <span v-else class="hint">Never</span>
                </dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Last checked</dt>
                <dd>
                  <time
                    v-if="source.lastCheckedAt"
                    :datetime="source.lastCheckedAt"
                    :title="whenTitle(source.lastCheckedAt)"
                  >
                    {{ formatWhen(source.lastCheckedAt) }}
                  </time>
                  <span v-else class="hint">Never</span>
                </dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Revision</dt>
                <dd class="mono">{{ shortRevision(source.revision) }}</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Active snapshot</dt>
                <dd class="mono">{{ source.activeSnapshotId ?? "—" }}</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Pinned snapshot</dt>
                <dd class="mono">{{ source.pinnedSnapshotId ?? "—" }}</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Updated</dt>
                <dd>
                  <time :datetime="source.updatedAt" :title="whenTitle(source.updatedAt)">
                    {{ formatWhen(source.updatedAt) }}
                  </time>
                  <span v-if="source.updatedBy !== null" class="mono">
                    · {{ source.updatedBy }}</span
                  >
                </dd>
              </div>
            </dl>
          </section>

          <section class="source-drawer__section" aria-labelledby="source-credential-title">
            <h3 class="source-drawer__subtitle" id="source-credential-title">Credential</h3>
            <p class="source-drawer__credential">
              Token:
              <span class="badge" :class="source.tokenSet ? 'badge-success' : 'badge-ghost'">
                <AppIcon :name="source.tokenSet ? 'check' : 'slash'" />
                {{ source.tokenSet ? "Set" : "Not set" }}
              </span>
              <span v-if="source.tokenUpdatedAt !== null" class="hint">
                updated {{ formatWhen(source.tokenUpdatedAt) }}
              </span>
            </p>
            <div class="cluster">
              <button
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="busy"
                @click="emitAction('replace-token')"
              >
                Replace token
              </button>
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="busy || !source.tokenSet"
                @click="emitAction('clear-token')"
              >
                Clear token
              </button>
            </div>
          </section>

          <section class="source-drawer__section" aria-labelledby="source-actions-title">
            <h3 class="source-drawer__subtitle" id="source-actions-title">Actions</h3>
            <div class="cluster">
              <button
                class="btn btn-primary btn-sm"
                type="button"
                :disabled="busy || syncing || source.state === 'disabled'"
                @click="emitAction('sync')"
              >
                <AppIcon name="refresh" />Sync now
              </button>
              <button
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="busy || source.state === 'disabled'"
                @click="emitAction('check')"
              >
                Check for updates
              </button>
              <button
                v-if="source.activeSnapshotId !== null"
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="busy"
                @click="emitAction(source.mode === 'pinned' ? 'unpin' : 'pin')"
              >
                <AppIcon name="lock" />{{ source.mode === "pinned" ? "Unpin" : "Pin" }}
              </button>
              <button
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="busy"
                @click="emitAction(source.enabled ? 'disable' : 'enable')"
              >
                {{ source.enabled ? "Disable" : "Enable" }}
              </button>
              <button
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="busy"
                @click="emitAction('edit')"
              >
                Edit
              </button>
              <button
                class="btn btn-danger btn-sm"
                type="button"
                :disabled="busy"
                @click="emitAction('delete')"
              >
                Delete
              </button>
            </div>
          </section>

          <section class="source-drawer__section" aria-labelledby="source-skills-title">
            <h3 class="source-drawer__subtitle" id="source-skills-title">Skills</h3>

            <div v-if="emptyKind(source) !== null" class="empty-state">
              <div class="empty-state__icon"><AppIcon name="inbox" /></div>
              <template v-if="emptyKind(source) === 'disabled'">
                <h4 class="empty-state__title">Source disabled</h4>
                <p class="empty-state__body">
                  This source is disabled. Enable it to sync and publish skills again.
                </p>
                <button
                  class="btn btn-secondary btn-sm"
                  type="button"
                  :disabled="busy"
                  @click="emitAction('enable')"
                >
                  Enable source
                </button>
              </template>
              <template v-else-if="emptyKind(source) === 'never'">
                <h4 class="empty-state__title">No skills synced yet</h4>
                <p class="empty-state__body">Run a sync to publish the first snapshot.</p>
                <button
                  class="btn btn-secondary btn-sm"
                  type="button"
                  :disabled="busy || syncing"
                  @click="emitAction('sync')"
                >
                  <AppIcon name="refresh" />Run a sync
                </button>
              </template>
              <template v-else>
                <h4 class="empty-state__title">No skills in the active snapshot</h4>
                <p class="empty-state__body">Run a sync to publish a new snapshot.</p>
                <button
                  class="btn btn-secondary btn-sm"
                  type="button"
                  :disabled="busy || syncing"
                  @click="emitAction('sync')"
                >
                  <AppIcon name="refresh" />Run a sync
                </button>
              </template>
            </div>

            <div v-else class="table-wrap">
              <table class="table table--stack skill-source-skills-table">
                <thead>
                  <tr>
                    <th scope="col">Skill</th>
                    <th scope="col">Bucket</th>
                    <th scope="col">Version</th>
                    <th scope="col">Files</th>
                    <th scope="col">Bytes</th>
                    <th scope="col">State</th>
                    <th scope="col"><span class="sr-only">Files</span></th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="skill in skills" :key="skillKey(skill)">
                    <tr :data-source-skill="skill.name">
                      <td class="table__primary" data-label="Skill">
                        <button class="link-button" type="button" @click="toggleSkill(skill)">
                          {{ skill.name }}
                        </button>
                        <p class="small">{{ skill.description }}</p>
                      </td>
                      <td data-label="Bucket"><span class="mono">{{ skill.bucket }}</span></td>
                      <td data-label="Version">
                        <span class="mono">{{ skill.version ?? "—" }}</span>
                      </td>
                      <td data-label="Files"><span class="mono">{{ skill.files.length }}</span></td>
                      <td data-label="Bytes">
                        <span class="mono">{{ formatBytes(skillsBytes(skill)) }}</span>
                      </td>
                      <td data-label="State">
                        <span
                          class="status"
                          :data-state="skill.state === 'ok' ? 'delivered' : 'awaiting_approval'"
                        >
                          <AppIcon :name="skill.state === 'ok' ? 'check' : 'alert-triangle'" />
                          {{ skill.state === "ok" ? "OK" : "Quarantined" }}
                        </span>
                        <p v-if="skill.errorMessage !== null" class="field-error" role="alert">
                          {{ skill.errorMessage }}
                        </p>
                      </td>
                      <td class="table__actions">
                        <button
                          class="btn btn-ghost btn-icon"
                          type="button"
                          :aria-label="`${expandedKey === skillKey(skill) ? 'Hide' : 'Show'} files for ${skill.name}`"
                          :aria-expanded="expandedKey === skillKey(skill)"
                          @click="toggleSkill(skill)"
                        >
                          <AppIcon name="chevron-down" />
                        </button>
                      </td>
                    </tr>
                    <tr v-if="expandedKey === skillKey(skill)" class="skill-source-file-row">
                      <td colspan="7">
                        <ul class="skill-source-file-list">
                          <li v-for="file in skill.files" :key="file.path">
                            <button
                              class="link-button mono"
                              type="button"
                              :aria-expanded="previewKey === fileKey(skill, file.path)"
                              @click="toggleFile(skill, file.path)"
                            >
                              {{ file.path }}
                            </button>
                            <span class="hint mono">{{ formatBytes(file.size) }}</span>
                            <div
                              v-if="previewKey === fileKey(skill, file.path)"
                              class="skill-source-preview"
                            >
                              <p
                                v-if="previewOf(fileKey(skill, file.path)).loading"
                                class="hint"
                                role="status"
                              >
                                Loading file…
                              </p>
                              <p
                                v-else-if="previewOf(fileKey(skill, file.path)).error !== null"
                                class="field-error"
                                role="alert"
                              >
                                {{ previewOf(fileKey(skill, file.path)).error }}
                              </p>
                              <template
                                v-else-if="previewOf(fileKey(skill, file.path)).data !== null"
                              >
                                <template
                                  v-if="
                                    previewOf(fileKey(skill, file.path)).data?.encoding === 'text'
                                  "
                                >
                                  <SafeMarkdown
                                    v-if="isMarkdownPath(file.path)"
                                    class="prose skill-prose"
                                    :text="previewOf(fileKey(skill, file.path)).data?.text ?? ''"
                                  />
                                  <pre
                                    v-else
                                    class="skill-source-preview__text mono"
                                  >{{ previewOf(fileKey(skill, file.path)).data?.text }}</pre>
                                  <details
                                    v-if="isMarkdownPath(file.path)"
                                    class="skill-source-disclosure"
                                  >
                                    <summary>Source</summary>
                                    <pre
                                      class="skill-source-preview__text mono"
                                    >{{ previewOf(fileKey(skill, file.path)).data?.text }}</pre>
                                  </details>
                                </template>
                                <p v-else class="hint mono">
                                  Binary file ·
                                  {{
                                    formatBytes(
                                      previewOf(fileKey(skill, file.path)).data?.size ?? file.size,
                                    )
                                  }}
                                  · sha256
                                  {{
                                    (
                                      previewOf(fileKey(skill, file.path)).data?.sha256 ??
                                      file.sha256
                                    ).slice(0, 12)
                                  }}…
                                </p>
                              </template>
                            </div>
                          </li>
                        </ul>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </section>
        </template>
      </div>
    </div>
  </dialog>
</template>
