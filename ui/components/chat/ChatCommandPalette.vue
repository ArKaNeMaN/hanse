<script setup lang="ts">
/**
 * Slash command palette: filtered catalog, keyboard navigation, degraded-source notice, and the
 * shared confirmation surface for shell/unknown commands. It performs no network or store writes;
 * ChatPage owns dispatch.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { resolveComposerCommand } from "../../../assets/chat-commands.js";
import type { CommandEntry } from "../../../src/opencode/commands.js";
import type { CommandConfirmRequest, CommandPaletteStatus } from "../../chat/types.js";

const props = defineProps<{
  open: boolean;
  filter: string;
  commands: readonly CommandEntry[];
  status: CommandPaletteStatus;
  warning?: string | null;
  shadowed?: readonly string[];
  confirm?: CommandConfirmRequest | null;
  master?: boolean;
}>();

const emit = defineEmits<{
  select: [entry: CommandEntry];
  close: [];
  "confirm-result": [accepted: boolean];
}>();

const PALETTE_RENDER_LIMIT = 200;
const activeIndex = ref(-1);

const sourceReady = computed(() => props.status === "ready");
const filtered = computed(() => {
  const known = props.commands;
  const query = props.filter.trim().toLowerCase();
  if (query.length === 0) return known;
  return known.filter((entry) => {
    if (entry.name.toLowerCase().includes(query)) return true;
    if (entry.aliases?.some((alias) => alias.toLowerCase().includes(query)) === true) return true;
    return typeof entry.description === "string" && entry.description.toLowerCase().includes(query);
  });
});
const capped = computed(() => filtered.value.slice(0, PALETTE_RENDER_LIMIT));
const groups = computed(() => [
  { label: "Hanse", entries: capped.value.filter((entry) => entry.source === "hanse") },
  {
    label: "Application commands",
    entries: capped.value.filter((entry) => entry.source === "opencode"),
  },
]);
const flatRows = computed(() => capped.value);
const enabledIndexes = computed(() =>
  flatRows.value
    .map((entry, index) => ({ entry, index }))
    .filter((row) => row.entry.available !== false)
    .map((row) => row.index),
);
const statusText = computed(() => {
  if (props.status === "loading") return "Loading commands…";
  const total = filtered.value.length;
  if (total === 0) return "No matching commands";
  if (total > PALETTE_RENDER_LIMIT) {
    return `Showing ${PALETTE_RENDER_LIMIT} of ${total}. Refine your search.`;
  }
  return `${total} command${total === 1 ? "" : "s"}`;
});
const sourceNotice = computed(() => {
  if (props.warning !== undefined && props.warning !== null && props.warning.length > 0) {
    return props.warning;
  }
  if (props.status === "stopped") return "Application commands load when the agent starts.";
  if (props.status === "unavailable") {
    return "Application commands are unavailable; Hanse commands still work.";
  }
  if (props.status === "unconfigured") {
    return "No agent runtime is configured; Hanse commands still work.";
  }
  return null;
});
const shadowText = computed(() => {
  const names = props.shadowed ?? [];
  return names.length === 0
    ? null
    : `Provided by the application: ${names.map((name) => `/${name}`).join(", ")}`;
});
const confirmOpen = computed(() => props.confirm !== undefined && props.confirm !== null);

function isDisabled(entry: CommandEntry): boolean {
  if (entry.available === false) return true;
  const resolved = resolveComposerCommand(props.commands, entry.name, {
    listAvailable: sourceReady.value,
    master: props.master === true,
  });
  return resolved.kind === "disabled";
}

function unavailableReason(entry: CommandEntry): string {
  if (entry.unavailableReason !== undefined) return entry.unavailableReason;
  const resolved = resolveComposerCommand(props.commands, entry.name, {
    listAvailable: sourceReady.value,
    master: props.master === true,
  });
  return resolved.kind === "disabled" ? resolved.reason : "";
}

function firstEnabled(): number {
  return enabledIndexes.value[0] ?? -1;
}

function move(delta: 1 | -1): void {
  const enabled = enabledIndexes.value;
  if (enabled.length === 0) {
    activeIndex.value = -1;
    return;
  }
  const position = enabled.indexOf(activeIndex.value);
  const next =
    position === -1
      ? delta > 0
        ? 0
        : enabled.length - 1
      : (position + delta + enabled.length) % enabled.length;
  activeIndex.value = enabled[next] ?? -1;
}

function choose(): void {
  const index = activeIndex.value;
  const entry = index < 0 ? undefined : flatRows.value[index];
  if (entry === undefined || isDisabled(entry)) return;
  emit("select", entry);
}

function onListClick(entry: CommandEntry): void {
  if (isDisabled(entry)) return;
  emit("select", entry);
}

function onKeydown(event: KeyboardEvent): void {
  if (confirmOpen.value) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      emit("confirm-result", false);
    }
    return;
  }
  if (!props.open) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    move(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    event.stopPropagation();
    const enabled = enabledIndexes.value;
    activeIndex.value =
      enabled.length === 0
        ? -1
        : event.key === "Home"
          ? (enabled[0] ?? -1)
          : (enabled[enabled.length - 1] ?? -1);
    return;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    choose();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  }
}

function install(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("keydown", onKeydown, true);
}

function uninstall(): void {
  if (typeof document === "undefined") return;
  document.removeEventListener("keydown", onKeydown, true);
}

watch(
  () => [props.open, props.confirm !== undefined && props.confirm !== null, props.filter] as const,
  () => {
    activeIndex.value = props.open ? firstEnabled() : -1;
    if (props.open || confirmOpen.value) install();
    else uninstall();
  },
  { immediate: true },
);

watch(
  () => props.commands,
  () => {
    if (props.open) activeIndex.value = firstEnabled();
  },
);

watch(
  () => props.confirm,
  (confirm) => {
    if (confirm === undefined || confirm === null) return;
    void nextTick().then(() => {
      const node = document.querySelector<HTMLButtonElement>("[data-command-confirm-accept]");
      node?.focus();
    });
  },
);

onBeforeUnmount(uninstall);
</script>

<template>
  <div v-if="open" class="command-palette" data-command-palette>
    <div class="command-palette__head">
      <span class="overline">Commands</span>
      <span class="command-palette__status" role="status" aria-live="polite" aria-atomic="true">
        {{ statusText }}
      </span>
    </div>
    <div class="command-palette__list" role="listbox" aria-label="Slash commands">
      <!-- biome-ignore lint/a11y/useSemanticElements: listbox group semantics match the legacy palette -->
      <div
        v-for="group in groups"
        :key="group.label"
        class="command-palette__group"
        role="group"
        :aria-label="group.label"
      >
        <p class="command-palette__group-label">{{ group.label }}</p>
        <p
          v-if="
            group.entries.length === 0 &&
            group.label === 'Application commands' &&
            filter.trim().length === 0 &&
            sourceReady
          "
          class="command-palette__empty"
        >
          No application commands
        </p>
        <button
          v-for="entry in group.entries"
          :key="`${entry.source}:${entry.name}`"
          class="command-palette__row"
          :class="{
            'command-palette__row--active':
              flatRows[activeIndex]?.name === entry.name &&
              flatRows[activeIndex]?.source === entry.source,
          }"
          type="button"
          role="option"
          :aria-selected="
            flatRows[activeIndex]?.name === entry.name &&
            flatRows[activeIndex]?.source === entry.source
              ? 'true'
              : 'false'
          "
          :aria-disabled="isDisabled(entry) ? 'true' : undefined"
          :data-command-name="entry.name"
          :data-command-source="entry.source"
          :data-command-disabled="isDisabled(entry) ? 'true' : undefined"
          @click="onListClick(entry)"
        >
          <span class="command-palette__name mono">/{{ entry.name }}</span>
          <span v-if="entry.description !== undefined" class="command-palette__desc">
            {{ entry.description }}
          </span>
          <span v-if="isDisabled(entry)" class="command-palette__reason">
            {{ unavailableReason(entry) }}
          </span>
        </button>
      </div>
    </div>
    <p v-if="sourceNotice !== null" class="command-palette__notice" data-command-notice>
      {{ sourceNotice }}
    </p>
    <p v-if="shadowText !== null" class="command-palette__shadow" data-command-shadow>
      {{ shadowText }}
    </p>
  </div>

  <div
    v-if="confirm !== undefined && confirm !== null"
    class="dialog command-confirm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="chat-command-confirm-title"
    aria-describedby="chat-command-confirm-body"
    data-command-confirm
  >
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="chat-command-confirm-title">{{ confirm.title }}</h2>
      </header>
      <div class="dialog__body">
        <p id="chat-command-confirm-body">{{ confirm.body }}</p>
      </div>
      <footer class="dialog__foot">
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          data-command-confirm-cancel
          @click="emit('confirm-result', false)"
        >
          {{ confirm.cancelLabel ?? "Cancel" }}
        </button>
        <button
          class="btn btn-danger btn-sm"
          type="button"
          data-command-confirm-accept
          @click="emit('confirm-result', true)"
        >
          {{ confirm.confirmLabel ?? "Confirm" }}
        </button>
      </footer>
    </div>
  </div>
</template>
