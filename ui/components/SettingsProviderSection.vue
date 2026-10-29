<script setup lang="ts">
import { ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { SettingsProps, SettingsProviderRowProps } from "../settings-types.js";
import type { PillSpec } from "../status.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import SettingsConfirmDialog from "./SettingsConfirmDialog.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{ settings: SettingsProps }>();
const emit = defineEmits<{ changed: [message: string] }>();
const toasts = useToastStore();

const busy = ref<string | null>(null);
const pendingClear = ref<{ provider: string } | null>(null);

function providerPill(row: SettingsProviderRowProps): PillSpec {
  switch (row.status.state) {
    case "set":
      return { variant: "status", dataState: "delivered", icon: "check", label: "Set" };
    case "cleared":
      return { variant: "status", dataState: "cancelled", icon: "slash", label: "Cleared" };
    case "host":
      return { variant: "status", dataState: "in_progress", icon: "lock", label: "Host auth" };
    case "error":
      return { variant: "status", dataState: "failed", icon: "alert-triangle", label: "Error" };
    default:
      return { variant: "status", dataState: "cancelled", icon: "slash", label: "Missing" };
  }
}

function targetBody(): Record<string, unknown> {
  const scope = props.settings.scope;
  return {
    scope: scope.scope,
    ...(scope.scope === "global" ? {} : { projectId: scope.projectId ?? "" }),
    ...(scope.scope === "app" ? { appKey: scope.appKey ?? "" } : {}),
  };
}

function keyFrom(form: HTMLFormElement): string {
  return form.querySelector<HTMLInputElement>('input[name="key"]')?.value ?? "";
}

function clearKey(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>('input[name="key"]');
  if (input !== null) {
    input.value = "";
  }
}

function failure(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

function formOf(event: Event): HTMLFormElement | null {
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }
  const form = target.closest("form");
  return form instanceof HTMLFormElement ? form : null;
}

async function submit(
  event: Event,
  provider: string,
  action: "set" | "inherit" | "clear",
): Promise<void> {
  const form = formOf(event);
  if (form === null || busy.value !== null) {
    return;
  }
  if (action === "set" && provider.trim().length === 0) {
    toasts.push("Provider is required.", "error");
    return;
  }
  const key = action === "set" ? keyFrom(form) : "";
  if (action === "set" && key.trim().length === 0) {
    toasts.push("API key is required.", "error");
    return;
  }
  busy.value = `${provider}:${action}`;
  try {
    await apiMutation("/api/settings/provider", {
      json: {
        ...targetBody(),
        provider: provider.trim(),
        action,
        ...(action === "set" ? { key } : {}),
      },
    });
    clearKey(form);
    emit("changed", "Provider key updated.");
  } catch (error) {
    toasts.push(failure(error, "Could not update the provider key."), "error");
  } finally {
    busy.value = null;
  }
}

async function addProvider(event: Event): Promise<void> {
  const form = formOf(event);
  if (form === null || busy.value !== null) {
    return;
  }
  const provider = form.querySelector<HTMLInputElement>('input[name="provider"]')?.value ?? "";
  const key = keyFrom(form);
  if (provider.trim().length === 0 || key.trim().length === 0) {
    toasts.push("Provider and API key are required.", "error");
    return;
  }
  busy.value = "add";
  try {
    await apiMutation("/api/settings/provider", {
      json: { ...targetBody(), provider: provider.trim(), action: "set", key },
    });
    clearKey(form);
    form.reset();
    emit("changed", "Provider key updated.");
  } catch (error) {
    toasts.push(failure(error, "Could not add the provider key."), "error");
  } finally {
    busy.value = null;
  }
}

function requestClear(row: SettingsProviderRowProps): void {
  pendingClear.value = { provider: row.provider };
}

async function confirmClear(): Promise<void> {
  const pending = pendingClear.value;
  if (pending === null || busy.value !== null) {
    return;
  }
  busy.value = `${pending.provider}:clear`;
  try {
    await apiMutation("/api/settings/provider", {
      json: { ...targetBody(), provider: pending.provider, action: "clear" },
    });
    pendingClear.value = null;
    emit("changed", "Provider key updated.");
  } catch (error) {
    toasts.push(failure(error, "Could not clear the provider key."), "error");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section class="providers" id="providers" aria-labelledby="providers-title">
    <div class="providers__head">
      <h3 class="card__title" id="providers-title">{{ settings.labels.providers.title }}</h3>
      <span class="badge">
        {{ settings.providers.length }}
        {{ settings.providers.length === 1 ? "provider" : "providers" }}
      </span>
    </div>
    <p class="hint providers__hint">{{ settings.labels.providers.hint }}</p>

    <p v-if="settings.providers.length === 0" class="hint">
      {{ settings.labels.providers.empty }}
    </p>
    <details
      v-for="row in settings.providers"
      :key="row.provider"
      class="setting-row"
      :id="row.rowId"
    >
      <summary class="setting-row__summary">
        <span class="setting-row__title">
          {{ row.provider }}
          <span class="setting-row__affordance">{{ settings.labels.providers.changeKey }}</span>
        </span>
        <span class="setting-row__effective">
          <span class="mono">{{ row.effectiveText }}</span>
          <span class="setting-row__source">{{ row.sourceLine }}</span>
        </span>
        <span class="setting-row__state"><StatusPill :pill="providerPill(row)" /></span>
        <span class="setting-row__chevron"><AppIcon name="chevron-down" /></span>
      </summary>
      <div class="setting-row__body">
        <p v-if="row.warning !== null" class="field-error" role="alert">
          <AppIcon name="alert-triangle" />{{ row.warning }}
        </p>
        <p class="hint">Key: <span class="mono">{{ row.masked }}</span></p>
        <form class="setting-row__form" @submit.prevent="submit($event, row.provider, 'set')">
          <div class="field">
            <label class="label" :for="`provider-key-${row.provider}`">
              {{ settings.labels.providers.keyLabel }}
            </label>
            <input
              :id="`provider-key-${row.provider}`"
              class="input"
              name="key"
              type="password"
              autocomplete="new-password"
              :placeholder="row.masked"
              required
            >
          </div>
          <div class="setting-row__actions">
            <button class="btn btn-primary btn-sm" type="submit" :disabled="busy !== null">
              {{ settings.labels.actions.save }}
            </button>
            <button
              v-if="row.actions.inherit !== null"
              class="btn btn-secondary btn-sm"
              type="button"
              :disabled="busy !== null || !row.actions.inherit.enabled"
              @click="submit($event, row.provider, 'inherit')"
            >
              {{ settings.labels.actions.inherit }}
            </button>
            <button
              v-if="row.actions.clear !== null"
              class="btn btn-danger btn-sm"
              type="button"
              :disabled="busy !== null || !row.actions.clear.enabled"
              @click="requestClear(row)"
            >
              {{ settings.labels.actions.clear }}
            </button>
          </div>
          <p v-if="row.actions.inherit?.reason" class="hint setting-row__reason">
            {{ row.actions.inherit.reason }}
          </p>
          <p v-if="row.actions.clear?.reason" class="hint setting-row__reason">
            {{ row.actions.clear.reason }}
          </p>
        </form>
      </div>
    </details>

    <details class="disclosure provider-add">
      <summary>
        Add provider key<AppIcon name="chevron-down" class-name="disclosure__chevron" />
      </summary>
      <form class="setting-row__form provider-add__form" @submit.prevent="addProvider">
        <div class="field">
          <label class="label" for="provider-new">
            {{ settings.labels.providers.providerLabel }}
          </label>
          <input
            id="provider-new"
            class="input"
            name="provider"
            type="text"
            :placeholder="settings.labels.providers.providerPlaceholder"
            required
            autocomplete="off"
          >
        </div>
        <div class="field">
          <label class="label" for="provider-new-key">
            {{ settings.labels.providers.keyLabel }}
          </label>
          <input
            id="provider-new-key"
            class="input"
            name="key"
            type="password"
            autocomplete="new-password"
            required
          >
        </div>
        <div class="setting-row__actions">
          <button class="btn btn-primary btn-sm" type="submit" :disabled="busy !== null">
            {{ settings.labels.actions.save }}
          </button>
        </div>
      </form>
    </details>
  </section>

  <SettingsConfirmDialog
    :open="pendingClear !== null"
    :title="settings.labels.actions.clearTitle"
    :body="pendingClear !== null ? `Clear the ${pendingClear.provider} key at this scope?` : ''"
    :submit-label="settings.labels.actions.clearConfirm"
    :busy="busy !== null"
    @confirm="confirmClear"
    @cancel="pendingClear = null"
  />
</template>
