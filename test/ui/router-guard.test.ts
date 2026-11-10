import { describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { ROUTES } from "../../src/shared/routes.js";
import { router as appRouter, createSpaNavigationGuard } from "../../ui/router.js";

function testRouter(guardLoad?: (path: string) => void) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "overview", component: { template: "<div />" } },
      { path: "/projects", name: "projects", component: { template: "<div />" } },
      { path: "/chat", name: "chat", component: { template: "<div />" } },
      {
        path: "/:pathMatch(.*)*",
        name: "not-found",
        component: { template: "<div />" },
      },
    ],
  });
  if (guardLoad !== undefined) {
    router.beforeEach(createSpaNavigationGuard({ load: guardLoad }));
  }
  return router;
}

describe("SPA navigation guard", () => {
  it("allows known page routes", async () => {
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/projects");
    expect(load).not.toHaveBeenCalled();
  });

  it("allows a page-like unknown path to render the catch-all", async () => {
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/nope");
    expect(load).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe("not-found");
  });

  it("full-document-loads a non-page path", async () => {
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/api/projects");
    expect(load).toHaveBeenCalledWith("/api/projects");
  });

  it("treats ?legacy=1 as a normal query parameter", async () => {
    const load = vi.fn();
    const router = testRouter(load);
    await router.push("/projects?legacy=1");
    expect(load).not.toHaveBeenCalled();
    expect(router.currentRoute.value.query.legacy).toBe("1");
  });

  it("keeps every non-synthetic registry route registered in the app router", () => {
    for (const route of ROUTES.filter((entry) => entry.synthetic !== true)) {
      expect(appRouter.hasRoute(route.id), route.id).toBe(true);
    }
    expect(appRouter.hasRoute("not-found")).toBe(true);
  });
});
