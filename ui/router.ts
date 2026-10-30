import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteRecordRaw,
} from "vue-router";
import { isLegacyRetired, matchPage } from "../src/shared/routes.js";
import { installedSpaRoutes } from "./spa-routes.js";

declare module "vue-router" {
  interface RouteMeta {
    /** Marks a chat/terminal workspace route for shell and focus behavior. */
    workspace?: "chat" | "terminal";
    /** Client mirror of the shared route `legacyRetired` flag. */
    legacyRetired?: boolean;
  }
}

/**
 * Only routes whose registry `spa` flag is enabled are registered here. Phase 1B registered
 * `/projects`; Phase 2B adds the fleet overview at `/`; Phase 2C adds project detail at
 * `/projects/:id`; Phase 3B adds the handoff inbox at `/handoffs`; Phase 4B adds the SSH console
 * at `/ssh`; Phase 6B adds the five skills routes; Phase 7C registers the application-detail route;
 * Stage 2 of the chat/terminal migration registers `/terminal`; Stage 3B registers `/chat` as a
 * read-only workspace behind the test-only allowlist. The registry `spa` flag for chat stays false
 * until the Stage 7C cutover, so the route record is inert unless the server boot set includes it.
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
    path: "/terminal",
    name: "terminal",
    component: () => import("./pages/TerminalPage.vue"),
    meta: { workspace: "terminal", legacyRetired: false },
  },
  {
    path: "/chat",
    name: "chat",
    component: () => import("./pages/ChatPage.vue"),
    meta: { workspace: "chat", legacyRetired: false },
  },
  {
    path: "/:pathMatch(.*)*",
    name: "not-implemented",
    component: () => import("./pages/NotImplementedPage.vue"),
  },
];

export interface SpaGuardOptions {
  /** Overridable for tests; a real full-document load by default. */
  readonly load?: (path: string) => void;
}

/**
 * Full-document-load guard for destinations outside the boot route set or explicitly pinned to
 * the legacy renderer. It also catches a server route-set change after a restart.
 */
export function createSpaNavigationGuard(options: SpaGuardOptions = {}) {
  const load = options.load ?? ((path: string) => window.location.assign(path));
  return (to: RouteLocationNormalized): boolean => {
    const match = matchPage(to.path);
    if (match === undefined || !installedSpaRoutes().has(match.id)) {
      load(to.fullPath);
      return false;
    }
    const retired = to.meta.legacyRetired === true || isLegacyRetired(match.id);
    if (to.query.legacy === "1" && !retired) {
      load(to.fullPath);
      return false;
    }
    return true;
  };
}

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

router.beforeEach(createSpaNavigationGuard());
