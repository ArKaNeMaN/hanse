<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type {
  SettingsModelDraft,
  SettingsModelProviderModel,
  SettingsModelProviderRowProps,
  SettingsProps,
} from "../settings-types.js";
import type { PillSpec } from "../status.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import SettingsConfirmDialog from "./SettingsConfirmDialog.vue";
import SettingsModelRows from "./SettingsModelRows.vue";
import SmartLink from "./SmartLink.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{ settings: SettingsProps }>();
const emit = defineEmits<{ changed: [message: string] }>();
const toasts = useToastStore();

const busy = ref<string | null>(null);
const pendingDelete = ref<SettingsModelProviderRowProps | null>(null);
const editModels = reactive<Record<string, SettingsModelDraft[]>>({});
let draftSequence = 0;
const newModels = ref<SettingsModelDraft[]>([blankModel()]);

function nextDraftKey(): number {
  draftSequence += 1;
  return draftSequence;
}

function blankModel(): SettingsModelDraft {
  return {
    key: nextDraftKey(),
    id: "",
    name: "",
    context: "",
    input: "",
    output: "",
    attachment: false,
    reasoning: false,
    toolCall: true,
    temperature: false,
    costInput: "",
    costOutput: "",
  };
}

function toDraft(model: SettingsModelProviderModel): SettingsModelDraft {
  return {
    key: nextDraftKey(),
    id: model.id,
    name: model.name ?? "",
    context: String(model.limit.context),
    input: model.limit.input === undefined ? "" : String(model.limit.input),
    output: String(model.limit.output),
    attachment: model.attachment === true,
    reasoning: model.reasoning === true,
    toolCall: model.toolCall !== false,
    temperature: model.temperature === true,
    costInput: model.cost === undefined ? "" : String(model.cost.input),
    costOutput: model.cost === undefined ? "" : String(model.cost.output),
  };
}

function modelsFor(row: SettingsModelProviderRowProps): SettingsModelDraft[] {
  let drafts = editModels[row.id];
  if (drafts === undefined) {
    drafts = row.models.map(toDraft);
    editModels[row.id] = drafts;
  }
  return drafts;
}

function addEditModel(row: SettingsModelProviderRowProps): void {
  modelsFor(row).push(blankModel());
}

function removeEditModel(row: SettingsModelProviderRowProps, index: number): void {
  const drafts = modelsFor(row);
  if (drafts.length > 1) {
    drafts.splice(index, 1);
  }
}

function addNewModel(): void {
  newModels.value.push(blankModel());
}

function removeNewModel(index: number): void {
  if (newModels.value.length > 1) {
    newModels.value.splice(index, 1);
  }
}

function draftText(value: string | number): string {
  return typeof value === "number" ? String(value) : value;
}

function parseToken(value: string | number, label: string): number {
  const text = draftText(value).trim();
  const parsed = Number(text);
  if (text.length === 0 || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return parsed;
}

function parsePrice(value: string | number, label: string): number | undefined {
  const text = draftText(value).trim();
  if (text.length === 0) {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return parsed;
}

function modelFromDraft(draft: SettingsModelDraft): Record<string, unknown> {
  const id = draft.id.trim();
  if (id.length === 0) {
    throw new Error("Every model needs an id.");
  }
  const input =
    draftText(draft.input).trim().length === 0 ? undefined : parseToken(draft.input, "Max input");
  const costInput = parsePrice(draft.costInput, "Input cost");
  const costOutput = parsePrice(draft.costOutput, "Output cost");
  return {
    id,
    ...(draft.name.trim().length === 0 ? {} : { name: draft.name.trim() }),
    limit: {
      context: parseToken(draft.context, "Context window"),
      ...(input === undefined ? {} : { input }),
      output: parseToken(draft.output, "Max output"),
    },
    attachment: draft.attachment,
    reasoning: draft.reasoning,
    toolCall: draft.toolCall,
    temperature: draft.temperature,
    ...(costInput === undefined && costOutput === undefined
      ? {}
      : { cost: { input: costInput ?? 0, output: costOutput ?? 0 } }),
  };
}

function modelsFromDrafts(drafts: readonly SettingsModelDraft[]): Record<string, unknown>[] {
  const models = drafts.map(modelFromDraft);
  const ids = new Set<string>();
  for (const model of models) {
    const id = model.id as string;
    if (ids.has(id)) {
      throw new Error(`Duplicate model id: ${id}`);
    }
    ids.add(id);
  }
  return models;
}

watch(
  () => props.settings.modelProviders.providers,
  (providers) => {
    const ids = new Set(providers.map((provider) => provider.id));
    for (const key of Object.keys(editModels)) {
      if (!ids.has(key)) {
        delete editModels[key];
      }
    }
    for (const provider of providers) {
      if (editModels[provider.id] === undefined) {
        editModels[provider.id] = provider.models.map(toDraft);
      }
    }
  },
  { immediate: true },
);

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
  if (baseUrl.length === 0) {
    toasts.push("Base URL is required.", "error");
    return;
  }
  let models: Record<string, unknown>[];
  try {
    models = modelsFromDrafts(modelsFor(row));
  } catch (error) {
    toasts.push(failure(error, "Check the model fields."), "error");
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
  if (id.length === 0 || baseUrl.length === 0) {
    toasts.push("Provider id and base URL are required.", "error");
    return;
  }
  let models: Record<string, unknown>[];
  try {
    models = modelsFromDrafts(newModels.value);
  } catch (error) {
    toasts.push(failure(error, "Check the model fields."), "error");
    return;
  }
  busy.value = "create";
  try {
    await apiMutation(props.settings.modelProviders.add.action, {
      json: { action: "create", id, name: field(form, "name"), baseUrl, models },
    });
    newModels.value = [blankModel()];
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
        v-for="(row, index) in settings.modelProviders.providers"
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
              <span class="label">{{ settings.labels.modelProviders.models }}</span>
              <p class="hint">{{ settings.labels.modelProviders.modelsHint }}</p>
            </div>
            <SettingsModelRows
              :models="modelsFor(row)"
              :labels="settings.labels.modelProviders"
              :prefix="`custom-provider-model-${index}`"
              :disabled="busy !== null"
              @add="addEditModel(row)"
              @remove="(modelIndex) => removeEditModel(row, modelIndex)"
            />
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
            <span class="label">{{ settings.labels.modelProviders.models }}</span>
            <p class="hint">{{ settings.labels.modelProviders.modelsHint }}</p>
          </div>
          <SettingsModelRows
            :models="newModels"
            :labels="settings.labels.modelProviders"
            prefix="custom-provider-model-new"
            :disabled="busy !== null"
            @add="addNewModel"
            @remove="removeNewModel"
          />
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
