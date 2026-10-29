<script setup lang="ts">
/** Global / project / application scope strip shared by the skills inventory and detail pages. */
import type { SkillsScopeProps } from "../skills-types.js";
import AppIcon from "./AppIcon.vue";
import SmartLink from "./SmartLink.vue";

defineProps<{ model: SkillsScopeProps }>();
</script>

<template>
  <nav class="settings-nav" :aria-label="model.nav.ariaLabel">
    <section class="settings-nav__scopes" :aria-label="model.nav.groupLabel">
      <template v-for="option in model.options" :key="option.scope">
        <span v-if="option.current" class="settings-nav__link" aria-current="page">
          <AppIcon name="check" />
          <span v-if="option.shortLabel === null">{{ option.label }}</span>
          <template v-else>
            <span class="settings-nav__scope-full">{{ option.label }}</span>
            <span class="settings-nav__scope-short">{{ option.shortLabel }}</span>
          </template>
        </span>
        <SmartLink v-else-if="option.href !== null" class="settings-nav__link" :to="option.href">
          {{ option.label }}
        </SmartLink>
      </template>
    </section>
  </nav>
</template>
