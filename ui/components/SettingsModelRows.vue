<script setup lang="ts">
import type { SettingsLabelsProps, SettingsModelDraft } from "../settings-types.js";

defineProps<{
  models: SettingsModelDraft[];
  labels: SettingsLabelsProps["modelProviders"];
  prefix: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ add: []; remove: [index: number] }>();
</script>

<template>
  <div class="model-list">
    <div v-for="(model, index) in models" :key="model.key" class="model-row">
      <div class="model-row__head">
        <span class="label">{{ labels.modelRow }} {{ index + 1 }}</span>
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="disabled || models.length <= 1"
          @click="emit('remove', index)"
        >
          {{ labels.removeModel }}
        </button>
      </div>
      <div class="model-row__grid">
        <div class="field">
          <label class="label" :for="`${prefix}-${index}-id`">{{ labels.modelId }}</label>
          <input
            :id="`${prefix}-${index}-id`"
            v-model="model.id"
            class="input"
            type="text"
            :placeholder="labels.modelIdPlaceholder"
            required
            autocomplete="off"
          >
        </div>
        <div class="field">
          <label class="label" :for="`${prefix}-${index}-name`">{{ labels.modelName }}</label>
          <input
            :id="`${prefix}-${index}-name`"
            v-model="model.name"
            class="input"
            type="text"
            :placeholder="labels.modelNamePlaceholder"
            autocomplete="off"
          >
        </div>
        <div class="field">
          <label class="label" :for="`${prefix}-${index}-context`">
            {{ labels.contextWindow }}
          </label>
          <input
            :id="`${prefix}-${index}-context`"
            v-model="model.context"
            class="input"
            type="number"
            min="1"
            max="10000000"
            :placeholder="labels.contextWindowPlaceholder"
            required
          >
        </div>
        <div class="field">
          <label class="label" :for="`${prefix}-${index}-output`">{{ labels.outputLimit }}</label>
          <input
            :id="`${prefix}-${index}-output`"
            v-model="model.output"
            class="input"
            type="number"
            min="1"
            max="10000000"
            :placeholder="labels.outputLimitPlaceholder"
            required
          >
        </div>
        <div class="field">
          <label class="label" :for="`${prefix}-${index}-input`">{{ labels.inputLimit }}</label>
          <input
            :id="`${prefix}-${index}-input`"
            v-model="model.input"
            class="input"
            type="number"
            min="1"
            max="10000000"
            :placeholder="labels.inputLimitPlaceholder"
          >
        </div>
        <span class="label model-row__section">{{ labels.cost }}</span>
        <div class="field">
          <label class="label" :for="`${prefix}-${index}-costInput`">{{ labels.costInput }}</label>
          <input
            :id="`${prefix}-${index}-costInput`"
            v-model="model.costInput"
            class="input"
            type="number"
            min="0"
            step="any"
            :placeholder="labels.costPlaceholder"
          >
        </div>
        <div class="field">
          <label class="label" :for="`${prefix}-${index}-costOutput`">
            {{ labels.costOutput }}
          </label>
          <input
            :id="`${prefix}-${index}-costOutput`"
            v-model="model.costOutput"
            class="input"
            type="number"
            min="0"
            step="any"
            :placeholder="labels.costPlaceholder"
          >
        </div>
      </div>
      <span class="label">{{ labels.capabilities }}</span>
      <div class="cluster">
        <label class="check">
          <input v-model="model.attachment" class="checkbox" type="checkbox">
          <span>{{ labels.attachments }}</span>
        </label>
        <label class="check">
          <input v-model="model.reasoning" class="checkbox" type="checkbox">
          <span>{{ labels.reasoning }}</span>
        </label>
        <label class="check">
          <input v-model="model.toolCall" class="checkbox" type="checkbox">
          <span>{{ labels.toolCalls }}</span>
        </label>
        <label class="check">
          <input v-model="model.temperature" class="checkbox" type="checkbox">
          <span>{{ labels.temperature }}</span>
        </label>
      </div>
    </div>
    <div class="setting-row__actions">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="disabled" @click="emit('add')">
        {{ labels.addModel }}
      </button>
    </div>
  </div>
</template>
