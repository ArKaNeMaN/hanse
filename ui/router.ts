import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteRecordRaw,
} from "vue-router";
import { isPagePath, matchPage } from "../src/shared/routes.js";

declare module "vue-router" {
  interface RouteMeta {
    /** Marks a chat/terminal workspace route for shell and focus behavior. */
    workspace?: "chat" | "terminal";
  }
}

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
    path: "/terminal",
    name: "terminal",
    component: () => import("./pages/TerminalPage.vue"),
    meta: { workspace: "terminal" },
  },
  {
    path: "/chat",
    name: "chat",
    component: () => import("./pages/ChatPage.vue"),
    meta: { workspace: "chat" },
  },
  {
    path: "/login",
    name: "login",
    component: () => import("./pages/LoginPage.vue"),
  },
  {
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: () => import("./pages/NotFoundPage.vue"),
  },
];

export interface SpaGuardOptions {
  /** Overridable for tests; a real full-document load by default. */
  readonly load?: (path: string) => void;
}

export function createSpaNavigationGuard(options: SpaGuardOptions = {}) {
  const load = options.load ?? ((path: string) => window.location.assign(path));
  return (to: RouteLocationNormalized): boolean => {
    const match = matchPage(to.path);
    if (match !== undefined) {
      return true;
    }
    if (to.name === "not-found" && isPagePath(to.path)) {
      return true;
    }
    load(to.fullPath);
    return false;
  };
}

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, _from, savedPosition) {
    // Chat/terminal own their inner scroll container, so the router must not scroll `.page`.
    if (to.meta.workspace === "chat" || to.meta.workspace === "terminal") {
      return false;
    }
    // `.page` is the scroll container, not the window.
    if (savedPosition !== null) {
      return { el: ".page", left: savedPosition.left, top: savedPosition.top };
    }
    return { el: ".page", left: 0, top: 0 };
  },
});

router.beforeEach(createSpaNavigationGuard());
