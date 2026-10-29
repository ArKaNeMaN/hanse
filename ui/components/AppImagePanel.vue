<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { AppImageLive, AppImageProps, AppImageState } from "../app-types.js";
import type { AppImageAction } from "../composables/useAppImage.js";
import { absoluteTime } from "../format.js";
import type { PillSpec } from "../status.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  image: AppImageProps;
  live?: AppImageLive | null;
  liveError?: string | null;
  logs?: string;
  logsError?: string | null;
  logsOpen?: boolean;
  busyAction?: AppImageAction | null;
  runtimeActive?: boolean;
  runtimeImageRef?: string | null;
  ideHref?: string;
}>();

const emit = defineEmits<{
  build: [];
  rollback: [];
  check: [];
  refresh: [];
  refreshLogs: [];
  "update:logsOpen": [value: boolean];
}>();

type DerivedState =
  | "default"
  | "current"
  | "restart_required"
  | "rebuild_required"
  | "building"
  | "build_error"
  | "not_ready"
  | "unknown";

interface ImageMeta {
  readonly label: string;
  readonly tone: string;
  readonly glyph: string;
  readonly hint: string;
  readonly action?: string;
}

const DERIVED_STATES = new Set<DerivedState>([
  "current",
  "restart_required",
  "rebuild_required",
  "building",
  "build_error",
  "not_ready",
  "unknown",
]);
const BUILD_STATES = new Set<DerivedState>([
  "building",
  "build_error",
  "not_ready",
  "rebuild_required",
]);
const RAW_STATE: Record<AppImageState, DerivedState> = {
  default: "unknown",
  missing: "not_ready",
  building: "building",
  ready: "current",
  stale: "rebuild_required",
  error: "build_error",
};

const CUSTOM_STATES: Record<DerivedState, ImageMeta> = {
  default: {
    label: "Default image",
    tone: "cancelled",
    glyph: "layers",
    hint: "This application uses the shared default agent image.",
  },
  current: {
    label: "Built",
    tone: "delivered",
    glyph: "check",
    action: "Rebuild image",
    hint: "The image matches the current Dockerfile and base.",
  },
  restart_required: {
    label: "Restart required",
    tone: "awaiting_approval",
    glyph: "refresh",
    action: "Rebuild image",
    hint: "The running agent uses the previous image. Restart it to use the new image.",
  },
  rebuild_required: {
    label: "Out of date",
    tone: "expired",
    glyph: "hourglass",
    action: "Rebuild image",
    hint: "The base image or Dockerfile changed. Rebuild and restart the running agent to use the new image.",
  },
  building: {
    label: "Building",
    tone: "in_progress",
    glyph: "loader",
    action: "Building…",
    hint: "The runner is building this image. The previous image remains in use.",
  },
  build_error: {
    label: "Build failed",
    tone: "failed",
    glyph: "alert-triangle",
    action: "Retry build",
    hint: "The last build failed. The previous image is kept.",
  },
  not_ready: {
    label: "Not built",
    tone: "queued",
    glyph: "clock",
    action: "Build image",
    hint: "No app image has been built. Build it before starting the agent.",
  },
  unknown: {
    label: "Unknown",
    tone: "queued",
    glyph: "clock",
    action: "Rebuild image",
    hint: "The image identity could not be confirmed. Refresh to try again.",
  },
};

const DEFAULT_STATES: Partial<Record<DerivedState, ImageMeta>> = {
  current: {
    label: "Current",
    tone: "delivered",
    glyph: "check",
    hint: "The agent runs the current default image.",
  },
  restart_required: {
    label: "Restart required",
    tone: "awaiting_approval",
    glyph: "refresh",
    hint: "Restart the agent to use the current default image.",
  },
  unknown: {
    label: "Unknown",
    tone: "queued",
    glyph: "clock",
    hint: "The default image identity could not be confirmed. Refresh to try again.",
  },
};

const BASE_KIND_LABELS: Record<string, string> = {
  default: "Default",
  base: "Base",
  explicit: "Explicit",
  unknown: "Unknown",
};

const configured = computed(() => props.image.configured);

function pick<T>(liveValue: T | undefined, fallback: T): T {
  return liveValue !== undefined ? liveValue : fallback;
}
const logsOpenModel = computed({
  get: () => props.logsOpen === true,
  set: (value: boolean) => emit("update:logsOpen", value),
});

const state = computed<DerivedState>(() => {
  const rawStatus = props.live?.status ?? props.image.status;
  if (props.live !== null && props.live !== undefined) {
    const liveState = props.live.state;
    if (typeof liveState === "string" && DERIVED_STATES.has(liveState as DerivedState)) {
      return liveState as DerivedState;
    }
    return RAW_STATE[rawStatus as AppImageState] ?? "unknown";
  }
  if (!configured.value) {
    return "unknown";
  }
  return RAW_STATE[rawStatus as AppImageState] ?? "unknown";
});

const meta = computed<ImageMeta>(() => {
  const current = state.value;
  if (!configured.value) {
    if (props.live === null || props.live === undefined) {
      return {
        label: props.image.label,
        tone: props.image.state,
        glyph: props.image.glyph,
        hint: props.image.hint,
      };
    }
    const safe = BUILD_STATES.has(current) ? "unknown" : current;
    return DEFAULT_STATES[safe] ?? DEFAULT_STATES.unknown ?? CUSTOM_STATES.unknown;
  }
  return CUSTOM_STATES[current] ?? CUSTOM_STATES.unknown;
});

const status = computed(() =>
  configured.value ? pick(props.live?.status, props.image.status) : "default",
);
const imageRef = computed(() =>
  configured.value ? pick(props.live?.imageRef, props.image.ref) : null,
);
const hash = computed(() => pick(props.live?.hash, props.image.hash));
const builtAt = computed(() => pick(props.live?.builtAt, props.image.builtAt));
const baseKind = computed(() => pick(props.live?.baseKind, props.image.base.kind));
const baseRef = computed(() => pick(props.live?.baseRef, props.image.base.ref));
const baseDigest = computed(() => {
  const stored = pick(props.live?.baseDigest, props.image.base.digest);
  const current = props.live?.currentBaseDigest ?? null;
  return stored !== null && current !== null && stored !== current
    ? `${stored} → ${current}`
    : (stored ?? current);
});
const blocked = computed(() => pick(props.live?.blocked, props.image.blocked));
const usable = computed(() =>
  props.live !== null && props.live !== undefined && props.live.usableImageRef !== undefined
    ? props.live.usableImageRef != null
    : props.image.usable,
);
const drift = computed(() => {
  if (props.live === null || props.live === undefined) return props.image.drift;
  return (
    pick(props.live.baseDrift, false) === true ||
    pick(props.live.hashDrift, false) === true ||
    state.value === "rebuild_required"
  );
});
const imageError = computed(() =>
  configured.value ? pick(props.live?.error, props.image.error) : null,
);
const rollbackAvailable = computed(() =>
  props.live !== null && props.live !== undefined && props.live.previousImageRef !== undefined
    ? props.live.previousImageRef != null
    : props.image.rollback.available,
);
const rollbackRef = computed(() => pick(props.live?.previousImageRef, props.image.rollback.ref));
const rollbackBuiltAt = computed(() =>
  pick(props.live?.previousImageBuiltAt, props.image.rollback.builtAt),
);
const runtimeActive = computed(() => props.runtimeActive === true || props.image.rollback.restart);
const rollbackLabel = computed(() =>
  runtimeActive.value ? "Roll back and restart" : "Roll back image",
);
const isBuilding = computed(() => state.value === "building");
const busy = computed(() => props.busyAction ?? null);
const buildLabel = computed(() => {
  if (busy.value === "build" && !isBuilding.value) return "Starting build…";
  return meta.value.action ?? "Rebuild image";
});
const buildDisabled = computed(
  () => !configured.value || blocked.value || isBuilding.value || busy.value !== null,
);
const rollbackDisabled = computed(
  () => blocked.value || isBuilding.value || busy.value !== null || !rollbackAvailable.value,
);
const checkDisabled = computed(() => blocked.value || busy.value !== null);
const restartNotice = computed(
  () =>
    runtimeActive.value &&
    imageRef.value !== null &&
    props.runtimeImageRef !== null &&
    props.runtimeImageRef !== undefined &&
    props.runtimeImageRef.length > 0 &&
    props.runtimeImageRef !== imageRef.value,
);

const pill = computed<PillSpec>(() => ({
  variant: "status",
  dataState: meta.value.tone,
  icon: meta.value.glyph,
  label: meta.value.label,
}));

const refLabel = computed(() =>
  configured.value ? (imageRef.value ?? "Not built") : "Default agent image",
);

const logsDetails = ref<HTMLDetailsElement | null>(null);
const rollbackDialog = ref<HTMLDialogElement | null>(null);

function emitBuild(): void {
  emit("build");
}

function emitRefresh(): void {
  emit("refresh");
  if (logsDetails.value?.open === true) emit("refreshLogs");
}

function emitCheck(): void {
  emit("check");
}

function openRollback(): void {
  const dialog = rollbackDialog.value;
  if (dialog !== null && !dialog.open) {
    dialog.showModal();
  }
}

function confirmRollback(): void {
  rollbackDialog.value?.close();
  emit("rollback");
}

function onLogsToggle(): void {
  const open = logsDetails.value?.open === true;
  if (open !== logsOpenModel.value) {
    logsOpenModel.value = open;
  }
  if (open) emit("refreshLogs");
}

function openLogs(): void {
  if (logsDetails.value !== null && !logsDetails.value.open) {
    logsDetails.value.open = true;
    logsOpenModel.value = true;
  }
}

watch(
  isBuilding,
  (value) => {
    if (value) openLogs();
  },
  { flush: "post" },
);

watch(
  () => props.logsOpen,
  (value) => {
    const details = logsDetails.value;
    if (details !== null && details.open !== (value === true)) {
      details.open = value === true;
    }
  },
  { flush: "post" },
);

onMounted(() => {
  if (isBuilding.value) openLogs();
});
</script>

<template>
  <section class="card" id="image-panel" :data-status="status" aria-labelledby="image-title">
    <div class="card__head">
      <h2 class="card__title" id="image-title">Image</h2>
      <div class="cluster">
        <StatusPill id="image-status" :pill="pill" />
        <button
          v-if="configured"
          class="btn btn-ghost btn-icon btn-sm"
          id="image-refresh"
          type="button"
          aria-label="Refresh image status"
          title="Refresh image status"
          :disabled="busy !== null"
          @click="emitRefresh"
        >
          <AppIcon name="refresh" />
        </button>
      </div>
    </div>
    <div class="card__body stack--tight">
      <p class="sr-only" id="image-live" role="status" aria-live="polite" aria-atomic="true">
        {{ meta.label }}. {{ imageError ?? meta.hint }}
      </p>
      <div v-if="configured" class="cluster">
        <button
          class="btn btn-secondary btn-sm"
          id="image-build"
          type="button"
          :data-action-label="buildLabel"
          :disabled="buildDisabled"
          :aria-busy="busy === 'build' || isBuilding ? 'true' : undefined"
          @click="emitBuild"
        >
          <AppIcon name="layers" /><span class="btn__label">{{ buildLabel }}</span>
        </button>
      </div>
      <p class="mono" id="image-ref">{{ refLabel }}</p>
      <p class="small" id="image-hint">{{ meta.hint }}</p>
      <p v-if="restartNotice" class="small" id="image-notice">
        Restart the agent to use the new image.
      </p>
      <p v-if="!configured" class="small">
        Add .hanse/Dockerfile to build a custom image for this application.
      </p>
      <p v-if="imageError !== null" class="field-error" id="image-error" role="alert">
        {{ imageError }}
      </p>
      <p v-if="blocked" class="hint" id="image-blocked-reason">
        Image actions are disabled while deletion is pending.
      </p>
      <p v-if="liveError !== null && liveError !== undefined" class="hint">{{ liveError }}</p>

      <div v-if="configured" class="cluster">
        <span v-if="drift" class="badge badge--mono">Drift</span>
        <span v-if="blocked" class="badge">Blocked</span>
        <span class="badge badge--mono">{{ usable ? "Usable" : "No usable image" }}</span>
        <span class="badge badge--mono">
          {{ rollbackAvailable ? "Rollback available" : "No rollback" }}
        </span>
      </div>

      <div v-if="!configured" class="cluster">
        <button
          class="btn btn-secondary btn-sm"
          id="image-check"
          type="button"
          :disabled="checkDisabled"
          :aria-busy="busy === 'check' ? 'true' : undefined"
          @click="emitCheck"
        >
          <AppIcon name="refresh" />
          <span class="btn__label">
            {{ busy === "check" ? "Checking…" : "Check for changes" }}
          </span>
        </button>
        <a
          v-if="ideHref !== undefined && ideHref.length > 0"
          class="btn btn-ghost btn-sm"
          :href="ideHref"
          target="_blank"
          rel="noreferrer"
        >
          <AppIcon name="external" />Open application folder
        </a>
      </div>

      <details v-if="configured" class="disclosure" id="image-details">
        <summary>
          Image details<AppIcon name="chevron-down" class-name="disclosure__chevron" />
        </summary>
        <div class="stack--tight">
          <div class="summary-row">
            <span class="overline">Ref</span>
            <span class="mono">{{ imageRef ?? "Not built" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Hash</span>
            <span class="mono">{{ hash ?? "—" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Built</span>
            <span v-if="builtAt !== null">
              <time :datetime="builtAt" :title="absoluteTime(builtAt)">
                {{ absoluteTime(builtAt) }}
              </time>
            </span>
            <span v-else>Never</span>
          </div>
          <div class="summary-row">
            <span class="overline">Base</span>
            <span>{{
              baseKind === null ? "Unknown" : (BASE_KIND_LABELS[baseKind] ?? "Unknown")
            }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Base ref</span>
            <span class="mono">{{ baseRef ?? "—" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Base digest</span>
            <span class="mono">{{ baseDigest ?? "—" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Drift</span>
            <span>{{ drift ? "Yes" : "No" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Blocked</span>
            <span>{{ blocked ? "Yes" : "No" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Usable</span>
            <span>{{ usable ? "Yes" : "No" }}</span>
          </div>
          <div v-if="rollbackAvailable" class="summary-row">
            <span class="overline">Previous</span>
            <span class="mono">{{ rollbackRef }}</span>
          </div>
          <div v-if="rollbackAvailable && rollbackBuiltAt !== null" class="summary-row">
            <span class="overline">Previous built</span>
            <span>
              <time :datetime="rollbackBuiltAt" :title="absoluteTime(rollbackBuiltAt)">
                {{ absoluteTime(rollbackBuiltAt) }}
              </time>
            </span>
          </div>
          <div v-if="rollbackAvailable" class="cluster">
            <button
              class="btn btn-secondary btn-sm"
              id="image-rollback"
              type="button"
              :disabled="rollbackDisabled"
              :aria-busy="busy === 'rollback' ? 'true' : undefined"
              @click="openRollback"
            >
              <AppIcon name="refresh" />
              <span class="btn__label">
                {{ busy === "rollback" ? "Rolling back…" : rollbackLabel }}
              </span>
            </button>
          </div>
          <details
            ref="logsDetails"
            class="disclosure"
            id="image-logs-details"
            @toggle="onLogsToggle"
          >
            <summary>
              Build logs<AppIcon name="chevron-down" class-name="disclosure__chevron" />
            </summary>
            <pre class="mono image-logs" id="image-logs">{{ logs || "No build logs yet." }}</pre>
            <p v-if="logsError !== null && logsError !== undefined" class="hint">{{ logsError }}</p>
          </details>
        </div>
      </details>
    </div>

    <dialog
      ref="rollbackDialog"
      class="dialog"
      id="image-rollback-dialog"
      aria-labelledby="image-rollback-dialog-title"
    >
      <div class="dialog__frame">
        <header class="dialog__head">
          <h2 class="dialog__title" id="image-rollback-dialog-title">Roll back image?</h2>
        </header>
        <div class="dialog__body">
          <p class="body">
            This replaces the current image with
            <span class="mono" id="image-rollback-dialog-ref">{{
              rollbackRef ?? "no previous image"
            }}</span
            >.
            <template v-if="runtimeActive"> An active turn will be interrupted.</template>
          </p>
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" @click="rollbackDialog?.close()">
            Cancel
          </button>
          <button
            class="btn btn-primary"
            type="button"
            id="image-rollback-confirm"
            :disabled="rollbackDisabled"
            @click="confirmRollback"
          >
            <AppIcon name="refresh" />{{ rollbackLabel }}
          </button>
        </footer>
      </div>
    </dialog>
  </section>
</template>
