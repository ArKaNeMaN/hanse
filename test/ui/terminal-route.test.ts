import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLegacyRetired, isSpaRoute, routeById } from "../../src/shared/routes.js";
import { createSpaNavigationGuard, router } from "../../ui/router.js";
import { installSpaRoutes } from "../../ui/spa-routes.js";

beforeEach(() => {
  installSpaRoutes(["projects", "terminal"]);
});

describe("terminal route record", () => {
  it("registers the lazy /terminal page with workspace metadata", () => {
    expect(router.hasRoute("terminal")).toBe(true);
    const record = router.getRoutes().find((route) => route.name === "terminal");
    expect(record?.path).toBe("/terminal");
    expect(record?.meta.workspace).toBe("terminal");
    expect(record?.meta.legacyRetired).toBe(true);
    expect(typeof record?.components?.default).toBe("function");
    expect(routeById("terminal")).toMatchObject({
      path: "/terminal",
      spa: true,
      legacyRetired: true,
    });
  });

  it("registers the chat route with its registry cutover flag on and legacyRetired set", () => {
    expect(router.hasRoute("chat")).toBe(true);
    const record = router.getRoutes().find((route) => route.name === "chat");
    expect(record?.path).toBe("/chat");
    expect(record?.meta.workspace).toBe("chat");
    expect(record?.meta.legacyRetired).toBe(true);
    expect(typeof record?.components?.default).toBe("function");
    expect(isSpaRoute("chat", { env: {} })).toBe(true);
    expect(isLegacyRetired("chat")).toBe(true);
  });

  it("allows terminal when installed and full-document-loads it when off-set", async () => {
    const load = vi.fn();
    const guard = createSpaNavigationGuard({ load });
    const allowed = guard({
      path: "/terminal",
      fullPath: "/terminal?app=alpha&project=p",
      query: { app: "alpha", project: "p" },
      meta: {},
    } as never);
    expect(allowed).toBe(true);

    installSpaRoutes(["projects"]);
    const blocked = guard({
      path: "/terminal",
      fullPath: "/terminal?app=alpha&project=p",
      query: { app: "alpha", project: "p" },
      meta: {},
    } as never);
    expect(blocked).toBe(false);
    expect(load).toHaveBeenCalledWith("/terminal?app=alpha&project=p");
  });

  it("ignores ?legacy=1 because terminal is retired", () => {
    const load = vi.fn();
    const guard = createSpaNavigationGuard({ load });
    expect(
      guard({
        path: "/terminal",
        fullPath: "/terminal?legacy=1",
        query: { legacy: "1" },
        meta: {},
      } as never),
    ).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
});
