<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, onMounted, ref, watch } from "vue";
import { ApiError, apiQuery } from "../api.js";
import { absoluteTime, timeAgo } from "../format.js";
import type {
  SkillSourceSkillsResponse,
  SnapshotSkill,
  SourceFilePreview,
} from "../skill-sources-types.js";
import type { SkillsInventoryRowProps } from "../skills-types.js";
import AppIcon from "./AppIcon.vue";
import SmartLink from "./SmartLink.vue";

const props = defineProps<{
  open: boolean;
  row: SkillsInventoryRowProps | null;
}>();

const emit = defineEmits<{ close: [] }>();

const dialogEl = ref<HTMLDialogElement | null>(null);
const previewKey = ref<string | null>(null);
const previews = ref<
  Record<string, { loading: boolean; error: string | null; data: SourceFilePreview | null }>
>({});

const origin = computed(() => props.row?.origin ?? null);

const detail = useQuery<SkillSourceSkillsResponse>({
  queryKey: computed(() => ["skill-source-skills", origin.value?.sourceId ?? ""]),
  queryFn: () =>
    apiQuery<SkillSourceSkillsResponse>(
      `/api/skill-sources/${encodeURIComponent(origin.value?.sourceId ?? "")}/skills`,
    ),
  enabled: computed(() => props.open && origin.value !== null),
  retry: false,
  refetchOnWindowFocus: false,
});

const source = computed(() => detail.data.value?.source ?? null);
const skill = computed<SnapshotSkill | null>(() => {
  const target = props.row;
  const sourceOrigin = origin.value;
  if (target === null || sourceOrigin === null) {
    return null;
  }
  return (
    detail.data.value?.skills.find(
      (entry) => entry.bucket === sourceOrigin.bucket && entry.name === target.name,
    ) ?? null
  );
});
const loading = computed(() => detail.isPending.value && detail.data.value === undefined);
const failed = computed(() => detail.isError.value);
const failure = computed(() => {
  const error = detail.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load the external skill.";
});
const unavailable = computed(
  () =>
    failed.value ||
    (!loading.value &&
      detail.data.value !== undefined &&
      (skill.value === null || source.value?.state === "disabled")),
);

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function skillBytes(value: SnapshotSkill): number {
  return value.files.reduce((total, file) => total + file.size, 0);
}

function when(iso: string | null): string {
  return iso === null ? "Unknown" : timeAgo(iso);
}

function whenTitle(iso: string | null): string | undefined {
  return iso === null ? undefined : absoluteTime(iso);
}

function previewOf(key: string): {
  loading: boolean;
  error: string | null;
  data: SourceFilePreview | null;
} {
  return previews.value[key] ?? { loading: false, error: null, data: null };
}

async function toggleFile(value: SnapshotSkill, path: string): Promise<void> {
  const key = `${value.bucket}/${value.name}/${path}`;
  if (previewKey.value === key) {
    previewKey.value = null;
    return;
  }
  previewKey.value = key;
  if (previews.value[key]?.data != null) {
    return;
  }
  const snapshotId = source.value?.activeSnapshotId ?? null;
  const sourceId = origin.value?.sourceId ?? null;
  if (snapshotId === null || sourceId === null) {
    return;
  }
  previews.value = { ...previews.value, [key]: { loading: true, error: null, data: null } };
  const params = new URLSearchParams({
    snapshotId,
    bucket: value.bucket,
    name: value.name,
    path,
  });
  try {
    const data = await apiQuery<SourceFilePreview>(
      `/api/skill-sources/${encodeURIComponent(sourceId)}/files?${params.toString()}`,
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
  () => props.row?.externalKey,
  () => {
    previewKey.value = null;
    previews.value = {};
  },
);

// The source can publish a new snapshot while this read-only drawer is open; file previews are
// bound to the snapshot id, so drop cached bodies when it changes.
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
  emit("close");
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog source-drawer external-skill-drawer"
    aria-labelledby="external-skill-drawer-title"
    @cancel.prevent="close"
  >
    <div class="dialog__frame source-drawer__frame">
      <header class="source-drawer__head">
        <div class="source-drawer__identity">
          <p class="source-drawer__overline">External skill</p>
          <h2 class="dialog__title" id="external-skill-drawer-title">
            {{ row?.name ?? "External skill" }}
          </h2>
          <p class="dialog__meta mono">
            <span class="badge"><AppIcon name="lock" />Read-only</span>
            <span v-if="origin !== null"
              >{{ origin.sourceName }}
              · {{ origin.revision.slice(0, 7) }}</span
            >
          </p>
        </div>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          aria-label="Close external skill details"
          @click="close"
        >
          <AppIcon name="x" />
        </button>
      </header>

      <div class="source-drawer__body">
        <p v-if="loading" class="hint" role="status" aria-live="polite">Loading skill…</p>

        <div v-else-if="unavailable" class="empty-state" role="status">
          <div class="empty-state__icon"><AppIcon name="alert-triangle" /></div>
          <h3 class="empty-state__title">This skill is no longer in the active snapshot</h3>
          <p class="empty-state__body">
            {{
              failed
                ? failure
                : "The source was disabled, synced, or no longer provides this skill."
            }}
          </p>
          <SmartLink class="btn btn-secondary btn-sm" to="/settings#settings-sources">
            Manage source
          </SmartLink>
        </div>

        <template v-else-if="skill !== null && row !== null && origin !== null">
          <p class="source-drawer__banner">
            <AppIcon name="lock" />
            This skill is provided by {{ origin.sourceName }}. Editing is disabled; manage the
            source in Settings.
          </p>

          <dl class="skill-source-summary">
            <div class="skill-source-summary__row">
              <dt>Description</dt>
              <dd>{{ skill.description }}</dd>
            </div>
            <div class="skill-source-summary__row">
              <dt>Source</dt>
              <dd class="mono">{{ origin.sourceName }} · {{ origin.bucket }}</dd>
            </div>
            <div class="skill-source-summary__row">
              <dt>Revision</dt>
              <dd class="mono">{{ origin.revision.slice(0, 7) }}</dd>
            </div>
            <div class="skill-source-summary__row">
              <dt>Version</dt>
              <dd class="mono">{{ skill.version ?? "—" }}</dd>
            </div>
            <div class="skill-source-summary__row">
              <dt>Files</dt>
              <dd class="mono">{{ skill.files.length }} · {{ formatBytes(skillBytes(skill)) }}</dd>
            </div>
            <div class="skill-source-summary__row">
              <dt>Updated</dt>
              <dd>
                <time
                  :datetime="origin.publishedAt ?? row.updatedAt"
                  :title="whenTitle(origin.publishedAt ?? row.updatedAt)"
                >
                  {{ when(origin.publishedAt ?? row.updatedAt) }}
                </time>
              </dd>
            </div>
          </dl>

          <section class="source-drawer__section" aria-labelledby="external-files-title">
            <h3 class="source-drawer__subtitle" id="external-files-title">Files</h3>
            <ul v-if="skill.files.length > 0" class="skill-source-file-list">
              <li v-for="file in skill.files" :key="file.path">
                <button
                  class="link-button mono"
                  type="button"
                  :aria-expanded="previewKey === `${skill.bucket}/${skill.name}/${file.path}`"
                  @click="toggleFile(skill, file.path)"
                >
                  {{ file.path }}
                </button>
                <span class="hint mono">{{ formatBytes(file.size) }}</span>
                <div
                  v-if="previewKey === `${skill.bucket}/${skill.name}/${file.path}`"
                  class="skill-source-preview"
                >
                  <p
                    v-if="previewOf(`${skill.bucket}/${skill.name}/${file.path}`).loading"
                    class="hint"
                    role="status"
                  >
                    Loading file…
                  </p>
                  <p
                    v-else-if="
                      previewOf(`${skill.bucket}/${skill.name}/${file.path}`).error !== null
                    "
                    class="field-error"
                    role="alert"
                  >
                    {{ previewOf(`${skill.bucket}/${skill.name}/${file.path}`).error }}
                  </p>
                  <template
                    v-else-if="
                      previewOf(`${skill.bucket}/${skill.name}/${file.path}`).data !== null
                    "
                  >
                    <pre
                      v-if="
                        previewOf(`${skill.bucket}/${skill.name}/${file.path}`).data?.encoding ===
                        'text'
                      "
                      class="skill-source-preview__text mono"
                    >{{ previewOf(`${skill.bucket}/${skill.name}/${file.path}`).data?.text }}</pre>
                    <p v-else class="hint mono">
                      Binary file ·
                      {{
                        formatBytes(
                          previewOf(`${skill.bucket}/${skill.name}/${file.path}`).data?.size ??
                            file.size,
                        )
                      }}
                      · sha256
                      {{
                        (
                          previewOf(`${skill.bucket}/${skill.name}/${file.path}`).data?.sha256 ??
                          file.sha256
                        ).slice(0, 12)
                      }}…
                    </p>
                  </template>
                </div>
              </li>
            </ul>
            <p v-else class="hint">This skill has no files.</p>
          </section>

          <div class="cluster">
            <SmartLink class="btn btn-secondary btn-sm" to="/settings#settings-sources">
              Manage source
            </SmartLink>
            <button class="btn btn-ghost btn-sm" type="button" @click="close">Close</button>
          </div>
        </template>
      </div>
    </div>
  </dialog>
</template>
