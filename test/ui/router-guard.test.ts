import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { isLegacyRetired, ROUTES } from "../../src/shared/routes.js";
import { router as appRouter, createSpaNavigationGuard } from "../../ui/router.js";
import { installSpaRoutes } from "../../ui/spa-routes.js";

function testRouter(guardLoad?: (path: string) => void) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "overview", component: { template: "<div />" } },
      { path: "/projects", name: "projects", component: { template: "<div />" } },
      {
        path: "/chat",
        name: "chat",
        component: { template: "<div />" },
        meta: { workspace: "chat", legacyRetired: false },
      },
      {
        path: "/terminal",
        name: "terminal",
        component: { template: "<div />" },
        meta: { workspace: "terminal", legacyRetired: true },
      },
      {
        path: "/:pathMatch(.*)*",
        name: "not-implemented",
        component: { template: "<div />" },
      },
    ],
  });
  if (guardLoad !== undefined) {
    router.beforeEach(createSpaNavigationGuard({ load: guardLoad }));
  }
  return router;
}

beforeEach(() => {
  installSpaRoutes(["overview", "projects"]);
});

describe("SPA navigation guard", () => {
  it("full-document-loads an off-set path", async () => {
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/chat");
    expect(load).toHaveBeenCalledWith("/chat");
  });

  it("full-document-loads a path that is not a page route", async () => {
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/api/projects");
    expect(load).toHaveBeenCalledWith("/api/projects");
  });

  it("full-document-loads ?legacy=1 for a non-retired route", async () => {
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/projects?legacy=1");
    expect(load).toHaveBeenCalledWith("/projects?legacy=1");
  });

  it("allows an enabled route and ignores ?legacy=1 once retired", async () => {
    installSpaRoutes(["overview", "projects", "terminal"]);
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/terminal?legacy=1");
    expect(load).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe("/terminal");
  });

  it("covers direct reload and programmatic navigation", async () => {
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/projects");
    expect(load).toHaveBeenCalledTimes(0);
    await router.push({ name: "chat", query: { app: "web", project: "p" } });
    expect(load).toHaveBeenCalledWith("/chat?app=web&project=p");
  });

  it("keeps records and legacyRetired metadata consistent with the registry", () => {
    const bootIds = ROUTES.filter((route) => route.spa).map((route) => route.id);
    for (const id of bootIds) {
      expect(appRouter.hasRoute(id), id).toBe(true);
      const record = appRouter.getRoutes().find((route) => route.name === id);
      expect(record?.meta.legacyRetired ?? false, id).toBe(isLegacyRetired(id));
    }
    expect(appRouter.hasRoute("chat")).toBe(false);
    expect(appRouter.hasRoute("terminal")).toBe(false);
    expect(isLegacyRetired("chat")).toBe(false);
    expect(isLegacyRetired("terminal")).toBe(false);
  });
});
