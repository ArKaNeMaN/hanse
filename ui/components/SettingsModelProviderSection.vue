<script setup lang="ts">
import { ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { SettingsModelProviderRowProps, SettingsProps } from "../settings-types.js";
import type { PillSpec } from "../status.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import SettingsConfirmDialog from "./SettingsConfirmDialog.vue";
import SmartLink from "./SmartLink.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{ settings: SettingsProps }>();
const emit = defineEmits<{ changed: [message: string] }>();
const toasts = useToastStore();

const busy = ref<string | null>(null);
const pendingDelete = ref<SettingsModelProviderRowProps | null>(null);

function keyPill(row: SettingsModelProviderRowProps): PillSpec {
  switch (row.key.state) {
    case "set":
      return { variant: "status", dataState: "delivered", icon: "check", label: "Key set" };
    case "cleared":
      return { variant: "status", dataState: "cancelled", icon: "slash", label: "Key cleared" };
    case "host":
      return { variant: "status", dataState: "in_progress", icon: "lock", label: "Host auth" };
    case "error":
      return { variant: "status", dataState: "failed", icon: "alert-triangle", label: "Key error" };
    default:
      return { variant: "status", dataState: "cancelled", icon: "slash", label: "No key" };
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

function field(form: HTMLFormElement, name: string): string {
  return (
    form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? ""
  );
}

async function save(event: Event, row: SettingsModelProviderRowProps): Promise<void> {
  const form = formOf(event);
  if (form === null || busy.value !== null) {
    return;
  }
  const baseUrl = field(form, "baseUrl").trim();
  const models = field(form, "models");
  if (baseUrl.length === 0 || models.trim().length === 0) {
    toasts.push("Base URL and models are required.", "error");
    return;
  }
  busy.value = row.id;
  try {
    await apiMutation(props.settings.modelProviders.add.action, {
      json: {
        action: "update",
        id: row.id,
        name: field(form, "name"),
        baseUrl,
        models,
      },
    });
    emit("changed", "Provider saved.");
  } catch (error) {
    toasts.push(failure(error, "Could not save the provider."), "error");
  } finally {
    busy.value = null;
  }
}

async function create(event: Event): Promise<void> {
  const form = formOf(event);
  if (form === null || busy.value !== null) {
    return;
  }
  const id = field(form, "id").trim();
  const baseUrl = field(form, "baseUrl").trim();
  const models = field(form, "models");
  if (id.length === 0 || baseUrl.length === 0 || models.trim().length === 0) {
    toasts.push("Provider id, base URL, and models are required.", "error");
    return;
  }
  busy.value = "create";
  try {
    await apiMutation(props.settings.modelProviders.add.action, {
      json: { action: "create", id, name: field(form, "name"), baseUrl, models },
    });
    form.reset();
    emit("changed", "Provider saved.");
  } catch (error) {
    toasts.push(failure(error, "Could not create the provider."), "error");
  } finally {
    busy.value = null;
  }
}

async function confirmDelete(): Promise<void> {
  const row = pendingDelete.value;
  if (row === null || busy.value !== null) {
    return;
  }
  busy.value = row.id;
  try {
    await apiMutation(props.settings.modelProviders.add.action, {
      json: { action: "delete", id: row.id },
    });
    pendingDelete.value = null;
    emit("changed", "Provider deleted.");
  } catch (error) {
    toasts.push(failure(error, "Could not delete the provider."), "error");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section class="providers" id="custom-providers" aria-labelledby="custom-providers-title">
    <div class="providers__head">
      <h3 class="card__title" id="custom-providers-title">
        {{ settings.labels.modelProviders.title }}
      </h3>
      <span class="badge">
        {{ settings.modelProviders.count }}
        {{ settings.modelProviders.count === 1 ? "provider" : "providers" }}
      </span>
    </div>
    <p class="hint providers__hint">{{ settings.labels.modelProviders.hint }}</p>

    <template v-if="settings.scope.scope !== 'global'">
      <p class="hint">
        {{ settings.labels.modelProviders.globalHint }}
        <SmartLink :to="settings.modelProviders.manageHref">
          {{ settings.labels.modelProviders.manage }}
        </SmartLink>
      </p>
    </template>
    <template v-else>
      <p v-if="settings.modelProviders.providers.length === 0" class="hint">
        {{ settings.labels.modelProviders.empty }}
      </p>
      <details
        v-for="row in settings.modelProviders.providers"
        :key="row.id"
        class="setting-row"
        :id="row.rowId"
      >
        <summary class="setting-row__summary">
          <span class="setting-row__title">
            {{ row.name }}
            ({{ row.id }})
            <span class="setting-row__affordance">Edit</span>
          </span>
          <span class="setting-row__effective">
            <span class="mono">{{ row.baseUrl }}</span>
            <span class="setting-row__source">Global</span>
          </span>
          <span class="setting-row__state"><StatusPill :pill="keyPill(row)" /></span>
          <span class="setting-row__chevron"><AppIcon name="chevron-down" /></span>
        </summary>
        <div class="setting-row__body">
          <p v-for="warning in row.warnings" :key="warning" class="field-error" role="alert">
            <AppIcon name="alert-triangle" />{{ warning }}
          </p>
          <p class="hint">
            Key: <span class="mono">{{ row.key.masked }}</span>
            <span class="scope-list__state">{{ row.key.label }}</span>
            · {{ row.models.length }}
            {{ row.models.length === 1 ? "model" : "models" }}
          </p>
          <form class="setting-row__form" @submit.prevent="save($event, row)">
            <div class="field">
              <label class="label" :for="row.nameInputId">
                {{ settings.labels.modelProviders.name }}
              </label>
              <input
                :id="row.nameInputId"
                class="input"
                name="name"
                type="text"
                :value="row.name"
                autocomplete="off"
              >
            </div>
            <div class="field">
              <label class="label" :for="row.urlInputId">
                {{ settings.labels.modelProviders.baseUrl }}
              </label>
              <input
                :id="row.urlInputId"
                class="input"
                name="baseUrl"
                type="text"
                :value="row.baseUrl"
                required
                autocomplete="off"
              >
            </div>
            <div class="field">
              <label class="label" :for="row.modelsInputId">
                {{ settings.labels.modelProviders.models }}
              </label>
              <textarea
                :id="row.modelsInputId"
                class="input"
                name="models"
                rows="4"
                required
                :value="row.modelsText"
              ></textarea>
              <p class="hint">{{ settings.labels.modelProviders.modelsHint }}</p>
            </div>
            <div class="setting-row__actions">
              <button class="btn btn-primary btn-sm" type="submit" :disabled="busy !== null">
                {{ settings.labels.actions.save }}
              </button>
              <button
                class="btn btn-danger btn-sm"
                type="button"
                :disabled="busy !== null"
                @click="pendingDelete = row"
              >
                Delete
              </button>
            </div>
          </form>
        </div>
      </details>

      <details class="disclosure provider-add">
        <summary>
          {{ settings.labels.modelProviders.addTitle
          }}<AppIcon name="chevron-down" class-name="disclosure__chevron" />
        </summary>
        <form class="setting-row__form provider-add__form" @submit.prevent="create">
          <div class="field">
            <label class="label" for="custom-provider-new-id">
              {{ settings.labels.modelProviders.providerId }}
            </label>
            <input
              id="custom-provider-new-id"
              class="input"
              name="id"
              type="text"
              :placeholder="settings.labels.modelProviders.providerIdPlaceholder"
              required
              autocomplete="off"
            >
          </div>
          <div class="field">
            <label class="label" for="custom-provider-new-name">
              {{ settings.labels.modelProviders.name }}
            </label>
            <input
              id="custom-provider-new-name"
              class="input"
              name="name"
              type="text"
              :placeholder="settings.labels.modelProviders.namePlaceholder"
              autocomplete="off"
            >
          </div>
          <div class="field">
            <label class="label" for="custom-provider-new-url">
              {{ settings.labels.modelProviders.baseUrl }}
            </label>
            <input
              id="custom-provider-new-url"
              class="input"
              name="baseUrl"
              type="text"
              :placeholder="settings.labels.modelProviders.baseUrlPlaceholder"
              required
              autocomplete="off"
            >
          </div>
          <div class="field">
            <label class="label" for="custom-provider-new-models">
              {{ settings.labels.modelProviders.models }}
            </label>
            <textarea
              id="custom-provider-new-models"
              class="input"
              name="models"
              rows="4"
              :placeholder="settings.labels.modelProviders.modelsPlaceholder"
              required
            ></textarea>
            <p class="hint">{{ settings.labels.modelProviders.modelsHint }}</p>
          </div>
          <div class="setting-row__actions">
            <button class="btn btn-primary btn-sm" type="submit" :disabled="busy !== null">
              {{ settings.labels.actions.save }}
            </button>
          </div>
        </form>
      </details>
    </template>
  </section>

  <SettingsConfirmDialog
    :open="pendingDelete !== null"
    :title="settings.labels.modelProviders.deleteConfirmPrefix"
    :body="
      pendingDelete === null
        ? ''
        : `${settings.labels.modelProviders.deleteConfirmPrefix} ${pendingDelete.id}?`
    "
    submit-label="Delete"
    :busy="busy !== null"
    @confirm="confirmDelete"
    @cancel="pendingDelete = null"
  />
</template>
