<script setup lang="ts">
import { computed } from "vue";
import type { AppImageLive, AppImageProps, AppImageState } from "../app-types.js";
import { absoluteTime } from "../format.js";
import type { PillSpec } from "../status.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  image: AppImageProps;
  live?: AppImageLive | null;
  liveError?: string | null;
}>();

interface ImageMeta {
  readonly label: string;
  readonly tone: string;
  readonly glyph: string;
  readonly hint: string;
}

const CUSTOM_STATES: Record<AppImageState, ImageMeta> = {
  default: {
    label: "Default image",
    tone: "cancelled",
    glyph: "layers",
    hint: "This application uses the shared default agent image.",
  },
  missing: {
    label: "Not built",
    tone: "queued",
    glyph: "clock",
    hint: "No app image has been built. Build it before starting the agent.",
  },
  building: {
    label: "Building",
    tone: "in_progress",
    glyph: "loader",
    hint: "The runner is building this image. The previous image remains in use.",
  },
  ready: {
    label: "Built",
    tone: "delivered",
    glyph: "check",
    hint: "The image matches the current Dockerfile and default base.",
  },
  stale: {
    label: "Out of date",
    tone: "expired",
    glyph: "hourglass",
    hint: "The Dockerfile or default base changed. The running agent keeps the old image until you rebuild and restart.",
  },
  error: {
    label: "Build failed",
    tone: "failed",
    glyph: "alert-triangle",
    hint: "The last build failed. The previous image is kept.",
  },
};

const BASE_KIND_LABELS: Record<string, string> = {
  default: "Default",
  base: "Base",
  explicit: "Explicit",
  unknown: "Unknown",
};

function configuredStatus(value: string | undefined): AppImageState {
  return value === "missing" ||
    value === "building" ||
    value === "ready" ||
    value === "stale" ||
    value === "error"
    ? value
    : "missing";
}

const view = computed(() => {
  const image = props.image;
  const live = props.live ?? null;

  if (!image.configured) {
    const liveState = live?.state;
    if (liveState === "current") {
      return {
        configured: false,
        status: "default" as const,
        label: "Current",
        tone: "delivered",
        glyph: "check",
        hint: "The agent runs the current default image.",
        ref: null,
        hash: null,
        builtAt: null,
        baseKindLabel: "Unknown",
        baseRef: null,
        baseDigest: null,
        drift: false,
        blocked: image.blocked,
        usable: false,
        rollbackAvailable: false,
        rollbackRef: null,
        rollbackBuiltAt: null,
        error: null,
        buildDisabled: image.buildDisabled,
        rollbackDisabled: image.rollbackDisabled,
      };
    }
    if (liveState === "restart_required") {
      return {
        configured: false,
        status: "default" as const,
        label: "Restart required",
        tone: "awaiting_approval",
        glyph: "refresh",
        hint: "Restart the agent to use the current default image.",
        ref: null,
        hash: null,
        builtAt: null,
        baseKindLabel: "Unknown",
        baseRef: null,
        baseDigest: null,
        drift: false,
        blocked: image.blocked,
        usable: false,
        rollbackAvailable: false,
        rollbackRef: null,
        rollbackBuiltAt: null,
        error: null,
        buildDisabled: image.buildDisabled,
        rollbackDisabled: image.rollbackDisabled,
      };
    }
    return {
      configured: false,
      status: "default" as const,
      label: image.label,
      tone: image.state,
      glyph: image.glyph,
      hint: image.hint,
      ref: null,
      hash: null,
      builtAt: null,
      baseKindLabel: "Unknown",
      baseRef: null,
      baseDigest: null,
      drift: false,
      blocked: image.blocked,
      usable: false,
      rollbackAvailable: false,
      rollbackRef: null,
      rollbackBuiltAt: null,
      error: null,
      buildDisabled: image.buildDisabled,
      rollbackDisabled: image.rollbackDisabled,
    };
  }

  const status = configuredStatus(live?.status ?? image.status);
  const meta = CUSTOM_STATES[status];
  const storedDigest = live?.baseDigest ?? image.base.digest;
  const currentDigest = live?.currentBaseDigest ?? null;
  const baseDigest =
    storedDigest !== null && currentDigest !== null && storedDigest !== currentDigest
      ? `${storedDigest} → ${currentDigest}`
      : (storedDigest ?? currentDigest);
  const baseKind = live?.baseKind ?? image.base.kind;
  return {
    configured: true,
    status,
    label: meta.label,
    tone: meta.tone,
    glyph: meta.glyph,
    hint: meta.hint,
    ref: live?.imageRef ?? image.ref,
    hash: live?.hash ?? image.hash,
    builtAt: live?.builtAt ?? image.builtAt,
    baseKindLabel: baseKind === null ? "Unknown" : (BASE_KIND_LABELS[baseKind] ?? "Unknown"),
    baseRef: live?.baseRef ?? image.base.ref,
    baseDigest,
    drift:
      live === null
        ? image.drift
        : live.baseDrift === true || live.hashDrift === true || status === "stale",
    blocked: live?.blocked ?? image.blocked,
    usable: live === null ? image.usable : live.usableImageRef != null,
    rollbackAvailable: live === null ? image.rollback.available : live.previousImageRef != null,
    rollbackRef: live?.previousImageRef ?? image.rollback.ref,
    rollbackBuiltAt: live?.previousImageBuiltAt ?? image.rollback.builtAt,
    error: live?.error ?? image.error,
    buildDisabled: image.buildDisabled || status === "building",
    rollbackDisabled: image.rollbackDisabled || status === "building",
  };
});

const pill = computed<PillSpec>(() => ({
  variant: "status",
  dataState: view.value.tone,
  icon: view.value.glyph,
  label: view.value.label,
}));

const refLabel = computed(() =>
  view.value.configured ? (view.value.ref ?? "Not built") : "Default agent image",
);
</script>

<template>
  <section class="card" id="image-panel" :data-status="view.status" aria-labelledby="image-title">
    <div class="card__head">
      <h2 class="card__title" id="image-title">Image</h2>
      <StatusPill :pill="pill" />
    </div>
    <div class="card__body stack--tight">
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {{ view.label }}. {{ view.error ?? view.hint }}
      </p>
      <p class="mono" id="image-ref">{{ refLabel }}</p>
      <p class="small" id="image-hint">{{ view.hint }}</p>
      <p v-if="view.configured && view.error !== null" class="field-error" role="alert">
        {{ view.error }}
      </p>
      <p v-if="!view.configured" class="small">
        Add .hanse/Dockerfile to build a custom image for this application.
      </p>
      <p v-if="liveError !== null && liveError !== undefined" class="hint">{{ liveError }}</p>

      <div v-if="view.configured" class="cluster">
        <span v-if="view.drift" class="badge badge--mono">Drift</span>
        <span v-if="view.blocked" class="badge">Blocked</span>
        <span class="badge badge--mono">{{ view.usable ? "Usable" : "No usable image" }}</span>
        <span class="badge badge--mono">
          {{ view.rollbackAvailable ? "Rollback available" : "No rollback" }}
        </span>
      </div>

      <details v-if="view.configured" class="disclosure" id="image-details">
        <summary>
          Image details<AppIcon name="chevron-down" class-name="disclosure__chevron" />
        </summary>
        <div class="stack--tight">
          <div class="summary-row">
            <span class="overline">Ref</span>
            <span class="mono">{{ view.ref ?? "Not built" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Hash</span>
            <span class="mono">{{ view.hash ?? "—" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Built</span>
            <span v-if="view.builtAt !== null">
              <time :datetime="view.builtAt" :title="absoluteTime(view.builtAt)">
                {{ absoluteTime(view.builtAt) }}
              </time>
            </span>
            <span v-else>Never</span>
          </div>
          <div class="summary-row">
            <span class="overline">Base</span>
            <span>{{ view.baseKindLabel }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Base ref</span>
            <span class="mono">{{ view.baseRef ?? "—" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Base digest</span>
            <span class="mono">{{ view.baseDigest ?? "—" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Drift</span>
            <span>{{ view.drift ? "Yes" : "No" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Blocked</span>
            <span>{{ view.blocked ? "Yes" : "No" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Usable</span>
            <span>{{ view.usable ? "Yes" : "No" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Build disabled</span>
            <span>{{ view.buildDisabled ? "Yes" : "No" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Rollback disabled</span>
            <span>{{ view.rollbackDisabled ? "Yes" : "No" }}</span>
          </div>
          <div class="summary-row">
            <span class="overline">Rollback</span>
            <span class="mono">{{ view.rollbackAvailable ? view.rollbackRef : "None" }}</span>
          </div>
          <div v-if="view.rollbackBuiltAt !== null" class="summary-row">
            <span class="overline">Previous built</span>
            <span>
              <time :datetime="view.rollbackBuiltAt" :title="absoluteTime(view.rollbackBuiltAt)">
                {{ absoluteTime(view.rollbackBuiltAt) }}
              </time>
            </span>
          </div>
        </div>
      </details>
    </div>
  </section>
</template>
