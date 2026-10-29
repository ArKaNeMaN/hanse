import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

/**
 * Only routes whose registry `spa` flag is enabled are registered here. Phase 1B registers the
 * first cutover, `/projects`; every other route stays a server-rendered document and is reached
 * with a full document load.
 */
const routes: readonly RouteRecordRaw[] = [
  {
    path: "/projects",
    name: "projects",
    component: () => import("./pages/ProjectsPage.vue"),
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
