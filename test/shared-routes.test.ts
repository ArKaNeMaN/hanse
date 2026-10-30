import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLegacyRetired,
  isSpaPath,
  isSpaPathIn,
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

  it("publishes the complete route table and cuts every route over by Stage 7C", () => {
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
      ["terminal", "/terminal", "project"],
      ["chat", "/chat", "none"],
    ]);
    expect(ROUTES.filter((route) => route.spa).map((route) => route.id)).toEqual([
      "projects",
      "overview",
      "handoffs",
      "ssh",
      "settings-global",
      "skills-global",
      "skills-new",
      "skills-detail",
      "settings-project",
      "settings-app",
      "skills-project",
      "skills-app",
      "app",
      "project",
      "terminal",
      "chat",
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
    expect(matchPage("/chat")).toEqual({ id: "chat", params: {} });
    expect(matchPage("/terminal")).toEqual({ id: "terminal", params: {} });
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

  it("matches the chat and terminal page paths but never API, asset, IDE, preview, or upgrade paths", () => {
    expect(matchPage("/chat")).toEqual({ id: "chat", params: {} });
    expect(matchPage("/terminal")).toEqual({ id: "terminal", params: {} });
    for (const pathname of [
      "/api/projects",
      "/api/ui/projects",
      "/assets/app.js",
      "/ide/",
      "/preview/p/a/key",
      "/projects/p/apps/a/git/status",
      "/api/apps/a/terminal",
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
      const migrated =
        route.id === "projects" ||
        route.id === "overview" ||
        route.id === "project" ||
        route.id === "handoffs" ||
        route.id === "ssh" ||
        route.id === "settings-global" ||
        route.id === "settings-project" ||
        route.id === "settings-app" ||
        route.id === "skills-global" ||
        route.id === "skills-project" ||
        route.id === "skills-app" ||
        route.id === "skills-new" ||
        route.id === "skills-detail" ||
        route.id === "app" ||
        route.id === "terminal" ||
        route.id === "chat";
      expect(isSpaRoute(route.id, { env: {} }), route.id).toBe(migrated);
    }
    expect(isSpaPath("/projects", { env: {} })).toBe(true);
    expect(isSpaPath("/", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha/apps/web", { env: {} })).toBe(true);
    expect(isSpaPath("/handoffs", { env: {} })).toBe(true);
    expect(isSpaPath("/ssh", { env: {} })).toBe(true);
    expect(isSpaPath("/settings", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha/settings", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha/apps/web/settings", { env: {} })).toBe(true);
    expect(isSpaPath("/skills", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha/skills", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha/apps/web/skills", { env: {} })).toBe(true);
    expect(isSpaPath("/skills/new", { env: {} })).toBe(true);
    expect(isSpaPath("/skills/42", { env: {} })).toBe(true);
    expect(isSpaPath("/projects/alpha/apps/web", { env: {} })).toBe(true);
    expect(isSpaPath("/chat", { env: {} })).toBe(true);
    expect(isSpaPath("/terminal", { env: {} })).toBe(true);
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
    expect(routeById("chat")).toMatchObject({
      path: "/chat",
      nav: "none",
      spa: true,
      legacyRetired: false,
    });
    expect(routeById("terminal")).toMatchObject({
      path: "/terminal",
      nav: "project",
      spa: true,
      legacyRetired: false,
    });
    expect(routeById("nope" as never)).toBeUndefined();
  });

  it("keeps chat and terminal in the default boot set while the rollback flags remain live", () => {
    const bootRoutes = ROUTES.filter((route) =>
      isSpaRoute(route.id, { env: {}, manifestValid: true }),
    ).map((route) => route.id);
    expect(bootRoutes).toContain("chat");
    expect(bootRoutes).toContain("terminal");
    expect(bootRoutes).toContain("projects");
    expect(isSpaRoute("chat", { env: { legacy: "1" } })).toBe(false);
    expect(isSpaRoute("chat", { env: { spaRoutes: "" } })).toBe(false);
  });

  it("reports legacyRetired false by default and for the new ids in this stage", () => {
    expect(isLegacyRetired("projects")).toBe(false);
    expect(isLegacyRetired("chat")).toBe(false);
    expect(isLegacyRetired("terminal")).toBe(false);
    expect(isLegacyRetired("nope" as never)).toBe(false);
  });

  it("checks SPA path membership against the resolved boot set", () => {
    const ids = new Set<"projects" | "chat">(["projects", "chat"]);
    expect(isSpaPathIn("/projects", ids)).toBe(true);
    expect(isSpaPathIn("/chat", ids)).toBe(true);
    expect(isSpaPathIn("/terminal", ids)).toBe(false);
    expect(isSpaPathIn("/api/projects", ids)).toBe(false);
    expect(isSpaPathIn("/projects", ["projects"] as const)).toBe(true);
  });
});
