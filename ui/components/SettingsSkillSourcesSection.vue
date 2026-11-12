<script setup lang="ts">
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import { absoluteTime, timeAgo } from "../format.js";
import type {
  CheckResult,
  SkillSourceAction,
  SkillSourceDialogPayload,
  SkillSourcesResponse,
  SkillSourceView,
  SyncResult,
} from "../skill-sources-types.js";
import { markSkillsMutated } from "../skills-mutation.js";
import type { PillSpec } from "../status.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import SkillSourceDeleteDialog from "./SkillSourceDeleteDialog.vue";
import SkillSourceDialog from "./SkillSourceDialog.vue";
import SkillSourceDrawer from "./SkillSourceDrawer.vue";
import SkillSourceTokenDialog from "./SkillSourceTokenDialog.vue";
import StatusPill from "./StatusPill.vue";

const props = withDefaults(defineProps<{ showIntro?: boolean }>(), { showIntro: true });
const queryClient = useQueryClient();
const toasts = useToastStore();

const query = useQuery<SkillSourcesResponse>({
  queryKey: ["skill-sources"],
  queryFn: () => apiQuery<SkillSourcesResponse>("/api/skill-sources"),
  retry: false,
  refetchOnWindowFocus: true,
});

const sources = computed<readonly SkillSourceView[]>(() => query.data.value?.sources ?? []);
const loading = computed(() => query.isPending.value && query.data.value === undefined);
const failed = computed(() => query.isError.value);
const failure = computed(() => {
  const error = query.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load skill sources.";
});

const busy = ref<string | null>(null);
const localSyncing = ref<ReadonlySet<string>>(new Set());
const unverified = ref<ReadonlySet<string>>(new Set());
const checkResults = ref<Record<string, CheckResult>>({});
const liveMessage = ref("");

const editorOpen = ref(false);
const editorTarget = ref<SkillSourceView | null>(null);
const tokenTarget = ref<{ source: SkillSourceView; mode: "replace" | "clear" } | null>(null);
const deleteTarget = ref<SkillSourceView | null>(null);
const disableTarget = ref<SkillSourceView | null>(null);
const forceTarget = ref<SkillSourceView | null>(null);
const drawerSource = ref<SkillSourceView | null>(null);

const drawerOpen = computed(() => drawerSource.value !== null);

function statusPill(value: SkillSourceView): PillSpec {
  if (localSyncing.value.has(value.id) || value.state === "syncing") {
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

interface PrimaryAction {
  readonly label: string;
  readonly kind: "sync" | "enable" | "review" | "unpin";
  readonly disabled: boolean;
}

function primaryAction(value: SkillSourceView): PrimaryAction {
  if (localSyncing.value.has(value.id) || value.state === "syncing") {
    return { label: "Sync now", kind: "sync", disabled: true };
  }
  if (value.state === "error") {
    return { label: "Retry sync", kind: "sync", disabled: false };
  }
  if (value.state === "disabled") {
    return { label: "Enable", kind: "enable", disabled: false };
  }
  if (unverified.value.has(value.id)) {
    return { label: "Sync now", kind: "sync", disabled: false };
  }
  if (value.state === "degraded") {
    return { label: "Review skills", kind: "review", disabled: false };
  }
  if (value.mode === "pinned" && value.state === "ready") {
    return { label: "Unpin", kind: "unpin", disabled: false };
  }
  return { label: "Sync now", kind: "sync", disabled: false };
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

function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function middleTruncate(value: string, maximum = 28): string {
  if (value.length <= maximum) {
    return value;
  }
  const keep = maximum - 1;
  const start = Math.ceil(keep / 2);
  const end = Math.floor(keep / 2);
  return `${value.slice(0, start)}…${value.slice(value.length - end)}`;
}

function shortRevision(revision: string | null): string {
  return revision === null ? "—" : revision.slice(0, 7);
}

function lastSuccessTitle(value: string | null): string | undefined {
  return value === null ? undefined : absoluteTime(value);
}

function setSyncing(id: string, syncing: boolean): void {
  const next = new Set(localSyncing.value);
  if (syncing) {
    next.add(id);
  } else {
    next.delete(id);
  }
  localSyncing.value = next;
}

function markUnverified(id: string, value: boolean): void {
  const next = new Set(unverified.value);
  if (value) {
    next.add(id);
  } else {
    next.delete(id);
  }
  unverified.value = next;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

async function invalidateSource(id: string | null): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ["skill-sources"] });
  if (id !== null) {
    await queryClient.invalidateQueries({ queryKey: ["skill-source-skills", id] });
  }
}

function invalidateSkills(): void {
  markSkillsMutated();
  void queryClient.invalidateQueries({ queryKey: ["skills-inventory"] });
}

class SyncTimeoutError extends Error {
  constructor() {
    super("sync timed out");
    this.name = "SyncTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SyncTimeoutError()), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function syncToast(result: SyncResult): string {
  if (!result.changed) {
    return "Already up to date";
  }
  return result.state === "degraded"
    ? "Synced with warnings."
    : `Synced ${result.skillCount} skills · ${formatBytes(result.totalBytes)}`;
}

async function syncSource(value: SkillSourceView, force = false): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  busy.value = `sync:${value.id}`;
  setSyncing(value.id, true);
  try {
    const response = await withTimeout(
      apiMutation<{ result: SyncResult }>(
        `/api/skill-sources/${encodeURIComponent(value.id)}/sync`,
        { json: force ? { force: true } : {} },
      ),
      Math.max(value.requestTimeoutMs, 1000) + 5000,
    );
    delete checkResults.value[value.id];
    markUnverified(value.id, false);
    if (response.result.changed) {
      invalidateSkills();
    }
    liveMessage.value = syncToast(response.result);
    toasts.push(liveMessage.value, "success");
    await invalidateSource(value.id);
  } catch (error) {
    if (error instanceof SyncTimeoutError) {
      await query.refetch().catch(() => undefined);
      await invalidateSource(value.id).catch(() => undefined);
      const message = "Sync is taking longer than expected. The source state was refreshed.";
      liveMessage.value = message;
      toasts.push(message, "error");
    } else {
      const message = failureMessage(error, "Could not sync the source.");
      liveMessage.value = message;
      toasts.push(message, "error");
      await invalidateSource(value.id).catch(() => undefined);
    }
  } finally {
    setSyncing(value.id, false);
    busy.value = null;
  }
}

async function checkSource(value: SkillSourceView): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  busy.value = `check:${value.id}`;
  try {
    const response = await apiMutation<{ result: CheckResult }>(
      `/api/skill-sources/${encodeURIComponent(value.id)}/check`,
      { json: {} },
    );
    checkResults.value = { ...checkResults.value, [value.id]: response.result };
    liveMessage.value = response.result.changed
      ? `Update available · ${response.result.revision}`
      : `Up to date · ${response.result.revision}`;
    await invalidateSource(value.id);
  } catch (error) {
    toasts.push(failureMessage(error, "Could not check for updates."), "error");
  } finally {
    busy.value = null;
  }
}

async function pinSource(value: SkillSourceView): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  const action = value.mode === "pinned" ? "unpin" : "pin";
  busy.value = `${action}:${value.id}`;
  try {
    await apiMutation(`/api/skill-sources/${encodeURIComponent(value.id)}/${action}`, {
      json: {},
    });
    const message =
      action === "pin"
        ? "Source pinned. Scheduled sync will check but will not publish changes."
        : "Source unpinned. The next sync will publish changes.";
    liveMessage.value = message;
    toasts.push(message, "success");
    await invalidateSource(value.id);
  } catch (error) {
    toasts.push(failureMessage(error, "Could not change the source pin."), "error");
  } finally {
    busy.value = null;
  }
}

async function enableSource(value: SkillSourceView): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  busy.value = `enable:${value.id}`;
  try {
    await apiMutation("/api/skill-sources", { json: { action: "enable", id: value.id } });
    liveMessage.value = "Source enabled. Syncing...";
    toasts.push(liveMessage.value, "success");
  } catch (error) {
    toasts.push(failureMessage(error, "Could not enable the source."), "error");
    busy.value = null;
    return;
  }
  busy.value = null;
  await invalidateSource(value.id);
  await syncSource(value);
}

async function confirmDisable(): Promise<void> {
  const value = disableTarget.value;
  if (value === null || busy.value !== null) {
    return;
  }
  busy.value = `disable:${value.id}`;
  try {
    await apiMutation("/api/skill-sources", { json: { action: "disable", id: value.id } });
    disableTarget.value = null;
    liveMessage.value = "Source disabled.";
    toasts.push(liveMessage.value, "success");
    await invalidateSource(value.id);
  } catch (error) {
    toasts.push(failureMessage(error, "Could not disable the source."), "error");
  } finally {
    busy.value = null;
  }
}

async function createSource(payload: SkillSourceDialogPayload): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  busy.value = "create";
  let created: SkillSourceView | null = null;
  try {
    const response = await apiMutation<{ source: SkillSourceView }>("/api/skill-sources", {
      json: {
        action: "create",
        name: payload.name,
        slug: payload.slug,
        endpoint: payload.endpoint,
        config: { buckets: payload.buckets, allowInsecureHttp: payload.allowInsecureHttp },
        priority: payload.priority,
        syncIntervalSec: payload.syncIntervalSec,
        staleAfterSec: payload.staleAfterSec,
        requestTimeoutMs: payload.requestTimeoutMs,
        ...(payload.token === null ? {} : { token: payload.token }),
      },
    });
    created = response.source;
    editorOpen.value = false;
    toasts.push("Source added. Syncing...", "success");
    await invalidateSource(created.id);
  } catch (error) {
    toasts.push(failureMessage(error, "Could not add the source."), "error");
  } finally {
    busy.value = null;
  }
  if (created !== null) {
    await syncSource(created);
  }
}

async function updateSource(payload: SkillSourceDialogPayload): Promise<void> {
  const value = editorTarget.value;
  if (value === null || busy.value !== null) {
    return;
  }
  busy.value = "edit";
  try {
    await apiMutation("/api/skill-sources", {
      json: {
        action: "update",
        id: value.id,
        name: payload.name,
        endpoint: payload.endpoint,
        config: { buckets: payload.buckets, allowInsecureHttp: payload.allowInsecureHttp },
        priority: payload.priority,
        syncIntervalSec: payload.syncIntervalSec,
        staleAfterSec: payload.staleAfterSec,
        requestTimeoutMs: payload.requestTimeoutMs,
      },
    });
    const endpointChanged = payload.endpoint !== value.endpoint;
    const bucketsChanged = payload.buckets.join(",") !== value.config.buckets.join(",");
    if (endpointChanged || bucketsChanged) {
      markUnverified(value.id, true);
    }
    editorOpen.value = false;
    toasts.push("Source updated.", "success");
    await invalidateSource(value.id);
  } catch (error) {
    toasts.push(failureMessage(error, "Could not update the source."), "error");
  } finally {
    busy.value = null;
  }
}

async function submitToken(token: string): Promise<void> {
  const target = tokenTarget.value;
  if (target === null || busy.value !== null) {
    return;
  }
  busy.value = "token";
  try {
    if (target.mode === "replace") {
      await apiMutation(`/api/skill-sources/${encodeURIComponent(target.source.id)}/secret`, {
        json: { token },
      });
      toasts.push("Token replaced.", "success");
    } else {
      await apiMutation(`/api/skill-sources/${encodeURIComponent(target.source.id)}/secret/clear`, {
        json: {},
      });
      toasts.push("Token cleared.", "success");
    }
    tokenTarget.value = null;
    await invalidateSource(target.source.id);
  } catch (error) {
    toasts.push(failureMessage(error, "Could not update the token."), "error");
  } finally {
    busy.value = null;
  }
}

async function confirmDelete(): Promise<void> {
  const value = deleteTarget.value;
  if (value === null || busy.value !== null) {
    return;
  }
  busy.value = "delete";
  try {
    await apiMutation(`/api/skill-sources/${encodeURIComponent(value.id)}/delete`, {
      json: { hard: true },
    });
    deleteTarget.value = null;
    if (drawerSource.value?.id === value.id) {
      drawerSource.value = null;
    }
    queryClient.removeQueries({ queryKey: ["skill-source-skills", value.id] });
    invalidateSkills();
    toasts.push("Source deleted.", "success");
    await invalidateSource(null);
  } catch (error) {
    toasts.push(failureMessage(error, "Could not delete the source."), "error");
  } finally {
    busy.value = null;
  }
}

async function confirmForceSync(): Promise<void> {
  const value = forceTarget.value;
  if (value === null || busy.value !== null) {
    return;
  }
  forceTarget.value = null;
  await syncSource(value, true);
}

function openEditor(value: SkillSourceView | null): void {
  editorTarget.value = value;
  editorOpen.value = true;
}

function openDrawer(value: SkillSourceView): void {
  drawerSource.value = value;
}

function onPrimary(value: SkillSourceView): void {
  const action = primaryAction(value);
  if (action.disabled || busy.value !== null) {
    return;
  }
  switch (action.kind) {
    case "enable":
      void enableSource(value);
      return;
    case "review":
      openDrawer(value);
      return;
    case "unpin":
      void pinSource(value);
      return;
    default:
      void syncSource(value);
  }
}

function onDrawerAction(action: SkillSourceAction, value: SkillSourceView): void {
  switch (action) {
    case "sync":
      void syncSource(value);
      return;
    case "check":
      void checkSource(value);
      return;
    case "pin":
    case "unpin":
      void pinSource(value);
      return;
    case "disable":
      disableTarget.value = value;
      return;
    case "enable":
      void enableSource(value);
      return;
    case "edit":
      openEditor(value);
      return;
    case "delete":
      deleteTarget.value = value;
      return;
    case "replace-token":
      tokenTarget.value = { source: value, mode: "replace" };
      return;
    case "clear-token":
      tokenTarget.value = { source: value, mode: "clear" };
      return;
  }
}

function checkedResult(value: SkillSourceView): CheckResult | undefined {
  return checkResults.value[value.id];
}

const disableDialog = ref<HTMLDialogElement | null>(null);
watch(disableTarget, (value) => {
  const dialog = disableDialog.value;
  if (dialog === null) {
    return;
  }
  if (value !== null && !dialog.open) {
    dialog.showModal();
  } else if (value === null && dialog.open) {
    dialog.close();
  }
});

const forceDialog = ref<HTMLDialogElement | null>(null);
watch(forceTarget, (value) => {
  const dialog = forceDialog.value;
  if (dialog === null) {
    return;
  }
  if (value !== null && !dialog.open) {
    dialog.showModal();
  } else if (value === null && dialog.open) {
    dialog.close();
  }
});
</script>

<template>
  <div class="skill-sources">
    <p class="sr-only" role="status" aria-live="polite">{{ liveMessage }}</p>

    <div
      class="skill-sources__toolbar"
      :class="{ 'skill-sources__toolbar--actions': !props.showIntro }"
    >
      <p v-if="props.showIntro" class="hint">
        Connect a skills-hub to bring external skills into every application. Local skills always
        win.
      </p>
      <button class="btn btn-primary btn-sm" type="button" @click="openEditor(null)">
        <AppIcon name="plus" />Add source
      </button>
    </div>

    <div v-if="loading" class="skeleton-stack skill-sources__skeleton" aria-hidden="true">
      <span class="skeleton skeleton--title"></span>
      <span class="skeleton"></span>
      <span class="skeleton skeleton--short"></span>
      <span class="skeleton"></span>
    </div>

    <div v-else-if="failed && sources.length === 0" class="error-state" role="alert">
      <span class="error-state__mark"><AppIcon name="alert-triangle" /></span>
      <div>
        <h3 class="error-state__title">Skill sources could not be loaded</h3>
        <p class="error-state__body">{{ failure }}</p>
        <button class="btn btn-secondary btn-sm" type="button" @click="query.refetch()">
          <AppIcon name="refresh" />Retry
        </button>
      </div>
    </div>

    <template v-else>
      <div v-if="failed" class="error-state" role="alert">
        <span class="error-state__mark"><AppIcon name="alert-triangle" /></span>
        <div>
          <h3 class="error-state__title">Could not refresh skill sources</h3>
          <p class="error-state__body">{{ failure }}</p>
          <button class="btn btn-secondary btn-sm" type="button" @click="query.refetch()">
            <AppIcon name="refresh" />Retry
          </button>
        </div>
      </div>

      <div v-if="sources.length === 0" class="empty-state">
        <div class="empty-state__icon"><AppIcon name="layers" /></div>
        <h3 class="empty-state__title">No skill sources</h3>
        <p class="empty-state__body">
          Connect a skills-hub to bring external skills into every application. Local skills always
          win.
        </p>
        <button class="btn btn-primary btn-sm" type="button" @click="openEditor(null)">
          <AppIcon name="plus" />Add source
        </button>
      </div>

      <div v-else class="table-wrap card skill-sources__ledger">
        <table class="table table--stack skill-source-table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Source</th>
              <th scope="col">Sync</th>
              <th scope="col">Revision</th>
              <th scope="col">Skills</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="source in sources" :key="source.id" :data-skill-source="source.slug">
              <td data-label="Status">
                <span class="skill-source-status">
                  <StatusPill :pill="statusPill(source)" />
                  <span v-if="source.stale" class="badge badge-warning">
                    <AppIcon name="hourglass" />Stale
                  </span>
                  <span v-if="source.mode === 'pinned'" class="badge">
                    <AppIcon name="lock" />Pinned
                  </span>
                  <span v-if="unverified.has(source.id)" class="badge badge-warning">
                    Not verified since change
                  </span>
                </span>
              </td>
              <td class="table__primary" data-label="Source">
                <button
                  class="link-button skill-source-name"
                  type="button"
                  @click="openDrawer(source)"
                >
                  {{ source.name }}
                </button>
                <p class="mono small">{{ source.slug }}</p>
                <p class="mono small skill-source-host" :title="source.endpoint">
                  {{ middleTruncate(hostOf(source.endpoint)) }}
                </p>
                <p v-if="source.lastErrorMessage !== null" class="field-error skill-source-error">
                  <AppIcon name="alert-triangle" />{{ source.lastErrorMessage }}
                </p>
                <p
                  v-if="checkedResult(source) !== undefined"
                  class="hint skill-source-check"
                  role="status"
                >
                  <template v-if="checkedResult(source)?.changed">
                    Update available ·
                    <span class="mono">{{ checkedResult(source)?.revision }}</span>
                    <button
                      class="btn btn-secondary btn-xs"
                      type="button"
                      :disabled="busy !== null"
                      @click="syncSource(source)"
                    >
                      Sync now
                    </button>
                  </template>
                  <template v-else>
                    Up to date · <span class="mono">{{ checkedResult(source)?.revision }}</span>
                  </template>
                </p>
              </td>
              <td data-label="Sync">
                <span v-if="source.lastSuccessAt === null" class="hint">Never synced</span>
                <time
                  v-else
                  :datetime="source.lastSuccessAt"
                  :title="lastSuccessTitle(source.lastSuccessAt)"
                >
                  {{ timeAgo(source.lastSuccessAt) }}
                  · {{ absoluteTime(source.lastSuccessAt) }}
                </time>
                <span class="hint"> · {{ formatInterval(source.syncIntervalSec) }}</span>
              </td>
              <td data-label="Revision">
                <span class="cluster">
                  <span class="mono">{{ shortRevision(source.revision) }}</span>
                  <AppIcon v-if="source.mode === 'pinned'" name="lock" />
                </span>
              </td>
              <td data-label="Skills">
                <span class="mono"
                  >{{ source.skillCount }}
                  · {{ formatBytes(source.totalBytes) }}</span
                >
              </td>
              <td class="table__actions">
                <div class="skill-source-actions">
                  <button
                    class="btn btn-secondary btn-sm"
                    type="button"
                    :disabled="primaryAction(source).disabled || busy !== null"
                    @click="onPrimary(source)"
                  >
                    <AppIcon name="refresh" />{{ primaryAction(source).label }}
                  </button>
                  <button class="btn btn-ghost btn-sm" type="button" @click="openDrawer(source)">
                    View skills
                  </button>
                  <details class="disclosure skill-source-menu">
                    <summary class="btn btn-ghost btn-sm skill-source-menu__summary">
                      Actions<AppIcon name="chevron-down" class-name="disclosure__chevron" />
                    </summary>
                    <div class="skill-source-menu__panel">
                      <button
                        class="skill-source-menu__item"
                        type="button"
                        :disabled="busy !== null"
                        @click="checkSource(source)"
                      >
                        Check for updates
                      </button>
                      <button
                        v-if="source.activeSnapshotId !== null"
                        class="skill-source-menu__item"
                        type="button"
                        :disabled="busy !== null"
                        @click="pinSource(source)"
                      >
                        {{ source.mode === "pinned" ? "Unpin" : "Pin" }}
                      </button>
                      <button
                        class="skill-source-menu__item"
                        type="button"
                        :disabled="busy !== null"
                        @click="source.enabled ? (disableTarget = source) : enableSource(source)"
                      >
                        {{ source.enabled ? "Disable" : "Enable" }}
                      </button>
                      <button
                        class="skill-source-menu__item"
                        type="button"
                        :disabled="busy !== null"
                        @click="openEditor(source)"
                      >
                        Edit
                      </button>
                      <button
                        v-if="source.lastErrorCode === 'deletion_guard'"
                        class="skill-source-menu__item"
                        type="button"
                        :disabled="busy !== null"
                        @click="forceTarget = source"
                      >
                        Force sync
                      </button>
                      <div class="skill-source-menu__rule"></div>
                      <button
                        class="skill-source-menu__item skill-source-menu__item--danger"
                        type="button"
                        :disabled="busy !== null"
                        @click="deleteTarget = source"
                      >
                        Delete
                      </button>
                    </div>
                  </details>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <SkillSourceDialog
      :open="editorOpen"
      :mode="editorTarget === null ? 'create' : 'edit'"
      :source="editorTarget"
      :busy="busy === 'create' || busy === 'edit'"
      @submit="editorTarget === null ? createSource($event) : updateSource($event)"
      @cancel="editorOpen = false"
    />

    <SkillSourceTokenDialog
      :open="tokenTarget !== null"
      :mode="tokenTarget?.mode ?? 'replace'"
      :source-name="tokenTarget?.source.name ?? ''"
      :busy="busy === 'token'"
      @submit="submitToken"
      @cancel="tokenTarget = null"
    />

    <SkillSourceDeleteDialog
      :open="deleteTarget !== null"
      :source="deleteTarget"
      :busy="busy === 'delete'"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />

    <SkillSourceDrawer
      :open="drawerOpen"
      :source-id="drawerSource?.id ?? null"
      :fallback-source="drawerSource"
      :busy="busy !== null"
      :syncing="drawerSource !== null && localSyncing.has(drawerSource.id)"
      @close="drawerSource = null"
      @action="onDrawerAction"
    />

    <dialog
      ref="disableDialog"
      class="dialog"
      aria-labelledby="skill-source-disable-title"
      @cancel.prevent="disableTarget = null"
    >
      <div class="dialog__frame">
        <form class="dialog__form" @submit.prevent="confirmDisable">
          <div class="dialog__head">
            <h2 class="dialog__title" id="skill-source-disable-title">Disable source?</h2>
            <p v-if="disableTarget !== null" class="dialog__meta mono">{{ disableTarget.name }}</p>
          </div>
          <div class="dialog__body">
            <p>
              Scheduled sync stops and its skills stop resolving for new launches. The cached
              snapshot is retained until cleanup; re-enabling will sync again.
            </p>
            <p v-if="disableTarget?.mode === 'pinned'" class="hint">
              Pinning is reset to tracking mode. Re-enabling will sync and may publish changes.
            </p>
          </div>
          <div class="dialog__foot">
            <button
              class="btn btn-ghost"
              type="button"
              :disabled="busy !== null"
              @click="disableTarget = null"
            >
              Cancel
            </button>
            <button class="btn btn-danger" type="submit" :disabled="busy !== null">Disable</button>
          </div>
        </form>
      </div>
    </dialog>

    <dialog
      ref="forceDialog"
      class="dialog"
      aria-labelledby="skill-source-force-title"
      @cancel.prevent="forceTarget = null"
    >
      <div class="dialog__frame">
        <form class="dialog__form" @submit.prevent="confirmForceSync">
          <div class="dialog__head">
            <h2 class="dialog__title" id="skill-source-force-title">Force sync?</h2>
            <p v-if="forceTarget !== null" class="dialog__meta mono">{{ forceTarget.name }}</p>
          </div>
          <div class="dialog__body">
            <p>
              The last sync was blocked by the deletion guard. A forced sync bypasses that guard and
              may publish a snapshot while a cleanup is pending.
            </p>
          </div>
          <div class="dialog__foot">
            <button
              class="btn btn-ghost"
              type="button"
              :disabled="busy !== null"
              @click="forceTarget = null"
            >
              Cancel
            </button>
            <button class="btn btn-danger" type="submit" :disabled="busy !== null">
              Force sync
            </button>
          </div>
        </form>
      </div>
    </dialog>
  </div>
</template>
