<script setup lang="ts">
/**
 * Write view host. The shared highlight controller renders structured path/line fields and per-line
 * text nodes; the worker starts only when the details is opened.
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
  resetHighlightController({ partID: props.partId, reason: "write-unmounted" });
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
  <div ref="host" data-write-view></div>
</template>
