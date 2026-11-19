<script setup lang="ts">
/**
 * Shared target selector: a 32px trigger plus a native modal `<dialog>` holding a search
 * combobox and a listbox. It emits `change(target)` and never navigates; consumers map the target
 * to a route or form. The dialog reuses the app's `dialog` primitive and Chart Room tokens.
 */
import { computed, nextTick, ref, watch } from "vue";
import { sameTarget, targetKey } from "../skills-target.js";
import type {
  Target,
  TargetAppProps,
  TargetProjectProps,
  TargetSelectorConfig,
  TargetsProps,
} from "../target-types.js";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{
  config: TargetSelectorConfig;
  current: Target;
  currentLabel: string;
  catalog: TargetsProps | null | undefined;
  loading?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  change: [target: Target];
  retry: [];
}>();

interface SelectorOption {
  readonly target: Target;
  readonly label: string;
  readonly subtitle: string | null;
  readonly icon: string;
  readonly search: string;
  readonly current: boolean;
}

interface FlatOption extends SelectorOption {
  readonly id: string;
  readonly index: number;
}

interface SelectorSection {
  readonly key: string;
  readonly heading: string | null;
  readonly options: readonly FlatOption[];
}

interface BaseSection {
  readonly heading: string | null;
  readonly options: readonly SelectorOption[];
}

let uidCounter = 0;
uidCounter += 1;
const uid = `target-selector-${uidCounter}`;
const dialogId = `${uid}-dialog`;
const listboxId = `${uid}-listbox`;
const searchId = `${uid}-search`;

const triggerEl = ref<HTMLButtonElement | null>(null);
const dialogEl = ref<HTMLDialogElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const open = ref(false);
const query = ref("");
const activeIndex = ref(-1);

const projects = computed<readonly TargetProjectProps[]>(() => props.catalog?.projects ?? []);
const hasCatalog = computed(() => props.catalog !== null && props.catalog !== undefined);
const hasError = computed(() => typeof props.error === "string" && props.error.length > 0);

const currentIcon = computed(() => {
  switch (props.current.kind) {
    case "global":
      return "globe";
    case "all":
      return "layers";
    case "project":
      return "folder";
    case "app":
      return "dashboard";
  }
});

function globalOption(): SelectorOption {
  const target: Target = { kind: "global" };
  return {
    target,
    label: "Global",
    subtitle: null,
    icon: "globe",
    search: "global",
    current: sameTarget(target, props.current),
  };
}

function allOption(label: string): SelectorOption {
  const target: Target = { kind: "all" };
  return {
    target,
    label,
    subtitle: null,
    icon: "layers",
    search: `all ${label}`.toLowerCase(),
    current: sameTarget(target, props.current),
  };
}

function projectOption(project: TargetProjectProps): SelectorOption {
  const target: Target = { kind: "project", projectId: project.id };
  return {
    target,
    label: project.name,
    subtitle: null,
    icon: "folder",
    search: `${project.name} ${project.id}`.toLowerCase(),
    current: sameTarget(target, props.current),
  };
}

function appOption(app: TargetAppProps, subtitle: string | null): SelectorOption {
  const target: Target = { kind: "app", projectId: app.projectId, appKey: app.appKey };
  const label = app.master ? "Master" : app.appKey;
  return {
    target,
    label,
    subtitle,
    icon: "dashboard",
    search:
      `${app.projectName} ${app.appKey} ${app.projectName} / ${app.appKey} ${label}`.toLowerCase(),
    current: sameTarget(target, props.current),
  };
}

function masterOption(app: TargetAppProps): SelectorOption {
  const target: Target = {
    kind: "app",
    projectId: app.projectId,
    appKey: app.appKey,
    master: true,
  };
  return {
    target,
    label: "Master",
    subtitle: null,
    icon: "dashboard",
    search: `master ${app.projectName} ${app.appKey}`.toLowerCase(),
    current: sameTarget(target, props.current),
  };
}

const baseSections = computed<readonly BaseSection[]>(() => {
  const config = props.config;

  if (config.mode === "scope") {
    const sections: BaseSection[] = [];
    if (config.root === "global") {
      sections.push({ heading: null, options: [globalOption()] });
    }
    const options: SelectorOption[] = [];
    for (const project of projects.value) {
      options.push(projectOption(project));
      for (const app of project.apps) {
        options.push(appOption(app, app.projectName));
      }
    }
    if (options.length > 0) {
      sections.push({ heading: "Projects", options });
    }
    return sections;
  }

  if (config.mode === "apps") {
    const fixedProjectId = config.fixedProjectId ?? null;
    const shown =
      fixedProjectId === null
        ? projects.value
        : projects.value.filter((project) => project.id === fixedProjectId);
    const sections: BaseSection[] = [];

    if (fixedProjectId === null) {
      if (config.root === "master") {
        const master = props.catalog?.master ?? null;
        if (master !== null) {
          sections.push({ heading: null, options: [masterOption(master)] });
        }
      } else if (config.root === "all") {
        sections.push({ heading: null, options: [allOption("All applications")] });
      }
    }

    // App keys repeat across projects; show the project as a subtitle only when needed.
    const keyCounts = new Map<string, number>();
    for (const project of shown) {
      for (const app of project.apps) {
        keyCounts.set(app.appKey, (keyCounts.get(app.appKey) ?? 0) + 1);
      }
    }

    for (const project of shown) {
      if (project.apps.length === 0) {
        continue;
      }
      sections.push({
        heading: fixedProjectId === null ? project.name : null,
        options: project.apps.map((app) =>
          appOption(app, (keyCounts.get(app.appKey) ?? 0) > 1 ? app.projectName : null),
        ),
      });
    }
    return sections;
  }

  const sections: BaseSection[] = [{ heading: null, options: [allOption("All projects")] }];
  if (projects.value.length > 0) {
    sections.push({
      heading: "Projects",
      options: projects.value.map((project) => projectOption(project)),
    });
  }
  return sections;
});

const filteredSections = computed<readonly SelectorSection[]>(() => {
  const needle = query.value.trim().toLowerCase();
  const sections: SelectorSection[] = [];
  let index = 0;
  for (const section of baseSections.value) {
    const matched =
      needle.length === 0
        ? section.options
        : section.options.filter((option) => option.search.includes(needle));
    if (matched.length === 0) {
      continue;
    }
    const options = matched.map((option): FlatOption => {
      const flat: FlatOption = { ...option, id: `target-option-${index}`, index };
      index += 1;
      return flat;
    });
    sections.push({
      key: `section-${sections.length}-${section.heading ?? "root"}`,
      heading: section.heading,
      options,
    });
  }
  return sections;
});

const allOptions = computed<readonly FlatOption[]>(() =>
  filteredSections.value.flatMap((section) => section.options),
);
const activeDescendant = computed(() => allOptions.value[activeIndex.value]?.id);

const currentMissing = computed(() => {
  if (!hasCatalog.value) {
    return false;
  }
  return !baseSections.value.some((section) =>
    section.options.some((option) => sameTarget(option.target, props.current)),
  );
});

function moveActive(delta: 1 | -1): void {
  const total = allOptions.value.length;
  if (total === 0) {
    activeIndex.value = -1;
    return;
  }
  const current = activeIndex.value;
  activeIndex.value = current < 0 ? (delta > 0 ? 0 : total - 1) : (current + delta + total) % total;
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveActive(1);
      return;
    case "ArrowUp":
      event.preventDefault();
      moveActive(-1);
      return;
    case "Home":
      event.preventDefault();
      activeIndex.value = allOptions.value.length === 0 ? -1 : 0;
      return;
    case "End":
      event.preventDefault();
      activeIndex.value = allOptions.value.length === 0 ? -1 : allOptions.value.length - 1;
      return;
    case "Enter": {
      event.preventDefault();
      const active = allOptions.value[activeIndex.value];
      if (active !== undefined) {
        selectOption(active);
      }
      return;
    }
    case "Escape":
      event.preventDefault();
      closeMenu();
      return;
    default:
      return;
  }
}

function selectOption(option: SelectorOption): void {
  emit("change", option.target);
  closeMenu();
}

function retry(): void {
  emit("retry");
}

function openMenu(): void {
  if (open.value) {
    return;
  }
  query.value = "";
  open.value = true;
}

function closeMenu(): void {
  if (!open.value) {
    return;
  }
  open.value = false;
}

function onDialogClick(event: MouseEvent): void {
  if (event.target === dialogEl.value) {
    closeMenu();
  }
}

function onDialogClose(): void {
  if (open.value) {
    open.value = false;
  }
}

watch(open, async (isOpen) => {
  const dialog = dialogEl.value;
  if (dialog === null) {
    return;
  }
  if (isOpen) {
    const list = allOptions.value;
    const currentIndex = list.findIndex((option) => sameTarget(option.target, props.current));
    activeIndex.value = currentIndex >= 0 ? currentIndex : list.length > 0 ? 0 : -1;
    if (!dialog.open) {
      dialog.showModal();
    }
    await nextTick();
    searchEl.value?.focus();
  } else {
    if (dialog.open) {
      dialog.close();
    }
    await nextTick();
    triggerEl.value?.focus();
  }
});

watch(query, () => {
  if (!open.value) {
    return;
  }
  activeIndex.value = allOptions.value.length === 0 ? -1 : 0;
});

watch(allOptions, () => {
  if (!open.value) {
    return;
  }
  const total = allOptions.value.length;
  if (total === 0) {
    activeIndex.value = -1;
  } else if (activeIndex.value < 0 || activeIndex.value >= total) {
    activeIndex.value = 0;
  }
});
</script>

<template>
  <button
    ref="triggerEl"
    class="btn btn-secondary target-trigger"
    type="button"
    aria-haspopup="dialog"
    :aria-expanded="open ? 'true' : 'false'"
    :aria-controls="dialogId"
    @click="openMenu"
  >
    <AppIcon :name="currentIcon" class-name="target-trigger__glyph" />
    <span class="target-trigger__label">{{ currentLabel }}</span>
    <AppIcon name="chevron-down" class-name="target-trigger__chevron" />
  </button>

  <dialog
    ref="dialogEl"
    :id="dialogId"
    class="dialog target-dialog"
    aria-modal="true"
    aria-label="Choose target"
    @cancel.prevent="closeMenu"
    @close="onDialogClose"
    @click="onDialogClick"
    @keydown.esc.prevent="closeMenu"
  >
    <div class="dialog__frame target-dialog__frame">
      <div class="target-search">
        <AppIcon name="search" class="target-search__icon" />
        <input
          ref="searchEl"
          :id="searchId"
          v-model="query"
          class="target-search__input"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search targets"
          aria-autocomplete="list"
          aria-expanded="true"
          :aria-controls="listboxId"
          :aria-activedescendant="activeDescendant"
          @keydown="onKeydown"
        >
      </div>

      <p v-if="currentMissing" class="target-current" data-target-current-missing>
        <AppIcon name="alert-triangle" />
        Current target is not in the catalog
      </p>

      <p v-if="loading === true" class="target-empty" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        Loading targets…
      </p>

      <div v-else-if="hasError" class="target-empty target-empty--error" role="alert">
        <p class="target-empty__message">{{ error }}</p>
        <button class="btn btn-secondary btn-sm" type="button" @click="retry">
          <AppIcon name="refresh" />
          Retry
        </button>
      </div>

      <p v-else-if="!hasCatalog" class="target-empty" data-target-empty>No targets available.</p>

      <p v-else-if="query.trim().length > 0 && allOptions.length === 0" class="target-empty">
        No matching targets.
      </p>

      <p v-else-if="allOptions.length === 0" class="target-empty" data-target-empty>
        No targets available.
      </p>

      <div :id="listboxId" class="target-list" role="listbox" aria-label="Targets">
        <template v-for="section in filteredSections" :key="section.key">
          <div
            v-if="section.heading !== null"
            class="target-group"
            role="presentation"
            aria-hidden="true"
          >
            {{ section.heading }}
          </div>
          <button
            v-for="option in section.options"
            :id="option.id"
            :key="targetKey(option.target)"
            class="target-option"
            type="button"
            role="option"
            :aria-selected="option.current ? 'true' : 'false'"
            @click="selectOption(option)"
          >
            <AppIcon :name="option.icon" class="target-option__icon" />
            <span class="target-option__body">
              <span class="target-option__label">{{ option.label }}</span>
              <span v-if="option.subtitle !== null" class="target-option__subtitle">
                {{ option.subtitle }}
              </span>
            </span>
            <AppIcon v-if="option.current" name="check" class="target-option__check" />
          </button>
        </template>
      </div>
    </div>
  </dialog>
</template>
