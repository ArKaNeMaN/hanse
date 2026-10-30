import { describe, expect, it } from "vitest";
import { appShell, documentPage, loginPage, type ShellOptions } from "../../src/http/ui.js";

function shellOptions(overrides: Partial<ShellOptions> = {}): ShellOptions {
  return {
    title: "Projects",
    active: "projects",
    activeProjectId: "alpha",
    breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Projects" }],
    projects: [{ id: "alpha", name: "Alpha", appCount: 2 }],
    pendingCount: 1,
    sshPendingCount: 0,
    operatorName: "alice",
    header: "<h1>Projects</h1>",
    body: "<p>Body</p>",
    ...overrides,
  };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("shell script matrix", () => {
  it("loads app.js and app-content.js on legacy pages in that order", () => {
    const html = documentPage({ title: "Legacy", body: '<main id="main"></main>' });
    expect(html).toContain('<script src="/assets/app.js" defer></script>');
    expect(html).toContain('<script src="/assets/app-content.js" defer></script>');
    expect(html.indexOf("/assets/app.js")).toBeLessThan(html.indexOf("/assets/app-content.js"));
  });

  it("omits the content script only when contentScript is false", () => {
    const html = documentPage({
      title: "Shell only",
      body: '<main id="main"></main>',
      contentScript: false,
    });
    expect(html).toContain('<script src="/assets/app.js" defer></script>');
    expect(html).not.toContain("/assets/app-content.js");
  });

  it("loads both scripts on the login page", () => {
    const html = loginPage({ next: "/projects" });
    expect(html).toContain('<script src="/assets/app.js" defer></script>');
    expect(html).toContain('<script src="/assets/app-content.js" defer></script>');
  });

  it("keeps extra page scripts after the shell scripts", () => {
    const html = appShell(shellOptions({ scripts: ["/assets/settings.js"] }));
    expect(html.indexOf("/assets/app.js")).toBeLessThan(html.indexOf("/assets/app-content.js"));
    expect(html.indexOf("/assets/app-content.js")).toBeLessThan(
      html.indexOf("/assets/settings.js"),
    );
  });
});

describe("shell chrome fragments", () => {
  it("emits exactly one nav for the sidebar and one for the breadcrumb", () => {
    const html = appShell(shellOptions());
    expect(count(html, "<nav")).toBe(2);
    expect(count(html, 'id="sidebar-nav"')).toBe(1);
    expect(count(html, 'id="breadcrumb-host"')).toBe(1);
    expect(count(html, 'aria-label="Workspace"')).toBe(1);
    expect(count(html, 'aria-label="Breadcrumb"')).toBe(1);
  });

  it("emits the route announcer once", () => {
    const html = appShell(shellOptions());
    expect(count(html, 'id="route-announcer"')).toBe(1);
    expect(html).toContain('aria-live="polite"');
  });

  it("marks the active nav, project, and nav ids", () => {
    const html = appShell(shellOptions());
    expect(html).toContain('id="shell" data-nav-id="projects" data-project-id="alpha"');
    expect(html).toContain('data-nav-id="projects"');
    expect(html).toContain('data-project-id="alpha"');
    expect(html).toContain('aria-current="page"');
  });

  it("keeps the breadcrumb inner free of a nested nav", () => {
    const html = appShell(shellOptions());
    const breadcrumb = html.slice(
      html.indexOf('id="breadcrumb-host"'),
      html.indexOf("</nav>", html.indexOf('id="breadcrumb-host"')),
    );
    expect(breadcrumb).not.toContain("<nav");
    expect(breadcrumb).toContain("Workbench");
    expect(breadcrumb).toContain("Projects");
  });
});
