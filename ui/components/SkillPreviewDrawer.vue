<script setup lang="ts">
/**
 * Read-only preview of one managed skill, opened from the inventory.
 *
 * It reuses the existing detail endpoint (`GET /api/ui/skills/:id?from=...`) and the detail query
 * key so an edit cannot leave stale content behind. Mutations live on the detail workspace; this
 * sheet only shows identity, content, metadata, files, and links.
 */
import { useQuery } from "@tanstack/vue-query";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ApiError, apiQuery } from "../api.js";
import { absoluteTime, timeAgo } from "../format.js";
import type { SkillDetailResponse, SkillsInventoryRowProps } from "../skills-types.js";
import AppIcon from "./AppIcon.vue";
import SafeMarkdown from "./SafeMarkdown.vue";
import SmartLink from "./SmartLink.vue";

const props = defineProps<{
  open: boolean;
  row: SkillsInventoryRowProps | null;
  from: string;
}>();

const emit = defineEmits<{ close: [] }>();

interface PreviewFile {
  readonly path: string;
  readonly size: number;
  readonly executable?: boolean;
}

const dialogEl = ref<HTMLDialogElement | null>(null);
const lastFocused = ref<HTMLElement | null>(null);

const primaryId = computed<number | null>(() => props.row?.primaryId ?? null);

const detail = useQuery<SkillDetailResponse>({
  queryKey: computed(() => ["skills-detail", String(primaryId.value), props.from]),
  queryFn: () =>
    apiQuery<SkillDetailResponse>(
      `/api/ui/skills/${String(primaryId.value)}?from=${encodeURIComponent(props.from)}`,
    ),
  enabled: computed(() => props.open && primaryId.value !== null),
  staleTime: 0,
  refetchOnMount: "always",
  refetchOnWindowFocus: false,
  retry: false,
});

const view = computed<SkillDetailResponse | null>(() => detail.data.value ?? null);
const loading = computed(() => detail.isFetching.value && detail.data.value === undefined);
const failed = computed(() => detail.isError.value);
const failure = computed(() => {
  const error = detail.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load the skill.";
});

const name = computed(() => view.value?.values.name ?? props.row?.name ?? "Skill");
const description = computed(() => view.value?.values.description ?? props.row?.description ?? "");
const stateLabel = computed(() => view.value?.state.label ?? props.row?.stateLabel ?? "Skill");
const stateTone = computed(() => {
  const row = props.row;
  if (row !== null) {
    if (row.state === "enabled") return "badge-success";
    if (row.state === "disabled") return "badge-warning";
    if (row.state === "invalid") return "badge-error";
  }
  switch (view.value?.stateBadge.tone) {
    case "success":
      return "badge-success";
    case "warning":
      return "badge-warning";
    case "error":
      return "badge-error";
    case "info":
      return "badge-info";
    default:
      return "badge-ghost";
  }
});
const originLabel = computed(() => {
  const row = props.row;
  if (row === null) return "";
  if (row.mode === "external" && row.origin !== null) {
    return `${row.origin.sourceName} · ${row.origin.bucket} · ${row.origin.revision.slice(0, 7)}`;
  }
  const scope =
    row.originScope === "app"
      ? "Application"
      : row.originScope === "project"
        ? "Project"
        : "Global";
  return `${scope} · ${row.originText}`;
});
const resolutionLabel = computed(() => {
  const value = view.value;
  if (value === null) {
    return "";
  }
  return value.state.note;
});

const metadataEntries = computed<readonly (readonly [string, string])[]>(() => {
  const entries = view.value?.values.bundle.metadata ?? {};
  return Object.entries(entries);
});

const files = computed<readonly PreviewFile[]>(() => {
  const value = view.value;
  if (value === null) {
    return [];
  }
  const own = value.files ?? [];
  const seen = new Set(own.map((file) => file.path));
  // Pre-v24 rows have no files table; the reference projection is the only source. For current
  // rows, references that predate the files table are appended once, never duplicated.
  const legacy = value.values.bundle.references
    .filter((reference) => !seen.has(reference.path))
    .map((reference): PreviewFile => ({ path: reference.path, size: reference.size }));
  return [...own, ...legacy];
});

const updatedAt = computed(() => view.value?.row.updatedAt ?? props.row?.updatedAt ?? null);
const updatedBy = computed(() => view.value?.row.updatedBy ?? null);
const createdAt = computed(() => view.value?.row.createdAt ?? null);

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function when(iso: string | null): string {
  return iso === null ? "Unknown" : timeAgo(iso);
}

function whenTitle(iso: string | null): string | undefined {
  return iso === null ? undefined : absoluteTime(iso);
}

function close(): void {
  emit("close");
}

function onDialogClick(event: MouseEvent): void {
  if (event.target === dialogEl.value) {
    close();
  }
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && event.target === dialogEl.value) {
    event.preventDefault();
    close();
  }
}

function onNativeClose(): void {
  if (props.open) {
    close();
  }
}

async function syncOpenState(open: boolean): Promise<void> {
  const dialog = dialogEl.value;
  if (open) {
    lastFocused.value =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    if (dialog !== null && !dialog.open) {
      dialog.showModal();
    }
    if (primaryId.value !== null) {
      void detail.refetch();
    }
    return;
  }
  dialog?.close();
  const previous = lastFocused.value;
  lastFocused.value = null;
  await nextTick();
  previous?.focus();
}

watch(
  () => props.open,
  (open) => void syncOpenState(open),
);
onMounted(() => {
  if (props.open) {
    void syncOpenState(true);
  }
});
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog source-drawer skill-preview-drawer"
    aria-labelledby="skill-preview-drawer-title"
    @cancel.prevent="close"
    @keydown="onDialogKeydown"
    @close="onNativeClose"
    @click="onDialogClick"
  >
    <div class="dialog__frame source-drawer__frame skill-preview-drawer__frame">
      <header class="source-drawer__head">
        <div class="source-drawer__identity">
          <p class="source-drawer__overline">Skill preview</p>
          <h2 class="dialog__title" id="skill-preview-drawer-title">{{ name }}</h2>
          <p class="dialog__meta skill-preview-drawer__meta">
            <span class="badge" :class="stateTone">{{ stateLabel }}</span>
            <span v-if="originLabel.length > 0" class="small">{{ originLabel }}</span>
          </p>
        </div>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          aria-label="Close skill preview"
          @click="close"
        >
          <AppIcon name="x" />
        </button>
      </header>

      <div class="source-drawer__body skill-preview-drawer__body">
        <p v-if="description.length > 0" class="skill-preview-drawer__description">
          {{ description }}
        </p>

        <p class="source-drawer__banner">
          <AppIcon name="lock" />
          Read-only preview. Changes stay on the skill workspace.
        </p>

        <p v-if="loading" class="hint" role="status" aria-live="polite">Loading skill…</p>

        <div v-else-if="failed" class="error-state" role="alert">
          <div class="stack--tight">
            <p class="body">{{ failure }}</p>
            <button class="btn btn-secondary btn-sm" type="button" @click="detail.refetch()">
              <AppIcon name="refresh" />Retry
            </button>
          </div>
        </div>

        <template v-else-if="view !== null">
          <section class="source-drawer__section" aria-labelledby="skill-preview-content-title">
            <h3 class="source-drawer__subtitle" id="skill-preview-content-title">Content</h3>
            <SafeMarkdown
              class="prose skill-prose skill-preview-drawer__content"
              :text="view.values.content"
            />
            <details class="skill-source-disclosure">
              <summary>Source</summary>
              <pre class="skill-source-preview__text mono">{{ view.values.content }}</pre>
            </details>
          </section>

          <section class="source-drawer__section" aria-labelledby="skill-preview-meta-title">
            <h3 class="source-drawer__subtitle" id="skill-preview-meta-title">Metadata</h3>
            <dl class="skill-source-summary skill-preview-drawer__meta-grid">
              <div class="skill-source-summary__row">
                <dt>License</dt>
                <dd class="mono">{{ view.values.bundle.license ?? "—" }}</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Compatibility</dt>
                <dd class="mono">{{ view.values.bundle.compatibility ?? "—" }}</dd>
              </div>
              <div
                v-for="[ key, value ] in metadataEntries"
                :key="`meta-${key}`"
                class="skill-source-summary__row"
              >
                <dt class="mono">{{ key }}</dt>
                <dd>{{ value }}</dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Created</dt>
                <dd>
                  <time :datetime="createdAt ?? undefined" :title="whenTitle(createdAt)">
                    {{ when(createdAt) }}
                  </time>
                </dd>
              </div>
              <div class="skill-source-summary__row">
                <dt>Updated</dt>
                <dd>
                  <time :datetime="updatedAt ?? undefined" :title="whenTitle(updatedAt)">
                    {{ when(updatedAt)
                    }}<template v-if="updatedBy !== null"> · {{ updatedBy }}</template>
                  </time>
                </dd>
              </div>
              <div v-if="resolutionLabel.length > 0" class="skill-source-summary__row">
                <dt>Resolution</dt>
                <dd>{{ resolutionLabel }}</dd>
              </div>
            </dl>
          </section>

          <section class="source-drawer__section" aria-labelledby="skill-preview-files-title">
            <h3 class="source-drawer__subtitle" id="skill-preview-files-title">Files</h3>
            <ul v-if="files.length > 0" class="skill-source-file-list">
              <li v-for="file in files" :key="file.path">
                <span class="mono">{{ file.path }}</span>
                <span class="hint mono">{{ formatBytes(file.size) }}</span>
                <span v-if="file.executable === true" class="badge badge-sm">executable</span>
              </li>
            </ul>
            <p v-else class="hint">This skill has no files beyond the generated SKILL.md.</p>
          </section>

          <div class="cluster skill-preview-drawer__actions">
            <SmartLink
              v-if="row !== null && row.href !== null"
              class="btn btn-secondary btn-sm"
              :to="row.href"
            >
              Open full skill
            </SmartLink>
            <SmartLink
              v-if="row !== null && row.effectiveHref !== null"
              class="btn btn-ghost btn-sm"
              :to="row.effectiveHref"
              data-skill-effective-link
            >
              Open effective source
            </SmartLink>
            <button class="btn btn-ghost btn-sm" type="button" @click="close">Close</button>
          </div>
        </template>
      </div>
    </div>
  </dialog>
</template>
