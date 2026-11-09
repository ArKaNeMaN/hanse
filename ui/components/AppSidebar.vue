<script setup lang="ts">
import { computed } from "vue";
import type { ChromeProject } from "../boot.js";
import { useChromeStore } from "../stores/chrome.js";
import { useThemeStore } from "../stores/theme.js";
import AppIcon from "./AppIcon.vue";
import SmartLink from "./SmartLink.vue";

const chrome = useChromeStore();
const theme = useThemeStore();

const data = computed(() => chrome.current);
const operator = computed(() => chrome.operator);

const projects = computed<readonly ChromeProject[]>(() => {
  const all = data.value?.projects ?? [];
  let shown = all.slice(0, 6);
  const activeId = data.value?.activeProjectId;
  if (activeId !== undefined && !shown.some((project) => project.id === activeId)) {
    const active = all.filter((project) => project.id === activeId);
    const rest = all.filter((project) => project.id !== activeId);
    shown = [...active, ...rest.slice(0, Math.max(0, 6 - active.length))];
  }
  return shown;
});

function isActive(navId: string): boolean {
  return data.value?.active === navId;
}

function projectHref(id: string): string {
  return `/projects/${encodeURIComponent(id)}`;
}
</script>

<template>
  <Teleport to="#sidebar">
    <div v-if="data !== undefined" class="sidebar__head">
      <a class="wordmark" href="/">hanse</a>
      <span class="sidebar__kicker">coordinator</span>
      <button
        class="btn btn-ghost btn-icon btn-sm sidebar__close"
        type="button"
        data-nav-close
        aria-label="Close navigation"
      >
        <AppIcon name="x" />
      </button>
    </div>
    <nav
      v-if="data !== undefined"
      class="sidebar__nav"
      id="sidebar-nav"
      aria-label="Workspace"
      :data-nav-id="data.active"
      :data-project-id="data.activeProjectId"
    >
      <p class="nav-label">Workbench</p>
      <SmartLink
        class="nav-item"
        :class="{ 'is-active': isActive('overview') }"
        to="/"
        data-nav-id="overview"
        :aria-current="isActive('overview') ? 'page' : undefined"
      >
        <AppIcon name="dashboard" />
        <span class="nav-item__label">Overview</span>
        <span v-if="isActive('overview')" class="nav-item__mark">
          <AppIcon name="check" class-name="icon--sm" />
        </span>
      </SmartLink>
      <SmartLink
        class="nav-item"
        :class="{ 'is-active': isActive('projects') }"
        to="/projects"
        data-nav-id="projects"
        :aria-current="isActive('projects') ? 'page' : undefined"
      >
        <AppIcon name="folder" />
        <span class="nav-item__label">Projects</span>
        <span v-if="isActive('projects')" class="nav-item__mark">
          <AppIcon name="check" class-name="icon--sm" />
        </span>
      </SmartLink>
      <SmartLink
        class="nav-item"
        :to="data.masterHref"
        data-nav-id="master"
        :aria-current="undefined"
      >
        <AppIcon name="gauge" />
        <span class="nav-item__label">Master</span>
      </SmartLink>
      <SmartLink
        class="nav-item"
        :class="{ 'is-active': isActive('handoffs') }"
        to="/handoffs"
        data-nav-id="handoffs"
        :aria-current="isActive('handoffs') ? 'page' : undefined"
      >
        <AppIcon name="branch" />
        <span class="nav-item__label">Handoffs</span>
        <span v-if="isActive('handoffs')" class="nav-item__mark">
          <AppIcon name="check" class-name="icon--sm" />
        </span>
        <span class="nav-item__count">{{ data.pendingCount }}</span>
      </SmartLink>
      <SmartLink
        class="nav-item"
        :class="{ 'is-active': isActive('skills') }"
        :to="data.skillsHref ?? '/skills'"
        data-nav-id="skills"
        :aria-current="isActive('skills') ? 'page' : undefined"
      >
        <AppIcon name="code" />
        <span class="nav-item__label">Skills</span>
        <span v-if="isActive('skills')" class="nav-item__mark">
          <AppIcon name="check" class-name="icon--sm" />
        </span>
      </SmartLink>
      <SmartLink
        class="nav-item"
        :class="{ 'is-active': isActive('settings') }"
        :to="data.settingsHref ?? '/settings'"
        data-nav-id="settings"
        :aria-current="isActive('settings') ? 'page' : undefined"
      >
        <AppIcon name="settings" />
        <span class="nav-item__label">Settings</span>
        <span v-if="isActive('settings')" class="nav-item__mark">
          <AppIcon name="check" class-name="icon--sm" />
        </span>
      </SmartLink>
      <SmartLink
        class="nav-item"
        :class="{ 'is-active': isActive('ssh') }"
        to="/ssh"
        data-nav-id="ssh"
        :aria-current="isActive('ssh') ? 'page' : undefined"
      >
        <AppIcon name="terminal" />
        <span class="nav-item__label">SSH</span>
        <span v-if="isActive('ssh')" class="nav-item__mark">
          <AppIcon name="check" class-name="icon--sm" />
        </span>
        <span class="nav-item__count">{{ data.sshPendingCount }}</span>
      </SmartLink>

      <p class="nav-label">Projects</p>
      <SmartLink
        v-for="project in projects"
        :key="project.id"
        class="nav-item"
        :class="{ 'is-active': data.activeProjectId === project.id }"
        :to="projectHref(project.id)"
        :data-project-id="project.id"
        :aria-current="data.activeProjectId === project.id ? 'page' : undefined"
      >
        <AppIcon name="folder" />
        <span class="nav-item__label">{{ project.name }}</span>
        <span v-if="data.activeProjectId === project.id" class="nav-item__mark">
          <AppIcon name="check" class-name="icon--sm" />
        </span>
        <span class="nav-item__count">{{ project.appCount }}</span>
      </SmartLink>
      <SmartLink class="nav-item" to="/projects" data-nav-id="projects" :aria-current="undefined">
        <AppIcon name="layers" />
        <span class="nav-item__label">All projects</span>
      </SmartLink>
    </nav>
    <div v-if="data !== undefined" class="sidebar__foot">
      <span class="avatar avatar--sm">{{ operator?.initials ?? "OP" }}</span>
      <span class="sidebar__operator">{{ operator?.name ?? "Operator" }}</span>
      <button
        class="btn btn-ghost btn-sm theme-toggle"
        type="button"
        data-theme-toggle
        :aria-label="theme.ariaLabel"
        title="Switch theme"
        @click="theme.toggle()"
      >
        <span class="theme-toggle__icon" data-theme-icon="light"><AppIcon name="sun" /></span>
        <span class="theme-toggle__icon" data-theme-icon="dark"><AppIcon name="moon" /></span>
        <span data-theme-label>{{ theme.label }}</span>
      </button>
      <form method="post" action="/logout">
        <button
          class="btn btn-ghost btn-icon btn-sm"
          type="submit"
          aria-label="Sign out"
          title="Sign out"
        >
          <AppIcon name="log-out" />
        </button>
      </form>
    </div>
  </Teleport>
</template>
