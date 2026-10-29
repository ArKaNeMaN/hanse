import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { AppGitSummaryProps } from "../app-types.js";
import type { GitLoadFailure, GitNotice } from "../composables/useAppGit.js";
import { actionsHint, type GitStatus, gitControlRules, summaryFromStatus } from "../git-types.js";
import AppGitPanel from "./AppGitPanel.vue";

const LAST_COMMIT = {
  hash: "abcdef1234567890",
  shortHash: "abcdef1",
  subject: "fixture commit",
  author: "E2E Fixture",
  committedAt: "2026-10-20T10:00:00.000Z",
};

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    state: "ok",
    root: "/workspace/p/apps/alpha",
    branch: { name: "main", detached: false, head: "abcdef1234567890" },
    upstream: { name: "origin/main", ahead: 0, behind: 0 },
    clean: true,
    files: [],
    branches: ["main", "feature"],
    remotes: [{ name: "origin", url: "file:///workspace/p/apps/alpha/.git/e2e-remote.git" }],
    lastCommit: LAST_COMMIT,
    operation: null,
    conflicted: false,
    identity: { configured: true },
    ...overrides,
  };
}

function summary(value: GitStatus): AppGitSummaryProps {
  return summaryFromStatus(value);
}

function mountPanel(
  value: GitStatus | null,
  options: {
    failure?: GitLoadFailure | null;
    notice?: GitNotice | null;
    loading?: boolean;
    busyAction?: "fetch" | "update" | "push" | "commit" | "switch" | null;
    commitError?: { title: string; message: string } | null;
    needsRefresh?: boolean;
    summaryOverride?: AppGitSummaryProps;
    statusOverride?: GitStatus | null;
    onRefresh?: () => void;
    onAction?: (action: string, body: Record<string, string>) => void;
    onCommit?: () => void;
    onSwitch?: (branch: string) => void;
    onDraft?: (value: string) => void;
  } = {},
) {
  const live = options.statusOverride === undefined ? value : options.statusOverride;
  const display = options.summaryOverride ?? (live === null ? summary(status()) : summary(live));
  const rules = gitControlRules(live);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/projects/:id", component: { template: "<div />" } },
    ],
  });
  return mount(AppGitPanel, {
    global: { plugins: [router] },
    props: {
      ...(options.onRefresh === undefined ? {} : { onRefresh: options.onRefresh }),
      ...(options.onAction === undefined ? {} : { onAction: options.onAction }),
      ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit }),
      ...(options.onSwitch === undefined ? {} : { onSwitch: options.onSwitch }),
      ...(options.onDraft === undefined ? {} : { "onUpdate:commitDraft": options.onDraft }),
      summary: display,
      status: live,
      rules,
      hint: live?.state === "ok" ? actionsHint(live, rules) : "",
      loading: options.loading ?? false,
      busyAction: options.busyAction ?? null,
      failure: options.failure ?? null,
      notice: options.notice ?? null,
      commitDraft: "",
      commitError: options.commitError ?? null,
      needsRefresh: options.needsRefresh ?? false,
      refreshedLabel: "Refreshed just now",
      ideHref: "/ide/?folder=alpha",
      projectHref: "/projects/p",
      liveMessage: "",
    },
  });
}

describe("AppGitPanel", () => {
  it("renders the clean repository, upstream, actions, and branch switch", () => {
    const wrapper = mountPanel(status());

    expect(wrapper.get("#git-branch").text()).toContain("main");
    expect(wrapper.get("#git-upstream").text()).toContain("origin/main");
    expect(wrapper.get("#repository-card").text()).toContain("Clean");
    expect(wrapper.get("#git-clean").text()).toContain("Working tree clean");
    expect(wrapper.get("#git-fetch").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("#git-update").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("#git-push").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("#git-branch-select").exists()).toBe(true);
    expect(wrapper.find("style").exists()).toBe(false);
  });

  it("renders every file group and emits the commit intent and draft", async () => {
    const onDraft = vi.fn();
    const onCommit = vi.fn();
    const wrapper = mountPanel(
      status({
        clean: false,
        files: [
          { path: "staged.txt", code: "M", group: "staged" },
          { path: "unstaged.txt", code: "M", group: "unstaged" },
          { path: "new.txt", code: "?", group: "untracked" },
          { path: "old.txt", oldPath: "renamed.txt", code: "R", group: "staged" },
        ],
      }),
      { onDraft, onCommit },
    );

    expect(wrapper.get("#changes-card").text()).toContain("Staged");
    expect(wrapper.get("#changes-card").text()).toContain("Unstaged");
    expect(wrapper.get("#changes-card").text()).toContain("Untracked");
    expect(wrapper.get("#changes-card").text()).toContain("renamed.txt → old.txt");

    await wrapper.get("#git-commit-message").setValue("Commit all");
    expect(onDraft).toHaveBeenLastCalledWith("Commit all");
    await wrapper.get("#git-commit-form").trigger("submit");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("shows the conflict reasons and disables commit and switch", () => {
    const wrapper = mountPanel(
      status({
        clean: false,
        conflicted: true,
        files: [{ path: "README.md", code: "UU", group: "conflicted" }],
      }),
    );

    expect(wrapper.get("#repository-card").text()).toContain("Conflicts");
    expect(wrapper.get("#git-commit").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#git-switch").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#git-commit-hint").text()).toContain("Resolve conflicts");
  });

  it("renders detached HEAD with a branch placeholder and no commit form", () => {
    const wrapper = mountPanel(
      status({
        branch: { name: null, detached: true, head: "deadbeef" },
        upstream: null,
      }),
    );

    expect(wrapper.get("#git-branch").text()).toContain("Detached HEAD");
    expect(wrapper.get("#git-branch-select").text()).toContain("Choose a branch");
    expect(wrapper.find("#git-commit").exists()).toBe(false);
    expect(wrapper.get("#git-update").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#git-push").attributes("disabled")).toBeDefined();
  });

  it("uses the legacy busy labels and disables the workbench", () => {
    const wrapper = mountPanel(status(), { busyAction: "fetch" });

    expect(wrapper.get("#git-fetch").text()).toContain("Fetching");
    expect(wrapper.get("#git-fetch").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#git-update").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#git-refresh").attributes("disabled")).toBeDefined();
  });

  it("renders load failures with retry or the project link", async () => {
    const failure: GitLoadFailure = {
      title: "Repository status unavailable",
      message: "coordinator unavailable",
      outside: false,
      locked: false,
    };
    const onRefresh = vi.fn();
    const wrapper = mountPanel(status(), { statusOverride: null, failure, onRefresh });
    expect(wrapper.get("#repository-card").text()).toContain("coordinator unavailable");
    await wrapper.get("#repository-card button.btn-secondary").trigger("click");
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const outside = mountPanel(status(), {
      statusOverride: null,
      failure: { ...failure, outside: true },
    });
    expect(outside.get("#repository-card").text()).toContain("Open project");
    expect(outside.find("a[href='/projects/p']").exists()).toBe(true);
  });

  it("renders notice tones", () => {
    const success = mountPanel(status(), {
      notice: { tone: "success", title: null, message: "Fetched all remotes." },
    });
    expect(success.get("#git-notice").attributes("data-tone")).toBe("success");
    expect(success.get("#git-notice").text()).toContain("Fetched all remotes.");

    const warning = mountPanel(status(), {
      notice: { tone: "warning", title: "Choose a branch", message: "Select a branch." },
    });
    expect(warning.get("#git-notice").attributes("data-tone")).toBe("warning");
    expect(warning.get("#git-notice").text()).toContain("Choose a branch.");

    const error = mountPanel(status(), {
      notice: { tone: "error", title: "Push rejected", message: "Fetch and update." },
    });
    expect(error.get("#git-notice").attributes("data-tone")).toBe("error");
    expect(error.get("#git-notice").attributes("role")).toBe("alert");
  });

  it("renders the non-git repository states", () => {
    const notGit = mountPanel(status({ state: "not_git", message: "not a tree" }));
    expect(notGit.get("#repository-card").text()).toContain("Not a git repository");
    expect(notGit.find("a[href='/ide/?folder=alpha']").exists()).toBe(true);

    const missing = mountPanel(status({ state: "missing" }));
    expect(missing.get("#repository-card").text()).toContain("Application path not found");
    expect(missing.find("a[href='/projects/p']").exists()).toBe(true);
    expect(missing.get("#changes-card").text()).toContain("Changes are unavailable");
  });
});
