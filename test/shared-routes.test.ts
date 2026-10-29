import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSpaPath,
  isSpaRoute,
  matchPage,
  parseSpaAllowlist,
  ROUTES,
  routeById,
} from "../src/shared/routes.js";

const SOURCE = path.join(process.cwd(), "src/shared/routes.ts");

describe("shared route manifest", () => {
  it("has no node: imports so the client can bundle it", () => {
    const source = readFileSync(SOURCE, "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(["']node:/);
  });

  it("publishes the complete route table and cuts projects, overview, and project over", () => {
    expect(ROUTES.map((route) => [route.id, route.path, route.nav])).toEqual([
      ["projects", "/projects", "projects"],
      ["overview", "/", "overview"],
      ["handoffs", "/handoffs", "handoffs"],
      ["ssh", "/ssh", "ssh"],
      ["settings-global", "/settings", "settings"],
      ["skills-global", "/skills", "skills"],
      ["skills-new", "/skills/new", "skills"],
      ["skills-detail", "/skills/:id", "skills"],
      ["settings-project", "/projects/:id/settings", "settings"],
      ["settings-app", "/projects/:id/apps/:app/settings", "settings"],
      ["skills-project", "/projects/:id/skills", "skills"],
      ["skills-app", "/projects/:id/apps/:app/skills", "skills"],
      ["app", "/projects/:id/apps/:app", "project"],
      ["project", "/projects/:id", "project"],
    ]);
    expect(ROUTES.filter((route) => route.spa).map((route) => route.id)).toEqual([
      "projects",
      "overview",
      "project",
    ]);
  });

  it("matches every route path and decodes parameters", () => {
    expect(matchPage("/projects")).toEqual({ id: "projects", params: {} });
    expect(matchPage("/")).toEqual({ id: "overview", params: {} });
    expect(matchPage("/handoffs")).toEqual({ id: "handoffs", params: {} });
    expect(matchPage("/ssh")).toEqual({ id: "ssh", params: {} });
    expect(matchPage("/settings")).toEqual({ id: "settings-global", params: {} });
    expect(matchPage("/skills")).toEqual({ id: "skills-global", params: {} });
    expect(matchPage("/skills/new")).toEqual({ id: "skills-new", params: {} });
    expect(matchPage("/skills/42")).toEqual({ id: "skills-detail", params: { id: "42" } });
    expect(matchPage("/projects/alpha/settings")).toEqual({
      id: "settings-project",
      params: { id: "alpha" },
    });
    expect(matchPage("/projects/alpha/apps/web/settings")).toEqual({
      id: "settings-app",
      params: { id: "alpha", app: "web" },
    });
    expect(matchPage("/projects/alpha/skills")).toEqual({
      id: "skills-project",
      params: { id: "alpha" },
    });
    expect(matchPage("/projects/alpha/apps/web/skills")).toEqual({
      id: "skills-app",
      params: { id: "alpha", app: "web" },
    });
    expect(matchPage("/projects/alpha/apps/web")).toEqual({
      id: "app",
      params: { id: "alpha", app: "web" },
    });
    expect(matchPage("/projects/alpha")).toEqual({ id: "project", params: { id: "alpha" } });
    expect(matchPage("/projects/a%20b")).toEqual({ id: "project", params: { id: "a b" } });
  });

  it("prefers static and longer patterns over dynamic ones", () => {
    expect(matchPage("/skills/new")?.id).toBe("skills-new");
    expect(matchPage("/skills/7")?.id).toBe("skills-detail");
    expect(matchPage("/projects")?.id).toBe("projects");
    expect(matchPage("/projects/p/settings")?.id).toBe("settings-project");
    expect(matchPage("/projects/p/apps/a/settings")?.id).toBe("settings-app");
    expect(matchPage("/projects/p/apps/a/skills")?.id).toBe("skills-app");
    expect(matchPage("/projects/p/apps/a")?.id).toBe("app");
  });

  it("never matches API, asset, chat, terminal, IDE, or preview paths", () => {
    for (const pathname of [
      "/api/projects",
      "/api/ui/projects",
      "/assets/app.js",
      "/chat",
      "/terminal",
      "/ide/",
      "/preview/p/a/key",
      "/projects/p/apps/a/git/status",
    ]) {
      expect(matchPage(pathname), pathname).toBeUndefined();
    }
  });

  it("matches no path with a trailing slash or extra segment", () => {
    expect(matchPage("/projects/")).toBeUndefined();
    expect(matchPage("/projects/p/")).toBeUndefined();
    expect(matchPage("/skills/1/extra")).toBeUndefined();
  });

  it("enables the cut-over routes by default", () => {
    for (const route of ROUTES) {
      const migrated = route.id === "projects" || route.id === "overview" || route.id === "project";
      expect(isSpaRoute(route.id, { env: {} }), route.id).toBe(migrated);
    }
    expect(isSpaPath("/projects", { env: {} })).toBe(true);
    expect(isSpaPath("/", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha/apps/web", { env: {} })).toBe(false);
    expect(isSpaPath("/handoffs", { env: {} })).toBe(false);
  });

  it("applies HANSE_UI_LEGACY and manifest validity before the allowlist", () => {
    expect(isSpaRoute("projects", { env: { legacy: "1", spaRoutes: "projects" } })).toBe(false);
    expect(isSpaRoute("projects", { env: { spaRoutes: "projects" }, manifestValid: false })).toBe(
      false,
    );
    expect(isSpaRoute("projects", { env: { legacy: "0", spaRoutes: "projects" } })).toBe(true);
  });

  it("treats an unset allowlist as the registry flag", () => {
    expect(isSpaRoute("projects", { env: {} })).toBe(true);
    expect(isSpaRoute("projects", { env: { spaRoutes: undefined } })).toBe(true);
    expect(isSpaRoute("overview", { env: {} })).toBe(true);
  });

  it("treats an empty allowlist as all legacy", () => {
    expect(isSpaRoute("projects", { env: { spaRoutes: "" } })).toBe(false);
    expect(isSpaRoute("projects", { env: { spaRoutes: "   " } })).toBe(false);
  });

  it("enables only listed ids and ignores unknown ids", () => {
    const allowlist = { spaRoutes: "projects, overview, not-a-route" };
    expect(isSpaRoute("projects", { env: allowlist })).toBe(true);
    expect(isSpaRoute("overview", { env: allowlist })).toBe(true);
    expect(isSpaRoute("handoffs", { env: allowlist })).toBe(false);
    expect(isSpaRoute("not-a-route" as never, { env: allowlist })).toBe(false);
    expect(parseSpaAllowlist("projects, nope ,overview")).toEqual({
      ids: new Set(["projects", "overview"]),
      unknown: ["nope"],
    });
  });

  it("exposes route metadata by id", () => {
    expect(routeById("app")).toMatchObject({ path: "/projects/:id/apps/:app", nav: "project" });
    expect(routeById("nope" as never)).toBeUndefined();
  });
});
