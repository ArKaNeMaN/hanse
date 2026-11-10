import { describe, expect, it, vi } from "vitest";
import { routeById } from "../../src/shared/routes.js";
import { createSpaNavigationGuard, router } from "../../ui/router.js";

describe("terminal and chat route records", () => {
  it("registers the lazy /terminal page with workspace metadata", () => {
    expect(router.hasRoute("terminal")).toBe(true);
    const record = router.getRoutes().find((route) => route.name === "terminal");
    expect(record?.path).toBe("/terminal");
    expect(record?.meta.workspace).toBe("terminal");
    expect(typeof record?.components?.default).toBe("function");
    expect(routeById("terminal")).toMatchObject({ path: "/terminal", nav: "project" });
  });

  it("registers the chat route with workspace metadata", () => {
    expect(router.hasRoute("chat")).toBe(true);
    const record = router.getRoutes().find((route) => route.name === "chat");
    expect(record?.path).toBe("/chat");
    expect(record?.meta.workspace).toBe("chat");
    expect(typeof record?.components?.default).toBe("function");
    expect(routeById("chat")).toMatchObject({ path: "/chat", nav: "none" });
  });

  it("allows known workspace routes and page-like unknown paths", () => {
    const load = vi.fn();
    const guard = createSpaNavigationGuard({ load });
    expect(
      guard({
        path: "/terminal",
        fullPath: "/terminal?app=alpha&project=p",
        query: { app: "alpha", project: "p" },
        meta: {},
      } as never),
    ).toBe(true);
    expect(
      guard({
        path: "/chat",
        fullPath: "/chat?app=alpha&project=p",
        query: { app: "alpha", project: "p" },
        meta: {},
      } as never),
    ).toBe(true);
    expect(
      guard({
        path: "/nope",
        fullPath: "/nope",
        query: {},
        meta: {},
        name: "not-found",
      } as never),
    ).toBe(true);
    expect(
      guard({
        path: "/api/projects",
        fullPath: "/api/projects",
        query: {},
        meta: {},
        name: "not-found",
      } as never),
    ).toBe(false);
    expect(load).toHaveBeenCalledWith("/api/projects");
  });
});
