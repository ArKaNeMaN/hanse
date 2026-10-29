import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

/**
 * Only routes whose registry `spa` flag is enabled are registered here. Phase 1B registered
 * `/projects`; Phase 2B adds the fleet overview at `/`; Phase 2C adds project detail at
 * `/projects/:id`. Every other route stays a server-rendered document and is reached with a full
 * document load (including `/projects/:id/apps/:app`).
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
    path: "/projects/:id",
    name: "project",
    component: () => import("./pages/ProjectPage.vue"),
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
