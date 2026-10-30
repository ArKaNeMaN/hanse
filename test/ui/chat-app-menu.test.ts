import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountChat } from "./chat-support.js";

const APP_OPTIONS = [
  {
    projectId: "p",
    projectName: "Project",
    apps: [
      {
        appKey: "alpha",
        value: "p:alpha",
        projectId: "p",
        selected: true,
      },
      {
        appKey: "beta",
        value: "p:beta",
        projectId: "p",
        selected: false,
      },
    ],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("chat app menu", () => {
  it("switches apps through the router, flushes the draft, and keeps one navigation", async () => {
    const { wrapper, router, fetchState } = await mountChat(
      "/chat?app=alpha&project=p&session=s1",
      {
        appOptions: APP_OPTIONS,
        draftText: "unsent draft",
      },
    );
    await flushPromises();
    await wrapper.find("[data-chat-composer-input]").setValue("edited draft");
    const select = wrapper.find("[data-chat-app-select]");
    expect(select.exists()).toBe(true);
    expect(select.findAll("option")).toHaveLength(2);
    expect((select.element as HTMLSelectElement).value).toBe("p:alpha");

    await select.setValue("p:beta");
    await flushPromises();

    expect(router.currentRoute.value.query).toMatchObject({ app: "beta", project: "p" });
    expect(router.currentRoute.value.query.session).toBeUndefined();
    const draftWrites = fetchState.requests.filter(
      (request) => request.method === "PUT" && request.url.includes("/draft"),
    );
    expect(draftWrites).toHaveLength(1);
    expect(JSON.parse(draftWrites[0]?.body ?? "{}")).toEqual({ text: "edited draft" });
    wrapper.unmount();
  });

  it("renders project, handoff, IDE, and application links plus the head session action", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      appOptions: APP_OPTIONS,
    });
    await flushPromises();
    expect(wrapper.find("[data-chat-new-session-head]").exists()).toBe(true);
    const rail = wrapper.find("[data-chat-context-rail]");
    expect(rail.exists()).toBe(true);
    expect(rail.find('a[href="/projects/p"]').exists()).toBe(true);
    expect(rail.find('a[href="/projects/p/apps/alpha"]').exists()).toBe(true);
    expect(rail.find('a[href="/handoffs?q=alpha"]').exists()).toBe(true);
    expect(rail.find('a[href="/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Falpha"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
