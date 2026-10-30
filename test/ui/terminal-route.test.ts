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
    expect(record?.meta.legacyRetired).toBe(false);
    expect(typeof record?.components?.default).toBe("function");
    expect(routeById("terminal")).toMatchObject({
      path: "/terminal",
      spa: true,
      legacyRetired: false,
    });
  });

  it("does not register a chat route in this stage", () => {
    expect(router.hasRoute("chat")).toBe(false);
    expect(isSpaRoute("chat", { env: {} })).toBe(false);
    expect(isLegacyRetired("chat")).toBe(false);
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

  it("full-document-loads ?legacy=1 because terminal is not retired", () => {
    const load = vi.fn();
    const guard = createSpaNavigationGuard({ load });
    expect(
      guard({
        path: "/terminal",
        fullPath: "/terminal?legacy=1",
        query: { legacy: "1" },
        meta: {},
      } as never),
    ).toBe(false);
    expect(load).toHaveBeenCalledWith("/terminal?legacy=1");
  });
});
