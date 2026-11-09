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
      title: "Projects",
      active: "projects",
      breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Projects" }],
      projects: [{ id: "p", name: "Alpha", appCount: 1 }],
      masterHref: "/chat?app=master&project=hanse-master",
      pendingCount: 0,
      sshPendingCount: 0,
    },
    routeKey: JSON.stringify(["projects", [], []]),
    operator: { name: "alice", initials: "AL" },
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

  it("accepts the chat route when the test allowlist enables it", () => {
    bootDocument(
      validPayload({
        route: { id: "chat", params: {} },
        spaRoutes: ["projects", "chat"],
      }),
    );
    expect(readBoot(document)?.route.id).toBe("chat");
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

describe("readBoot chrome data, routeKey, and operator", () => {
  it("round-trips data-only chrome, routeKey, and operator", () => {
    bootDocument(validPayload());
    expect(readBoot(document)).toMatchObject({
      chrome: {
        title: "Projects",
        active: "projects",
        breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Projects" }],
        projects: [{ id: "p", name: "Alpha", appCount: 1 }],
        masterHref: "/chat?app=master&project=hanse-master",
        pendingCount: 0,
        sshPendingCount: 0,
      },
      routeKey: JSON.stringify(["projects", [], []]),
      operator: { name: "alice", initials: "AL" },
    });
  });

  it("accepts a login boot without operator and with empty chrome lists", () => {
    bootDocument(
      validPayload({
        route: { id: "login", params: {} },
        spaRoutes: ["login"],
        chrome: {
          title: "Sign in",
          active: "none",
          breadcrumb: [],
          projects: [],
          masterHref: "/chat?app=master&project=hanse-master",
          pendingCount: 0,
          sshPendingCount: 0,
        },
        routeKey: JSON.stringify(["login", [], []]),
        operator: undefined,
      }),
    );
    const boot = readBoot(document);
    expect(boot?.route.id).toBe("login");
    expect(boot?.operator).toBeUndefined();
    expect(boot?.chrome.breadcrumb).toEqual([]);
  });

  it("rejects a missing, non-string, or empty routeKey", () => {
    for (const routeKey of [undefined, 7, ""]) {
      bootDocument(validPayload({ routeKey }));
      expect(readBoot(document), JSON.stringify(routeKey)).toBeUndefined();
    }
  });

  it("rejects invalid chrome shapes", () => {
    const base = validPayload();
    const chrome = base.chrome as Record<string, unknown>;
    const variants: Array<Record<string, unknown>> = [
      { ...chrome, active: "bogus" },
      { ...chrome, breadcrumb: "" },
      { ...chrome, breadcrumb: [{ label: 7 }] },
      { ...chrome, projects: "none" },
      { ...chrome, projects: [{ id: "p", name: "Alpha" }] },
      { ...chrome, masterHref: 7 },
      { ...chrome, pendingCount: "0" },
      { ...chrome, sshPendingCount: undefined },
      { ...chrome, settingsHref: 7 },
    ];
    for (const variant of variants) {
      bootDocument(validPayload({ chrome: variant }));
      expect(readBoot(document), JSON.stringify(variant)).toBeUndefined();
    }
  });

  it("rejects an invalid operator", () => {
    for (const operator of [{ name: "alice" }, { name: 7, initials: "AL" }, "alice"]) {
      bootDocument(validPayload({ operator }));
      expect(readBoot(document), JSON.stringify(operator)).toBeUndefined();
    }
  });
});
