import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

/**
 * Only routes whose registry `spa` flag is enabled are registered here. Phase 1B registered
 * `/projects`; Phase 2B adds the fleet overview at `/`; Phase 2C adds project detail at
 * `/projects/:id`; Phase 3B adds the handoff inbox at `/handoffs`; Phase 4B adds the SSH console
 * at `/ssh`; Phase 6B adds the five skills routes; Phase 7A registers the application-detail route
 * for the `HANSE_UI_SPA_ROUTES=app` preview while the registry keeps `app` legacy by default. Every
 * other route stays a server-rendered document and is reached with a full document load.
 */
const routes: readonly RouteRecordRaw[] = [
  {
    path: "/",
    name: "overview",
    component: () => import("./pages/OverviewPage.vue"),
  },
  {
    path: "/projects",
    name: "projects",
    component: () => import("./pages/ProjectsPage.vue"),
  },
  {
    path: "/projects/:id/apps/:app",
    name: "app",
    component: () => import("./pages/AppPage.vue"),
  },
  {
    path: "/projects/:id/apps/:app/settings",
    name: "settings-app",
    component: () => import("./pages/SettingsPage.vue"),
  },
  {
    path: "/projects/:id/settings",
    name: "settings-project",
    component: () => import("./pages/SettingsPage.vue"),
  },
  {
    path: "/projects/:id/apps/:app/skills",
    name: "skills-app",
    component: () => import("./pages/SkillsPage.vue"),
  },
  {
    path: "/projects/:id/skills",
    name: "skills-project",
    component: () => import("./pages/SkillsPage.vue"),
  },
  {
    path: "/skills",
    name: "skills-global",
    component: () => import("./pages/SkillsPage.vue"),
  },
  {
    path: "/skills/new",
    name: "skills-new",
    component: () => import("./pages/SkillsPage.vue"),
  },
  {
    path: "/skills/:id",
    name: "skills-detail",
    component: () => import("./pages/SkillDetailPage.vue"),
  },
  {
    path: "/projects/:id",
    name: "project",
    component: () => import("./pages/ProjectPage.vue"),
  },
  {
    path: "/settings",
    name: "settings-global",
    component: () => import("./pages/SettingsPage.vue"),
  },
  {
    path: "/handoffs",
    name: "handoffs",
    component: () => import("./pages/HandoffsPage.vue"),
  },
  {
    path: "/ssh",
    name: "ssh",
    component: () => import("./pages/SshPage.vue"),
  },
  {
    path: "/:pathMatch(.*)*",
    name: "not-implemented",
    component: () => import("./pages/NotImplementedPage.vue"),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(_to, _from, savedPosition) {
    // `.page` is the scroll container, not the window.
    if (savedPosition !== null) {
      return { el: ".page", left: savedPosition.left, top: savedPosition.top };
    }
    return { el: ".page", left: 0, top: 0 };
  },
});
