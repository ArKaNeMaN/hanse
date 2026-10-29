import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { AppImageLive, AppImageProps, AppImageState } from "../app-types.js";
import AppImagePanel from "./AppImagePanel.vue";

function image(overrides: Partial<AppImageProps> = {}): AppImageProps {
  return {
    configured: true,
    status: "ready",
    state: "delivered",
    label: "Built",
    glyph: "check",
    action: "Rebuild image",
    hint: "The image matches the current Dockerfile and base.",
    ref: "hanse-alpha:latest",
    hash: "sha256:abcdef",
    builtAt: "2026-10-20T10:00:00.000Z",
    base: {
      kind: "default",
      kindLabel: "Default",
      ref: "hanse-agent-default:latest",
      digest: "sha256:base",
    },
    drift: false,
    blocked: false,
    usable: true,
    rollback: {
      available: true,
      ref: "hanse-alpha:previous",
      builtAt: "2026-10-19T10:00:00.000Z",
      action: "Roll back image",
      restart: false,
    },
    error: null,
    building: false,
    buildDisabled: false,
    rollbackDisabled: false,
    projectId: "p",
    appKey: "alpha",
    hrefs: {
      app: "/projects/p/apps/alpha",
      build: "/api/apps/alpha/build?project=p",
      rollback: "/api/apps/alpha/image/rollback?project=p",
      check: "/api/apps/alpha/image/check?project=p",
      image: "/api/apps/alpha/image?project=p",
      logs: "/api/apps/alpha/image/logs?project=p",
      runtime: "/api/apps/alpha/runtime?project=p",
    },
    ...overrides,
  };
}

function live(overrides: Partial<AppImageLive> = {}): AppImageLive {
  return {
    status: "ready",
    state: "current",
    imageRef: "hanse-alpha:latest",
    hash: "sha256:abcdef",
    baseKind: "default",
    baseRef: "hanse-agent-default:latest",
    baseDigest: "sha256:base",
    currentBaseDigest: "sha256:base",
    builtAt: "2026-10-20T10:00:00.000Z",
    previousImageRef: "hanse-alpha:previous",
    previousImageBuiltAt: "2026-10-19T10:00:00.000Z",
    error: null,
    baseDrift: false,
    hashDrift: false,
    blocked: false,
    usableImageRef: "hanse-alpha:latest",
    ...overrides,
  };
}

function defaultImage(overrides: Partial<AppImageProps> = {}): AppImageProps {
  return image({
    configured: false,
    status: "default",
    state: "cancelled",
    label: "Default image",
    glyph: "layers",
    action: "",
    hint: "This application uses the shared default agent image.",
    ref: null,
    hash: null,
    builtAt: null,
    base: { kind: null, kindLabel: "Unknown", ref: null, digest: null },
    usable: false,
    rollback: {
      available: false,
      ref: null,
      builtAt: null,
      action: "Roll back image",
      restart: false,
    },
    ...overrides,
  });
}

describe("AppImagePanel", () => {
  it.each([
    ["current", "Built"],
    ["restart_required", "Restart required"],
    ["rebuild_required", "Out of date"],
    ["build_error", "Build failed"],
    ["not_ready", "Not built"],
    ["unknown", "Unknown"],
  ] as const)("renders the derived image state %s", async (state, label) => {
    const wrapper = mount(AppImagePanel, {
      props: {
        image: image({ status: "ready" }),
        live: live({
          state,
          imageRef: state === "not_ready" ? null : "hanse-alpha:latest",
          usableImageRef: state === "not_ready" ? null : "hanse-alpha:latest",
        }),
      },
    });

    expect(wrapper.get("#image-status").text()).toContain(label);
    const action =
      state === "not_ready"
        ? "Build image"
        : state === "build_error"
          ? "Retry build"
          : "Rebuild image";
    expect(wrapper.get("#image-build").text()).toContain(action);
  });

  it.each([
    ["missing", "Not built"],
    ["ready", "Built"],
    ["stale", "Out of date"],
    ["error", "Build failed"],
  ] as const)(
    "maps the raw service status %s when no derived state is present",
    (status, label) => {
      const wrapper = mount(AppImagePanel, {
        props: { image: image({ status: status as AppImageState }), live: { status } },
      });
      expect(wrapper.get("#image-status").text()).toContain(label);
    },
  );

  it("shows building busy state, opens logs, and disables both actions", () => {
    const onLogsOpen = vi.fn();
    const wrapper = mount(AppImagePanel, {
      props: {
        image: image({ status: "building", building: true }),
        live: live({ status: "building", state: "building" }),
        logsOpen: false,
        "onUpdate:logsOpen": onLogsOpen,
      },
    });

    expect(wrapper.get("#image-status").text()).toContain("Building");
    expect(wrapper.get("#image-build").text()).toContain("Building…");
    expect(wrapper.get("#image-build").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#image-build").attributes("aria-busy")).toBe("true");
    expect(wrapper.get("#image-logs-details").attributes("open")).toBeDefined();
    expect(onLogsOpen).toHaveBeenCalledWith(true);
  });

  it("renders the base/drift/blocked/usable/rollback matrix", () => {
    const wrapper = mount(AppImagePanel, {
      props: {
        image: image({ drift: true }),
        live: live({
          state: "rebuild_required",
          status: "stale",
          baseDrift: true,
          hashDrift: true,
          baseDigest: "sha256:old",
          currentBaseDigest: "sha256:new",
          blocked: true,
          usableImageRef: null,
          previousImageRef: null,
        }),
      },
    });

    const text = wrapper.get("#image-panel").text();
    expect(text).toContain("Drift");
    expect(text).toContain("Blocked");
    expect(text).toContain("No usable image");
    expect(text).toContain("No rollback");
    expect(text).toContain("sha256:old → sha256:new");
    expect(wrapper.find("#image-rollback").exists()).toBe(false);
    expect(wrapper.get("#image-build").attributes("disabled")).toBeDefined();
  });

  it("shows the default image check action and current/restart states", async () => {
    const onCheck = vi.fn();
    const wrapper = mount(AppImagePanel, {
      props: { image: defaultImage(), live: live({ state: "current" }), onCheck },
    });
    expect(wrapper.get("#image-status").text()).toContain("Current");
    expect(wrapper.find("#image-build").exists()).toBe(false);
    expect(wrapper.find("#image-rollback").exists()).toBe(false);
    expect(wrapper.get("#image-check").text()).toContain("Check for changes");

    await wrapper.get("#image-check").trigger("click");
    expect(onCheck).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ live: live({ state: "restart_required" }) });
    expect(wrapper.get("#image-status").text()).toContain("Restart required");
  });

  it("emits build, refresh, rollback, and logs events", async () => {
    const onBuild = vi.fn();
    const onRefresh = vi.fn();
    const onRollback = vi.fn();
    const onRefreshLogs = vi.fn();
    const wrapper = mount(AppImagePanel, {
      props: {
        image: image(),
        live: live(),
        onBuild,
        onRefresh,
        onRollback,
        onRefreshLogs,
      },
    });

    await wrapper.get("#image-build").trigger("click");
    expect(onBuild).toHaveBeenCalledTimes(1);

    await wrapper.get("#image-refresh").trigger("click");
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await wrapper.get("#image-details summary").trigger("click");
    await wrapper.get("#image-rollback").trigger("click");
    expect(wrapper.get("#image-rollback-dialog").attributes("open")).toBeDefined();
    await wrapper.get("#image-rollback-confirm").trigger("click");
    expect(onRollback).toHaveBeenCalledTimes(1);

    const logs = wrapper.get("#image-logs-details");
    (logs.element as HTMLDetailsElement).open = true;
    await logs.trigger("toggle");
    expect(onRefreshLogs).toHaveBeenCalledTimes(1);
  });

  it("shows logs, action errors, and the restart notice without leaking scripts", async () => {
    const wrapper = mount(AppImagePanel, {
      props: {
        image: image({ error: "docker build failed" }),
        live: live({ error: "docker build failed" }),
        logs: "Step 1/2: fixture build",
        runtimeActive: true,
        runtimeImageRef: "hanse-alpha:old",
      },
    });

    expect(wrapper.get("#image-error").text()).toContain("docker build failed");
    expect(wrapper.get("#image-logs").text()).toContain("Step 1/2: fixture build");
    expect(wrapper.get("#image-notice").text()).toContain("Restart the agent");
    expect(wrapper.find("style").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("images.js");
    expect(wrapper.html()).not.toContain("git.js");
    expect(wrapper.html()).not.toContain("ssh.js");
  });
});
