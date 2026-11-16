import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { MemoryPayload, MemorySampleBucket } from "../memory-chart.js";
import AppMemoryPanel from "./AppMemoryPanel.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery };
});

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const ORIGINAL_WIDTH = window.innerWidth;

interface MountOptions {
  readonly mem?: string;
  readonly runtimeState?: "starting" | "running" | "stopped" | "error";
  readonly extraQuery?: Record<string, string>;
}

interface MountedPanel {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly queryClient: QueryClient;
}

function bucket(
  start: string,
  minBytes: number,
  averageBytes: number,
  maxBytes: number,
  samples = 2,
): MemorySampleBucket {
  return { start, minBytes, averageBytes, maxBytes, samples };
}

function payload(overrides: Partial<MemoryPayload> = {}): MemoryPayload {
  return {
    appId: "p:web",
    window: {
      from: "2026-11-16T06:00:00.000Z",
      to: "2026-11-16T12:00:00.000Z",
      bucketSeconds: 1_800,
    },
    summary: {
      currentBytes: 500 * MIB,
      minBytes: 100 * MIB,
      peakBytes: 1.5 * GIB,
      averageBytes: 400 * MIB,
      limitBytes: 2 * GIB,
      samples: 12,
      lastSampleAt: "2026-11-16T11:59:00.000Z",
    },
    buckets: [
      bucket("2026-11-16T11:00:00.000Z", 100 * MIB, 200 * MIB, 300 * MIB),
      bucket("2026-11-16T11:30:00.000Z", 300 * MIB, 500 * MIB, 1.5 * GIB),
    ],
    events: [],
    ...overrides,
  };
}

function emptyPayload(overrides: Partial<MemoryPayload> = {}): MemoryPayload {
  return payload({
    summary: {
      currentBytes: null,
      minBytes: null,
      peakBytes: null,
      averageBytes: null,
      limitBytes: null,
      samples: 0,
      lastSampleAt: null,
    },
    buckets: [],
    events: [],
    ...overrides,
  });
}

async function mountPanel(options: MountOptions = {}): Promise<MountedPanel> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/projects/:id/apps/:app",
        name: "app",
        component: { template: "<div />" },
      },
    ],
  });
  await router.push({
    path: "/projects/p/apps/web",
    query: {
      ...(options.extraQuery ?? {}),
      ...(options.mem === undefined ? {} : { mem: options.mem }),
    },
  });
  await router.isReady();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = mount(AppMemoryPanel, {
    props: {
      projectId: "p",
      appKey: "web",
      runtimeState: options.runtimeState ?? "running",
    },
    global: { plugins: [[VueQueryPlugin, { queryClient }], router] },
  });
  await flushPromises();
  return { wrapper, router, queryClient };
}

function summaryValues(wrapper: VueWrapper): string[] {
  return wrapper.findAll(".memory-summary .watch").map((cell) => cell.text());
}

function rangeButton(wrapper: VueWrapper, label: string) {
  return wrapper.findAll(".segmented__item").find((button) => button.text() === label);
}

beforeEach(() => {
  mocks.apiQuery.mockReset();
});

afterEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: ORIGINAL_WIDTH,
  });
});

describe("AppMemoryPanel", () => {
  it("shows a busy skeleton while the first read is pending", async () => {
    mocks.apiQuery.mockReturnValue(new Promise(() => undefined));
    const { wrapper } = await mountPanel();

    expect(wrapper.get("#app-memory").attributes("aria-busy")).toBe("true");
    expect(wrapper.findAll(".skeleton").length).toBeGreaterThan(0);
    expect(wrapper.text()).toContain("Loading memory samples…");
    expect(wrapper.find("#memory-chart-body").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the summary, chart, legend, data table, and edit link", async () => {
    mocks.apiQuery.mockResolvedValue(payload());
    const { wrapper, router } = await mountPanel();

    const cells = summaryValues(wrapper);
    expect(cells[0]).toContain("500 MiB");
    expect(cells[0]).toContain("Current");
    expect(cells[1]).toContain("1.5 GiB");
    expect(cells[1]).toContain("Peak");
    expect(cells[2]).toContain("400 MiB");
    expect(cells[3]).toContain("2 GiB");
    expect(cells[3]).toContain("Limit");

    expect(wrapper.get("#app-memory").attributes("aria-busy")).toBe("false");
    expect(wrapper.get(".memory-chart__svg").attributes("role")).toBe("img");
    expect(wrapper.find(".memory-chart__line").exists()).toBe(true);
    expect(wrapper.find(".memory-chart__band").exists()).toBe(true);
    expect(wrapper.find(".memory-chart__limit").exists()).toBe(true);
    expect(wrapper.find("svg text").exists()).toBe(false);
    expect(wrapper.get(".memory-legend").text()).toContain("min–max band");
    expect(wrapper.get(".memory-legend").text()).toContain("working-set average");
    expect(wrapper.get(".memory-legend").text()).toContain("limit");
    expect(wrapper.get(".memory-legend").text()).toContain("OOM");

    const table = wrapper.get(".memory-table").text();
    expect(table).toContain("Bucket start");
    expect(table).toContain("Min");
    expect(table).toContain("Average");
    expect(table).toContain("Max");
    expect(table).toContain("100 MiB");
    expect(table).toContain("200 MiB");
    expect(table).toContain("300 MiB");

    const edit = wrapper.get('a[href*="#setting-runtime-memory"]');
    expect(edit.attributes("href")).toBe("/projects/p/apps/web/settings#setting-runtime-memory");
    expect(router.currentRoute.value.path).toBe("/projects/p/apps/web");
    wrapper.unmount();
  });

  it("shows the never-sampled state with an empty limit", async () => {
    mocks.apiQuery.mockResolvedValue(emptyPayload());
    const { wrapper } = await mountPanel();

    expect(wrapper.text()).toContain(
      "No memory samples yet. Samples appear after this agent starts.",
    );
    expect(summaryValues(wrapper)[3]).toContain("—");
    expect(wrapper.find(".memory-chart").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows a no-data-in-range message and a wider-range action", async () => {
    mocks.apiQuery.mockResolvedValue(
      emptyPayload({
        summary: {
          currentBytes: null,
          minBytes: null,
          peakBytes: null,
          averageBytes: null,
          limitBytes: null,
          samples: 0,
          lastSampleAt: "2026-11-16T05:00:00.000Z",
        },
      }),
    );
    const { wrapper, router } = await mountPanel();

    expect(wrapper.text()).toContain("No samples in the last 24 hours.");
    const wider = wrapper.findAll("button").find((button) => button.text() === "Show 72 hours");
    expect(wider).toBeDefined();
    await wider?.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.query.mem).toBe("72h:auto");
    wrapper.unmount();
  });

  it("keeps the historical chart but blanks Current when the agent is stopped", async () => {
    mocks.apiQuery.mockResolvedValue(payload());
    const { wrapper } = await mountPanel({ runtimeState: "stopped" });

    expect(summaryValues(wrapper)[0]).toContain("—");
    expect(wrapper.find(".memory-chart__line").exists()).toBe(true);
    expect(wrapper.get(".memory-foot").text()).toMatch(/Agent stopped · last sample \d{2}:\d{2}/);
    expect(wrapper.find(".memory-chart__now").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows an error with Retry and recovers", async () => {
    mocks.apiQuery.mockRejectedValueOnce(new Error("memory endpoint unavailable"));
    mocks.apiQuery.mockResolvedValue(payload());
    const { wrapper } = await mountPanel();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain("memory endpoint unavailable");
    const retry = wrapper.findAll("button").find((button) => button.text() === "Retry");
    expect(retry).toBeDefined();
    await retry?.trigger("click");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(summaryValues(wrapper)[0]).toContain("500 MiB");
    wrapper.unmount();
  });

  it("keeps stale data visible when a refresh fails", async () => {
    mocks.apiQuery.mockResolvedValueOnce(payload());
    mocks.apiQuery.mockRejectedValueOnce(new Error("refresh failed"));
    const { wrapper, queryClient } = await mountPanel();

    await queryClient.refetchQueries({ queryKey: ["app-memory"] });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toMatch(
      /Showing data from \d{2}:\d{2} · refresh failed/,
    );
    expect(wrapper.find(".memory-chart__line").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows an OOM badge, a coalesced marker, a polite readout, and table counts", async () => {
    mocks.apiQuery.mockResolvedValue(
      payload({
        events: [
          { at: "2026-11-16T11:10:00.000Z", kind: "oom_killed", message: "Exceeded limit" },
          { at: "2026-11-16T11:10:30.000Z", kind: "oom_killed", message: "Second kill" },
          { at: "2026-11-16T11:25:00.000Z", kind: "oom_killed", message: "Third kill" },
        ],
      }),
    );
    const { wrapper } = await mountPanel();

    expect(wrapper.get(".memory-oom-badge").text()).toBe("2 OOM");
    const markers = wrapper.findAll(".memory-oom");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.attributes("aria-label")).toMatch(/^2 OOM events near \d{2}:\d{2}$/);
    expect(wrapper.get(".memory-oom__count").text()).toBe("2");

    await markers[0]?.trigger("click");
    expect(wrapper.get(".memory-readout").attributes("role")).toBe("status");
    expect(wrapper.get(".memory-readout").text()).toMatch(/^2 OOM events near \d{2}:\d{2}/);

    const rows = wrapper.findAll(".memory-table tbody tr");
    expect(rows[0]?.text()).toContain("2");
    expect(wrapper.get(".memory-chart__note").text()).toContain("coalesced");
    wrapper.unmount();
  });

  it("uses the actual in-window limit, not a configured or bucket value", async () => {
    const base = payload();
    mocks.apiQuery.mockResolvedValue(
      payload({
        summary: { ...base.summary, limitBytes: 1 * GIB },
        buckets: base.buckets.map((entry) => ({ ...entry, limitBytes: 2 * GIB })),
      }),
    );
    const { wrapper } = await mountPanel();

    expect(summaryValues(wrapper)[3]).toContain("1 GiB");
    expect(summaryValues(wrapper)[3]).not.toContain("2 GiB");
    wrapper.unmount();
  });

  it("persists range and bucket changes in mem without clobbering other query params", async () => {
    mocks.apiQuery.mockResolvedValue(payload());
    const { wrapper, router } = await mountPanel({
      mem: "6h:10m",
      extraQuery: { tab: "git" },
    });

    expect(rangeButton(wrapper, "6 h")?.attributes("aria-pressed")).toBe("true");
    expect((wrapper.get("#memory-bucket").element as HTMLSelectElement).value).toBe("10m");

    await rangeButton(wrapper, "24 h")?.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.query.mem).toBe("24h:10m");
    expect(router.currentRoute.value.query.tab).toBe("git");

    await rangeButton(wrapper, "72 h")?.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.query.mem).toBe("72h:30m");
    expect(wrapper.get('option[value="10m"]').attributes("disabled")).toBeDefined();

    await wrapper.get("#memory-bucket").setValue("auto");
    await flushPromises();
    expect(router.currentRoute.value.query.mem).toBe("72h:auto");
    expect(mocks.apiQuery.mock.calls.at(-1)?.[0]).toContain("window=72h");
    expect(mocks.apiQuery.mock.calls.at(-1)?.[0]).toContain("bucket=30m");
    wrapper.unmount();
  });

  it("accepts auto from the URL and resolves it for the request", async () => {
    mocks.apiQuery.mockResolvedValue(payload());
    const { wrapper, router } = await mountPanel({ mem: "24h:auto" });

    expect((wrapper.get("#memory-bucket").element as HTMLSelectElement).value).toBe("auto");
    await rangeButton(wrapper, "6 h")?.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.query.mem).toBe("6h:auto");
    expect(mocks.apiQuery.mock.calls.at(-1)?.[0]).toContain("window=6h");
    expect(mocks.apiQuery.mock.calls.at(-1)?.[0]).toContain("bucket=10m");
    wrapper.unmount();
  });

  it("disables 10-minute buckets at 72 hours with a visible, described reason", async () => {
    mocks.apiQuery.mockResolvedValue(payload());
    const { wrapper } = await mountPanel({ mem: "72h:auto" });

    expect(wrapper.get('option[value="10m"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("#memory-bucket").attributes("aria-describedby")).toBe(
      "memory-bucket-reason",
    );
    expect(wrapper.get("#memory-bucket-reason").text()).toContain("72-hour range");
    wrapper.unmount();
  });

  it("collapses the chart behind Show chart below 768 px", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    mocks.apiQuery.mockResolvedValue(
      payload({
        events: [{ at: "2026-11-16T11:10:00.000Z", kind: "oom_killed", message: null }],
      }),
    );
    const { wrapper } = await mountPanel({ mem: "24h:auto" });

    expect(wrapper.find("#memory-chart-body").exists()).toBe(false);
    expect(wrapper.find(".memory-summary").exists()).toBe(true);
    expect(wrapper.find(".memory-oom-badge").exists()).toBe(true);
    expect(wrapper.get('option[value="10m"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("#memory-bucket-reason").text()).toContain("768 px");

    const toggle = wrapper.findAll("button").find((button) => button.text() === "Show chart");
    expect(toggle).toBeDefined();
    await toggle?.trigger("click");
    await flushPromises();
    expect(wrapper.find("#memory-chart-body").exists()).toBe(true);
    wrapper.unmount();
  });
});
