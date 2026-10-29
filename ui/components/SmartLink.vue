<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { isSpaPath } from "../../src/shared/routes.js";

defineOptions({ inheritAttrs: false });

const props = defineProps<{ to: string }>();

function pathnameOf(to: string): string {
  if (to.startsWith("#")) {
    return "";
  }
  const query = to.indexOf("?");
  const hash = to.indexOf("#");
  const indexes = [query, hash].filter((index) => index >= 0);
  const end = indexes.length === 0 ? to.length : Math.min(...indexes);
  return to.slice(0, end);
}

const spa = computed(() => {
  const pathname = pathnameOf(props.to);
  return pathname.length > 0 && isSpaPath(pathname);
});

function onClick(event: MouseEvent, navigate: (event?: MouseEvent) => Promise<unknown>): void {
  if (event.defaultPrevented) {
    return;
  }
  if (event.button !== 0) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLAnchorElement)) {
    return;
  }
  if (anchor.hasAttribute("download")) {
    return;
  }
  if (anchor.target.length > 0 && anchor.target !== "_self") {
    return;
  }
  event.preventDefault();
  // Do not pass the event: the router's own guard rejects an already-default-prevented event.
  void navigate();
}
</script>

<template>
  <RouterLink v-if="spa" v-slot="{ href, navigate, isExactActive }" :to="to" custom>
    <a
      :href="href"
      :aria-current="isExactActive ? 'page' : undefined"
      v-bind="$attrs"
      @click="onClick($event, navigate)"
    >
      <slot />
    </a>
  </RouterLink>
  <a v-else v-bind="$attrs" :href="to">
    <slot />
  </a>
</template>
