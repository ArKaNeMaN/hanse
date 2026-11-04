<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

defineProps<{
  groupId: string;
  title: string;
  icon: string;
  open: boolean;
  summary?: string;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();
</script>

<template>
  <section class="card section app-group" :class="{ 'app-group--open': open }">
    <h2 class="app-group__heading">
      <button
        type="button"
        :id="`group-${groupId}-toggle`"
        class="app-group__toggle"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-controls="`group-${groupId}-body`"
        @click="emit('update:open', !open)"
      >
        <span class="app-group__identity">
          <AppIcon :name="icon" class-name="app-group__icon" />
          <span class="app-group__title">{{ title }}</span>
        </span>
        <span class="app-group__tail">
          <span v-if="summary !== undefined && summary.length > 0" class="app-group__summary">{{
            summary
          }}</span>
          <AppIcon name="chevron-down" class-name="app-group__chevron" />
        </span>
      </button>
    </h2>
    <!-- biome-ignore lint/a11y/useSemanticElements: the contract requires a v-show div region body, not a nested section -->
    <div
      v-show="open"
      :id="`group-${groupId}-body`"
      class="app-group__body"
      role="region"
      :aria-labelledby="`group-${groupId}-toggle`"
    >
      <slot />
    </div>
  </section>
</template>
