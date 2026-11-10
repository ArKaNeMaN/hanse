<script setup lang="ts">
import { computed, ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type {
  SettingsProps,
  SettingsRowProps,
  SettingsTelegramSecretProps,
} from "../settings-types.js";
import type { PillSpec } from "../status.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import SettingsConfirmDialog from "./SettingsConfirmDialog.vue";
import SettingsRow from "./SettingsRow.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{ settings: SettingsProps }>();
const emit = defineEmits<{ changed: [message: string]; dirty: [row: SettingsRowProps] }>();
const toasts = useToastStore();

type PendingClear =
  | { readonly kind: "row"; readonly row: SettingsRowProps }
  | { readonly kind: "secret"; readonly secret: SettingsTelegramSecretProps };

const busy = ref<string | null>(null);
const pendingClear = ref<PendingClear | null>(null);

function rows(): readonly SettingsRowProps[] {
  const notifications = props.settings.notifications;
  return [
    notifications.rows.mode,
    notifications.rows.telegramEnabled,
    notifications.rows.chatId,
    notifications.rows.publicBaseUrl,
    notifications.rows.apiBaseUrl,
    notifications.rows.includeAnswer,
  ];
}

function secrets(): readonly SettingsTelegramSecretProps[] {
  return [
    props.settings.notifications.secrets.botToken,
    props.settings.notifications.secrets.proxyUrl,
  ];
}

function secretPill(secret: SettingsTelegramSecretProps): PillSpec {
  switch (secret.status.state) {
    case "set":
      return { variant: "status", dataState: "delivered", icon: "check", label: "Set" };
    case "cleared":
      return { variant: "status", dataState: "cancelled", icon: "slash", label: "Cleared" };
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

function secretValue(form: HTMLFormElement): string {
  return form.querySelector<HTMLInputElement>('input[name="value"]')?.value ?? "";
}

function clearSecretValue(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>('input[name="value"]');
  if (input !== null) {
    input.value = "";
  }
}

/**
 * `SettingsRow` treats every `select` control as a boolean toggle, but `notifications.mode` is a
 * three-way enum (`off | attention | all`). Intercept only the mode row's submit here and map its
 * select value to the enum; every other row keeps `SettingsRow`'s native behavior.
 */
function onCaptureSubmit(event: Event): void {
  const form = formOf(event);
  if (form === null) {
    return;
  }
  const rowEl = form.closest(".setting-row");
  if (!(rowEl instanceof HTMLElement) || rowEl.id !== props.settings.notifications.rows.mode.id) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const value = form.querySelector<HTMLSelectElement>('select[name="value"]')?.value ?? "";
  if (value !== "off" && value !== "attention" && value !== "all") {
    toasts.push("Choose a notification mode.", "error");
    return;
  }
  void mutateRow(props.settings.notifications.rows.mode, "set", value);
}

async function mutateRow(
  row: SettingsRowProps,
  action: "set" | "inherit" | "clear",
  value?: unknown,
): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  busy.value = `row:${row.key}`;
  try {
    await apiMutation(row.form.action, {
      json: { ...targetBody(), key: row.key, action, ...(action === "set" ? { value } : {}) },
    });
    emit("changed", action === "clear" ? "Setting cleared." : row.form.successNotice);
  } catch (error) {
    toasts.push(failure(error, "Could not save the setting."), "error");
  } finally {
    busy.value = null;
  }
}

async function mutateSecret(
  secret: SettingsTelegramSecretProps,
  action: "set" | "inherit" | "clear",
  value?: string,
): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  busy.value = `secret:${secret.field}:${action}`;
  try {
    await apiMutation(secret.form.action, {
      json: {
        ...targetBody(),
        field: secret.field,
        action,
        ...(action === "set" ? { value: value ?? "" } : {}),
      },
    });
    emit("changed", "Telegram secret updated.");
  } catch (error) {
    toasts.push(failure(error, "Could not update the Telegram secret."), "error");
  } finally {
    busy.value = null;
  }
}

async function submitSecret(
  event: Event,
  secret: SettingsTelegramSecretProps,
  action: "set" | "inherit",
): Promise<void> {
  const form = formOf(event);
  if (form === null || busy.value !== null) {
    return;
  }
  if (action === "set") {
    const value = secretValue(form);
    if (value.trim().length === 0) {
      toasts.push(`${secret.label} is required.`, "error");
      return;
    }
    await mutateSecret(secret, "set", value);
    clearSecretValue(form);
    return;
  }
  await mutateSecret(secret, "inherit");
}

async function sendTest(): Promise<void> {
  if (busy.value !== null) {
    return;
  }
  busy.value = "test";
  try {
    await apiMutation(props.settings.notifications.test.action, { json: targetBody() });
    toasts.push("Test message sent.", "success");
  } catch (error) {
    toasts.push(failure(error, "Telegram test failed."), "error");
  } finally {
    busy.value = null;
  }
}

async function confirmClear(): Promise<void> {
  const pending = pendingClear.value;
  if (pending === null || busy.value !== null) {
    return;
  }
  if (pending.kind === "row") {
    await mutateRow(pending.row, "clear");
  } else {
    await mutateSecret(pending.secret, "clear");
  }
  pendingClear.value = null;
}

const dialogBody = computed<string>(() => {
  const pending = pendingClear.value;
  if (pending === null) {
    return "";
  }
  return pending.kind === "row"
    ? props.settings.labels.actions.clearBody
    : `Clear the ${pending.secret.label} at this scope?`;
});
</script>

<template>
  <div class="stack--tight" @submit.capture="onCaptureSubmit">
    <p class="hint">{{ settings.labels.notifications.hint }}</p>

    <div
      v-if="settings.notifications.warning !== null"
      class="settings-warning"
      role="alert"
      aria-labelledby="settings-notifications-warning-title"
    >
      <p class="settings-warning__title" id="settings-notifications-warning-title">
        <AppIcon name="alert-triangle" />Warning
      </p>
      <p class="hint">{{ settings.notifications.warning }}</p>
    </div>

    <SettingsRow
      v-for="row in rows()"
      :key="row.key"
      :row="row"
      :busy="busy !== null"
      :save-label="settings.labels.actions.save"
      :inherit-label="settings.labels.actions.inherit"
      :clear-label="settings.labels.actions.clear"
      @set="(target, value) => mutateRow(target, 'set', value)"
      @inherit="mutateRow($event, 'inherit')"
      @clear="pendingClear = { kind: 'row', row: $event }"
      @dirty="emit('dirty', $event)"
    />

    <p class="hint">{{ settings.labels.notifications.secretHint }}</p>

    <details
      v-for="secret in secrets()"
      :key="secret.field"
      class="setting-row"
      :id="`telegram-${secret.field}`"
    >
      <summary class="setting-row__summary">
        <span class="setting-row__title">
          {{ secret.label }}
          <span class="setting-row__affordance">{{ settings.labels.providers.changeKey }}</span>
        </span>
        <span class="setting-row__effective">
          <span class="mono">{{ secret.effectiveText }}</span>
          <span class="setting-row__source">{{ secret.sourceLine }}</span>
        </span>
        <span class="setting-row__state"><StatusPill :pill="secretPill(secret)" /></span>
        <span class="setting-row__chevron"><AppIcon name="chevron-down" /></span>
      </summary>
      <div class="setting-row__body">
        <p class="hint">Secret: <span class="mono">{{ secret.masked }}</span></p>
        <form class="setting-row__form" @submit.prevent="submitSecret($event, secret, 'set')">
          <div class="field">
            <label class="label" :for="`telegram-${secret.field}-value`">{{ secret.label }}</label>
            <input
              :id="`telegram-${secret.field}-value`"
              class="input"
              name="value"
              type="password"
              autocomplete="new-password"
              :placeholder="secret.masked"
              required
            >
          </div>
          <div class="setting-row__actions">
            <button class="btn btn-primary btn-sm" type="submit" :disabled="busy !== null">
              {{ settings.labels.actions.save }}
            </button>
            <button
              v-if="secret.actions.inherit !== null"
              class="btn btn-secondary btn-sm"
              type="button"
              :disabled="busy !== null || !secret.actions.inherit.enabled"
              @click="submitSecret($event, secret, 'inherit')"
            >
              {{ settings.labels.actions.inherit }}
            </button>
            <button
              v-if="secret.actions.clear !== null"
              class="btn btn-danger btn-sm"
              type="button"
              :disabled="busy !== null || !secret.actions.clear.enabled"
              @click="pendingClear = { kind: 'secret', secret }"
            >
              {{ settings.labels.actions.clear }}
            </button>
          </div>
          <p v-if="secret.actions.inherit?.reason" class="hint setting-row__reason">
            {{ secret.actions.inherit.reason }}
          </p>
          <p v-if="secret.actions.clear?.reason" class="hint setting-row__reason">
            {{ secret.actions.clear.reason }}
          </p>
        </form>
      </div>
    </details>

    <div class="stack--tight">
      <p class="hint">{{ settings.notifications.test.hint }}</p>
      <button
        class="btn btn-secondary btn-sm"
        type="button"
        :disabled="busy !== null"
        @click="sendTest"
      >
        {{ settings.notifications.test.label }}
      </button>
    </div>
  </div>

  <SettingsConfirmDialog
    :open="pendingClear !== null"
    :title="settings.labels.actions.clearTitle"
    :body="dialogBody"
    :submit-label="settings.labels.actions.clearConfirm"
    :busy="busy !== null"
    @confirm="confirmClear"
    @cancel="pendingClear = null"
  />
</template>
