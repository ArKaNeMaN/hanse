<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import type {
  SettingsRowActionProps,
  SettingsRowProps,
  SettingsScopeDetailProps,
} from "../settings-types.js";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{
  row: SettingsRowProps;
  busy: boolean;
  saveLabel: string;
  inheritLabel: string;
  clearLabel: string;
}>();

const emit = defineEmits<{
  set: [row: SettingsRowProps, value: unknown];
  inherit: [row: SettingsRowProps];
  clear: [row: SettingsRowProps];
  dirty: [row: SettingsRowProps];
}>();

const textValue = ref("");
const selectValue = ref("");
const numberValue = ref("");
const driverValue = ref("");
const driverValues = reactive<Record<string, string>>({});
const driverChecks = reactive<Record<string, boolean>>({});
const error = ref<string | null>(null);

function selectedOption(row: SettingsRowProps): string {
  const driver = row.driver;
  if (driver === null) {
    return "";
  }
  return driver.options.find((option) => option.selected)?.value ?? "";
}

function resync(): void {
  const row = props.row;
  textValue.value = row.text?.value ?? "";
  numberValue.value = row.number?.value ?? "";
  driverValue.value = selectedOption(row);
  selectValue.value = row.select?.options.find((option) => option.selected)?.value ?? "";
  for (const key of Object.keys(driverValues)) {
    delete driverValues[key];
  }
  for (const key of Object.keys(driverChecks)) {
    delete driverChecks[key];
  }
  for (const field of row.driver?.fields ?? []) {
    driverValues[field.name] = field.value;
    driverChecks[field.name] = field.checked;
  }
  error.value = null;
}

watch(
  () => [
    props.row,
    props.row.own.state,
    props.row.effectiveText,
    props.row.sourceLine,
    props.row.text?.value,
    props.row.number?.value,
    Boolean(props.row.driver?.showFields),
  ],
  resync,
  { immediate: true },
);

function ownStateLabel(row: SettingsRowProps): string {
  if (row.own.state === "absent") {
    return row.effective.source === "default" ? "Default" : "Inherited";
  }
  if (row.own.state === "cleared") {
    return "Cleared";
  }
  return "Set";
}

function actionHint(action: SettingsRowActionProps | null): string | null {
  if (action === null) {
    return null;
  }
  return action.reason ?? action.warning ?? null;
}

function submitSet(): void {
  if (props.busy) {
    return;
  }
  error.value = null;
  const row = props.row;
  if (row.driver !== null) {
    if (driverValue.value === "builtin") {
      emit("set", row, { driver: "builtin" });
      return;
    }
    if (driverValue.value !== "deepseek") {
      error.value = "Choose a driver.";
      return;
    }
    const options: Record<string, unknown> = {};
    for (const field of row.driver.fields) {
      if (field.type === "checkbox") {
        if (driverChecks[field.name] === true) {
          options[field.name] = true;
        }
        continue;
      }
      const raw = String(driverValues[field.name] ?? "").trim();
      if (raw.length === 0) {
        if (field.required) {
          error.value = `${field.label} is required.`;
          return;
        }
        continue;
      }
      if (field.type === "number") {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) {
          error.value = `${field.label} must be a number.`;
          return;
        }
        options[field.name] = numeric;
      } else {
        options[field.name] = raw;
      }
    }
    emit("set", row, { driver: "deepseek", options });
    return;
  }
  if (row.select !== null) {
    if (selectValue.value !== "true" && selectValue.value !== "false") {
      error.value = "Choose a value.";
      return;
    }
    emit("set", row, selectValue.value === "true");
    return;
  }
  if (row.number !== null) {
    const raw = String(numberValue.value ?? "").trim();
    if (raw.length === 0) {
      error.value = "Enter a value.";
      return;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < row.number.min || numeric > row.number.max) {
      error.value = `Enter a number between ${row.number.min} and ${row.number.max}.`;
      return;
    }
    emit("set", row, numeric);
    return;
  }
  if (row.text !== null) {
    const value = textValue.value;
    if (row.text.required && value.trim().length === 0) {
      error.value = "Enter a value.";
      return;
    }
    emit("set", row, value);
  }
}

function scopeDetails(
  details: readonly SettingsScopeDetailProps[],
): readonly SettingsScopeDetailProps[] {
  return details;
}
</script>

<template>
  <details class="setting-row" :id="row.id">
    <summary class="setting-row__summary">
      <span class="setting-row__title">
        {{ row.title }}
        <span v-if="row.kind === 'model'" class="setting-row__affordance">Change</span>
        <span v-else-if="row.kind === 'web'" class="setting-row__affordance">Change</span>
      </span>
      <span class="setting-row__effective">
        <span class="mono">{{ row.effectiveText }}</span>
        <span class="setting-row__source">{{ row.sourceLine }}</span>
      </span>
      <span class="setting-row__state">
        <span class="badge">{{ ownStateLabel(row) }}</span>
      </span>
      <span class="setting-row__chevron"><AppIcon name="chevron-down" /></span>
    </summary>
    <div class="setting-row__body">
      <p v-if="row.hint !== null" class="hint">{{ row.hint }}</p>
      <p v-for="warning in row.warnings" :key="warning" class="field-error" role="alert">
        <AppIcon name="alert-triangle" />{{ warning }}
      </p>
      <p v-if="row.inheritedNote !== null" class="hint">{{ row.inheritedNote }}</p>

      <form
        class="setting-row__form"
        @submit.prevent="submitSet"
        @input="emit('dirty', row)"
        @change="emit('dirty', row)"
      >
        <template v-if="row.text !== null">
          <div class="field">
            <label class="label" :for="`${row.id}-value`">{{ row.title }}</label>
            <input
              :id="`${row.id}-value`"
              v-model="textValue"
              class="input"
              name="value"
              type="text"
              :list="row.text.listId ?? undefined"
              :placeholder="row.text.placeholder"
              :required="row.text.required"
              :autocomplete="row.text.autocomplete ?? 'off'"
            >
            <datalist v-if="row.text.listId !== null" :id="row.text.listId">
              <option v-for="option in row.text.options" :key="option" :value="option"></option>
            </datalist>
          </div>
        </template>

        <template v-else-if="row.driver !== null">
          <div class="field">
            <label class="label" :for="`${row.id}-driver`">Driver</label>
            <div class="select-wrap">
              <select
                :id="`${row.id}-driver`"
                v-model="driverValue"
                class="select"
                name="driver"
                required
              >
                <option
                  v-if="row.driver.placeholder !== null"
                  :value="row.driver.placeholder.value"
                  :disabled="row.driver.placeholder.disabled"
                  :selected="row.driver.placeholder.selected"
                >
                  {{ row.driver.placeholder.label }}
                </option>
                <option
                  v-for="option in row.driver.options"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div v-if="driverValue === 'deepseek'" class="stack--tight">
            <div v-for="field in row.driver.fields" :key="field.name" class="field">
              <label
                v-if="field.type !== 'checkbox'"
                class="label"
                :for="`${row.id}-${field.name}`"
              >
                {{ field.label }}
              </label>
              <input
                v-if="field.type === 'checkbox'"
                :id="`${row.id}-${field.name}`"
                v-model="driverChecks[field.name]"
                class="checkbox"
                type="checkbox"
                :name="field.name"
              >
              <input
                v-else
                :id="`${row.id}-${field.name}`"
                v-model="driverValues[field.name]"
                class="input"
                :name="field.name"
                :type="field.type"
                :min="field.min ?? undefined"
                :max="field.max ?? undefined"
                :placeholder="field.placeholder ?? undefined"
                :required="field.required"
              >
              <span v-if="field.type === 'checkbox'" class="small">{{ field.label }}</span>
            </div>
          </div>
        </template>

        <template v-else-if="row.select !== null">
          <div class="field">
            <label class="label" :for="`${row.id}-value`">{{ row.title }}</label>
            <div class="select-wrap">
              <select
                :id="`${row.id}-value`"
                v-model="selectValue"
                class="select"
                name="value"
                required
              >
                <option
                  v-if="row.select.placeholder !== null"
                  :value="row.select.placeholder.value"
                  :disabled="row.select.placeholder.disabled"
                  :selected="row.select.placeholder.selected"
                >
                  {{ row.select.placeholder.label }}
                </option>
                <option
                  v-for="option in row.select.options"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
        </template>

        <template v-else-if="row.number !== null">
          <div class="field">
            <label class="label" :for="`${row.id}-value`">{{ row.title }}</label>
            <input
              :id="`${row.id}-value`"
              v-model="numberValue"
              class="input"
              name="value"
              type="number"
              :min="row.number.min"
              :max="row.number.max"
              :step="row.number.step"
              :placeholder="row.number.placeholder"
              :required="row.number.required"
            >
          </div>
        </template>

        <p v-if="error !== null" class="field-error" role="alert">{{ error }}</p>

        <div class="setting-row__actions">
          <button class="btn btn-primary btn-sm" type="submit" :disabled="busy">
            {{ saveLabel }}
          </button>
          <button
            v-if="row.actions.inherit !== null"
            class="btn btn-secondary btn-sm"
            type="button"
            :disabled="busy || !row.actions.inherit.enabled"
            @click="emit('inherit', row)"
          >
            {{ inheritLabel }}
          </button>
          <button
            v-if="row.actions.clear !== null"
            class="btn btn-danger btn-sm"
            type="button"
            :disabled="busy || !row.actions.clear.enabled"
            @click="emit('clear', row)"
          >
            {{ clearLabel }}
          </button>
        </div>
        <p v-if="actionHint(row.actions.inherit) !== null" class="hint setting-row__reason">
          {{ actionHint(row.actions.inherit) }}
        </p>
        <p v-if="actionHint(row.actions.clear) !== null" class="hint setting-row__reason">
          {{ actionHint(row.actions.clear) }}
        </p>
      </form>

      <details v-if="row.scopeDetails.length > 0" class="disclosure scope-details">
        <summary>
          Scope details<AppIcon name="chevron-down" class-name="disclosure__chevron" />
        </summary>
        <dl class="scope-list">
          <div
            v-for="detail in scopeDetails(row.scopeDetails)"
            :key="detail.scope"
            class="scope-list__row"
          >
            <dt>{{ detail.label }}</dt>
            <dd>
              <span v-if="detail.valueText !== null" class="mono">{{ detail.valueText }}</span>
              <span class="scope-list__state">{{ detail.stateLabel }}</span>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  </details>
</template>
