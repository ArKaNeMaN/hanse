import { describe, expect, it } from "vitest";
import { documentPage, spaShell } from "../../src/http/ui.js";

describe("static document shell", () => {
  it("never loads the retired app.js or app-content.js", () => {
    const html = documentPage({ title: "Static", body: '<main id="main"></main>' });
    expect(html).not.toContain("/assets/app.js");
    expect(html).not.toContain("/assets/app-content.js");
    expect(html).toContain('<link rel="stylesheet" href="/assets/app.css" />');
  });

  it("starts the SPA shell with empty chrome containers", () => {
    const html = spaShell({ pageClass: "page--chat", bodyClass: "page__body--chat" });
    expect(html).toContain('<aside class="sidebar" id="sidebar" aria-label="Primary"></aside>');
    expect(html).toContain('id="breadcrumb-host" aria-label="Breadcrumb" data-nav-id="none"');
    expect(html).toContain('<div class="topbar__actions"></div>');
    expect(html).toContain('id="shell" data-nav-id="none"');
    expect(html).toContain("data-nav-toggle");
    expect(html).toContain("data-nav-close");
    expect(html).toContain('class="skip-link" href="#main"');
    expect(html).toContain('id="route-announcer"');
    expect(html).toContain('id="ui-fallback"');
    expect(html).toContain('href=""');
    expect(html).toContain('id="toast-region"');
    expect(html).toContain('class="page page--chat"');
    expect(html).toContain('class="page__body page__body--chat"');
  });

  it("does not render an undefined class for absent page/body options", () => {
    const html = spaShell();
    expect(html).toContain('class="page"');
    expect(html).toContain('class="page__body"');
    expect(html).not.toContain("undefined");
  });

  it("sets the static document title to hanse and forwards the viewport", () => {
    const html = spaShell({ viewport: "width=device-width, initial-scale=1, test" });
    expect(html).toContain("<title>hanse</title>");
    expect(html).toContain('content="width=device-width, initial-scale=1, test"');
  });
});
