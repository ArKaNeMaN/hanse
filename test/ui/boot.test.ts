import { afterEach, describe, expect, it } from "vitest";
import { readBoot } from "../../ui/boot.js";

function bootDocument(payload: unknown): void {
  document.body.innerHTML = `<script id="hanse-boot" type="application/json">${JSON.stringify(payload)}</script>`;
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
    topbar: { ideHref: "/ide/" },
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readBoot", () => {
  it("round-trips the route, chrome, routeKey, operator, and topbar seed", () => {
    bootDocument(validPayload());
    expect(readBoot(document)).toMatchObject({
      route: { id: "projects", params: {} },
      chrome: { title: "Projects", active: "projects" },
      routeKey: JSON.stringify(["projects", [], []]),
      operator: { name: "alice", initials: "AL" },
      topbar: { ideHref: "/ide/" },
    });
  });

  it("accepts a login boot without operator and with empty chrome lists", () => {
    bootDocument(
      validPayload({
        route: { id: "login", params: {} },
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

  it("accepts the synthetic not-found boot and its override", () => {
    bootDocument(
      validPayload({
        route: { id: "not-found", params: {} },
        override: "not-found",
        routeKey: JSON.stringify(["not-found", [], []]),
      }),
    );
    expect(readBoot(document)?.override).toBe("not-found");
  });

  it("accepts chat-no-apps only on the chat route", () => {
    bootDocument(
      validPayload({
        route: { id: "chat", params: {} },
        override: "chat-no-apps",
        props: { noApps: true },
      }),
    );
    expect(readBoot(document)?.override).toBe("chat-no-apps");

    bootDocument(
      validPayload({
        route: { id: "projects", params: {} },
        override: "chat-no-apps",
      }),
    );
    expect(readBoot(document)).toBeUndefined();
  });

  it("rejects an unknown boot route id or an unknown override", () => {
    bootDocument(validPayload({ route: { id: "not-a-route", params: {} } }));
    expect(readBoot(document)).toBeUndefined();

    bootDocument(validPayload({ override: "other" }));
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

  it("returns undefined when the boot script is missing", () => {
    document.body.innerHTML = "";
    expect(readBoot(document)).toBeUndefined();
  });
});
