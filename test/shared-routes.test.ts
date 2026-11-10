import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPagePath,
  isPublicRoute,
  matchPage,
  ROUTES,
  routeById,
  routeKey,
} from "../src/shared/routes.js";

const SOURCE = path.join(process.cwd(), "src/shared/routes.ts");

describe("shared route manifest", () => {
  it("has no node: imports so the client can bundle it", () => {
    const source = readFileSync(SOURCE, "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(["']node:/);
  });

  it("publishes the complete route table", () => {
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
      ["login", "/login", "none"],
      ["not-found", "*", "none"],
    ]);
    expect(ROUTES.filter((route) => route.synthetic === true).map((route) => route.id)).toEqual([
      "not-found",
    ]);
  });

  it("matches every concrete route path and decodes parameters", () => {
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
    expect(matchPage("/login")).toEqual({ id: "login", params: {} });
    expect(matchPage("/not-found")).toBeUndefined();
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

  it("never matches API, asset, IDE, preview, internal, health, or unknown paths", () => {
    for (const pathname of [
      "/api/projects",
      "/api/ui/projects",
      "/assets/app.js",
      "/ide/",
      "/preview/p/a/k",
      "/internal/mcp",
      "/healthz",
      "/readyz",
      "/nope",
      "/projects/p/apps/my.app/extra",
    ]) {
      expect(matchPage(pathname), pathname).toBeUndefined();
    }
  });

  it("keeps login public and exposes the synthetic not-found route by id", () => {
    expect(isPublicRoute("login")).toBe(true);
    expect(isPublicRoute("projects")).toBe(false);
    expect(routeById("not-found")).toMatchObject({ synthetic: true, label: "Page not found" });
  });

  it("classifies page-like paths without hiding dotted app keys", () => {
    expect(isPagePath("/projects/p/apps/my.app")).toBe(true);
    expect(isPagePath("/nope")).toBe(true);
    expect(isPagePath("/api/projects")).toBe(false);
    expect(isPagePath("/assets/app.css")).toBe(false);
    expect(isPagePath("/ide/")).toBe(false);
    expect(isPagePath("/preview/p/a/k")).toBe(false);
    expect(isPagePath("/internal/mcp")).toBe(false);
    expect(isPagePath("/healthz")).toBe(false);
    expect(isPagePath("/readyz")).toBe(false);
    expect(isPagePath("/app.js")).toBe(false);
  });
});

describe("routeKey", () => {
  it("normalizes params and query, excluding notice, tone, and session", () => {
    expect(
      routeKey(
        "chat",
        { app: "alpha", project: "p" },
        {
          z: "last",
          a: "first",
          notice: "hello",
          tone: "error",
          session: "s1",
          empty: "",
          dropped: undefined,
        },
      ),
    ).toBe(
      JSON.stringify([
        "chat",
        [
          ["app", "alpha"],
          ["project", "p"],
        ],
        [
          ["a", "first"],
          ["empty", ""],
          ["z", "last"],
        ],
      ]),
    );
  });

  it("keeps legacy as a normal query key", () => {
    expect(routeKey("chat", {}, { legacy: "1" })).toBe(
      JSON.stringify(["chat", [], [["legacy", "1"]]]),
    );
  });

  it("is stable regardless of insertion order", () => {
    expect(routeKey("project", { id: "p" }, { b: "2", a: "1" })).toBe(
      routeKey("project", { id: "p" }, { a: "1", b: "2" }),
    );
  });
});
