<script setup lang="ts">
/**
 * Diff/file-list host. The shared highlight controller owns the worker; this component mounts the
 * rendered view and forwards the `<details>` open state, resetting only its own part on teardown.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ToolView } from "../../../assets/chat-diff.js";
import {
  mountToolView,
  resetHighlightController,
  setToolViewOpen,
} from "../../../assets/chat-highlight.js";

const props = defineProps<{
  view: ToolView;
  partId: string;
  viewKey: string;
  open?: boolean;
}>();

const host = ref<HTMLElement | null>(null);
let mounted = false;

function teardown(): void {
  if (!mounted) {
    return;
  }
  mounted = false;
  resetHighlightController({ partID: props.partId, reason: "view-unmounted" });
}

function mount(): void {
  const node = host.value;
  if (node === null) {
    return;
  }
  teardown();
  node.replaceChildren();
  const view = mountToolView(props.view, { partID: props.partId, viewKey: props.viewKey });
  if (view === null) {
    return;
  }
  node.append(view);
  mounted = true;
  syncOpen();
}

function syncOpen(): void {
  if (!mounted) {
    return;
  }
  setToolViewOpen(props.partId, props.viewKey, props.view, host.value, props.open === true);
}

onMounted(mount);
watch(() => props.viewKey, mount);
watch(() => props.open, syncOpen);
onBeforeUnmount(teardown);
</script>

<template>
  <div ref="host" class="tool-call__view" data-diff-view></div>
</template>
