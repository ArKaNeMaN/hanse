import { afterEach, describe, expect, it } from "vitest";
import { readBoot } from "../../ui/boot.js";

function bootDocument(payload: unknown): string {
  document.body.innerHTML = `<script id="hanse-boot" type="application/json">${JSON.stringify(payload)}</script>`;
  return "";
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route: { id: "projects", params: {} },
    props: {},
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "Projects",
      active: "projects",
      pendingCount: 0,
      sshPendingCount: 0,
    },
    spaRoutes: ["projects", "overview"],
    topbar: { ideHref: "/ide/" },
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readBoot route set and topbar", () => {
  it("round-trips the resolved spaRoutes and topbar seed", () => {
    bootDocument(validPayload());
    expect(readBoot(document)).toMatchObject({
      route: { id: "projects", params: {} },
      spaRoutes: ["projects", "overview"],
      topbar: { ideHref: "/ide/" },
    });
  });

  it("drops unknown route ids and never enables them", () => {
    bootDocument(validPayload({ spaRoutes: ["projects", "not-a-route", 7, "chat"] }));
    expect(readBoot(document)?.spaRoutes).toEqual(["projects", "chat"]);
  });

  it("accepts the terminal route when the server enables it", () => {
    bootDocument(
      validPayload({
        route: { id: "terminal", params: {} },
        spaRoutes: ["projects", "terminal"],
      }),
    );
    expect(readBoot(document)?.route.id).toBe("terminal");
    expect(readBoot(document)?.spaRoutes).toEqual(["projects", "terminal"]);
  });

  it("rejects a boot route that is absent from the resolved set", () => {
    bootDocument(validPayload({ route: { id: "projects", params: {} }, spaRoutes: ["overview"] }));
    expect(readBoot(document)).toBeUndefined();
  });

  it("rejects an unknown boot route id", () => {
    bootDocument(
      validPayload({ route: { id: "not-a-route", params: {} }, spaRoutes: ["not-a-route"] }),
    );
    expect(readBoot(document)).toBeUndefined();
  });

  it("rejects a non-array spaRoutes field", () => {
    bootDocument(validPayload({ spaRoutes: "projects" }));
    expect(readBoot(document)).toBeUndefined();
  });

  it("validates the topbar seed", () => {
    bootDocument(validPayload({ topbar: { ideHref: "/ide/", needsInputCount: 0 } }));
    expect(readBoot(document)?.topbar).toEqual({ ideHref: "/ide/", needsInputCount: 0 });

    for (const topbar of [
      undefined,
      {},
      { ideHref: 7 },
      { ideHref: "/ide/", needsInputCount: "0" },
      { ideHref: "/ide/", policyVisible: "yes" },
      { ideHref: "/ide/", contextToggle: 1 },
    ]) {
      bootDocument(validPayload({ topbar }));
      expect(readBoot(document), JSON.stringify(topbar)).toBeUndefined();
    }
  });

  it("returns undefined when the boot script is missing", () => {
    document.body.innerHTML = "";
    expect(readBoot(document)).toBeUndefined();
  });
});
