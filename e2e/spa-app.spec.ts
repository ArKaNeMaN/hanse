import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  PROJECT_TWO,
  prepareGitState,
  settle,
  signIn,
} from "./support/helpers.js";

const APP_PATH = `/projects/${PROJECT_ONE}/apps/alpha`;
const BETA_PATH = `/projects/${PROJECT_ONE}/apps/beta`;
const GAMMA_PATH = `/projects/${PROJECT_TWO}/apps/gamma`;

function toast(page: Parameters<typeof signIn>[0], text: string) {
  return page.locator("#toast-region .toast", { hasText: text });
}

async function openApp(page: Parameters<typeof signIn>[0]): Promise<void> {
  await signIn(page, APP_PATH);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
}

async function openGroup(page: Page, group: "git" | "image" | "ssh" | "danger") {
  const toggle = page.locator(`#group-${group}-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.locator(`#group-${group}-body`)).toBeVisible();
}

const MEMORY_ROUTE = /\/api\/apps\/alpha\/memory\?/;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MEMORY_LIMIT = 2 * GIB;
const MEMORY_PEAK = 1.5 * GIB;
const MEMORY_CURRENT = 500 * MIB;
const MEMORY_AVERAGE = 400 * MIB;

type MemoryMode = "normal" | "oom" | "never" | "range" | "error";

interface MemoryMock {
  mode: MemoryMode;
  readonly requests: URLSearchParams[];
}

function memoryWindow(url: string): "6h" | "24h" | "72h" {
  const value = new URL(url).searchParams.get("window");
  return value === "6h" || value === "72h" ? value : "24h";
}

function memoryBucket(url: string): "10m" | "30m" {
  return new URL(url).searchParams.get("bucket") === "10m" ? "10m" : "30m";
}

/**
 * Deterministic memory endpoint stand-in. Timestamps are relative to the request so the card's
 * "last sample" copy stays truthful, but every byte value, bucket, and event is fixed.
 */
function memoryPayload(mode: MemoryMode, window: "6h" | "24h" | "72h", bucket: "10m" | "30m") {
  const windowSeconds =
    window === "6h" ? 6 * 60 * 60 : window === "24h" ? 24 * 60 * 60 : 72 * 60 * 60;
  const bucketSeconds = bucket === "10m" ? 10 * 60 : 30 * 60;
  const now = Date.now();
  const span = windowSeconds * 1_000;
  const fromMs = now - span;
  const from = new Date(fromMs).toISOString();
  const to = new Date(now).toISOString();

  if (mode === "never" || mode === "range") {
    return {
      appId: "alpha",
      window: { from, to, bucketSeconds },
      summary: {
        currentBytes: null,
        minBytes: null,
        peakBytes: null,
        averageBytes: null,
        limitBytes: null,
        samples: 0,
        lastSampleAt: mode === "range" ? new Date(now - 3 * 60 * 60 * 1_000).toISOString() : null,
      },
      buckets: [],
      events: [],
    };
  }

  const bucketMs = bucketSeconds * 1_000;
  const buckets = Array.from({ length: 6 }, (_, index) => ({
    start: new Date(fromMs + Math.round((index * span) / 6)).toISOString(),
    minBytes: 300 * MIB,
    averageBytes: MEMORY_AVERAGE,
    maxBytes: index === 3 ? MEMORY_PEAK : 600 * MIB,
    samples: 8,
  }));
  // The two OOM events in this mode sit inside one bucket; the card coalesces them by bucket and
  // keeps the 60-second coalescing contract for the count.
  const events =
    mode === "oom"
      ? [
          {
            at: new Date(fromMs + bucketMs * 5.5).toISOString(),
            kind: "oom_killed" as const,
            message: "container exited with code 137",
          },
          {
            at: new Date(fromMs + bucketMs * 5.5 + 120_000).toISOString(),
            kind: "oom_killed" as const,
            message: "container exited with code 137",
          },
        ]
      : [
          {
            at: new Date(fromMs + bucketMs * 4.5).toISOString(),
            kind: "oom_killed" as const,
            message: "container exited with code 137",
          },
        ];

  return {
    appId: "alpha",
    window: { from, to, bucketSeconds },
    summary: {
      currentBytes: MEMORY_CURRENT,
      minBytes: 300 * MIB,
      peakBytes: MEMORY_PEAK,
      averageBytes: MEMORY_AVERAGE,
      limitBytes: MEMORY_LIMIT,
      samples: 48,
      lastSampleAt: new Date(now - 12_000).toISOString(),
    },
    buckets,
    events,
  };
}

async function mockMemory(page: Page, initial: MemoryMode): Promise<MemoryMock> {
  const mock: MemoryMock = { mode: initial, requests: [] };
  await page.route(MEMORY_ROUTE, async (route) => {
    const url = route.request().url();
    mock.requests.push(new URL(url).searchParams);
    if (mock.mode === "error") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "memory sampling unavailable", code: "memory_failed" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(memoryPayload(mock.mode, memoryWindow(url), memoryBucket(url))),
    });
  });
  return mock;
}

function memorySummaryValues(page: Page) {
  return page.locator("#app-memory .memory-summary .watch__value");
}

async function openMemoryCard(page: Page): Promise<void> {
  await openApp(page);
  await expect(page.locator("#app-memory")).toBeVisible();
  await expect(page.locator("#app-memory .memory-summary")).toBeVisible();
}

test("deep links, refreshes, and renders the read-only runtime, image, git, and SSH panels", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await openApp(page);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await expect(page.locator("#runtime-state")).toContainText("Ready");
  await expect(page.locator("#settings-state")).toBeVisible();
  await expect(page.locator("#app-restart")).toBeVisible();

  await expect(page.locator("#group-git-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#group-image-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#group-ssh-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#group-danger-toggle")).toHaveAttribute("aria-expanded", "false");

  await openGroup(page, "git");
  await openGroup(page, "image");
  await openGroup(page, "ssh");

  await expect(page.locator("#image-panel")).toBeVisible();
  await expect(page.locator("#image-ref")).toHaveText("Default agent image");

  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.locator("#git-refreshed")).toContainText("Refreshed", { timeout: 15_000 });
  await expect(page.locator("#git-branch")).toContainText("main");
  await expect(page.locator("#git-upstream")).toContainText("origin/main");
  await expect(page.locator("#repository-card")).toContainText("Clean");
  await expect(page.locator("#git-clean")).toContainText("Working tree clean");
  await expect(page.locator("#last-commit-card")).toContainText("fixture commit");
  await expect(page.locator("#remotes-card")).toContainText("origin");
  await expect(page.locator("#git-fetch")).toBeEnabled();
  await expect(page.locator("#git-update")).toBeEnabled();
  await expect(page.locator("#git-push")).toBeEnabled();

  await expect(page.locator("#ssh-panel-title")).toHaveText("SSH access");
  await expect(page.locator("#ssh-panel")).toContainText("1 allowed host");
  await expect(page.locator("#ssh-panel")).toContainText("2 pending approvals");
  await expect(page.locator("#ssh-grants")).toContainText("test-host");
  await expect(page.locator("#ssh-grants")).toContainText("Active");
  await expect(page.locator("#ssh-approvals")).toContainText("echo approve e2e");
  await expect(page.locator("#ssh-audit")).toHaveCount(0);
  await expect(page.locator("#ssh-panel")).toContainText("No audit entries.");

  for (const href of [
    `/chat?app=alpha&project=${PROJECT_ONE}`,
    `/terminal?app=alpha&project=${PROJECT_ONE}`,
    `/projects/${PROJECT_ONE}/apps/alpha/settings`,
    `/projects/${PROJECT_ONE}/apps/alpha/skills`,
    `/ssh?project=${PROJECT_ONE}&app=alpha`,
  ]) {
    await expect(page.locator(`a[href="${href}"]`).first()).toBeAttached();
  }
  await expect(page.locator('a[href^="/ide/"]').first()).toBeAttached();

  // The SPA document must not load the legacy island scripts.
  await expect(page.locator('script[src*="git.js"]')).toHaveCount(0);
  await expect(page.locator('script[src*="images.js"]')).toHaveCount(0);
  await expect(page.locator('script[src*="ssh.js"]')).toHaveCount(0);

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.locator("#group-git-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#group-image-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#group-ssh-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#image-panel")).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("restarts the agent and refreshes the props", async ({ page }) => {
  const errors = collectPageErrors(page);
  await openApp(page);

  await page.locator("#app-restart").click();
  await expect(page.locator("#app-restart-dialog")).toBeVisible();
  await expect(page.locator("#app-restart-dialog")).toContainText("Restart alpha?");
  await page.locator("#app-restart-dialog").getByRole("button", { name: "Restart agent" }).click();

  await expect(page.getByText("Agent restarted.")).toBeVisible();
  await expect(page.locator("#app-restart-dialog")).not.toHaveAttribute("open");
  await expect(page.locator("#settings-state")).toContainText("Applied", { timeout: 15_000 });

  await settle(page);
  expectNoPageErrors(errors);
});

test("surfaces a restart failure without breaking the page", async ({ page }) => {
  // The intentional 503 is surfaced by the browser as one network console message; this test
  // asserts the app-level error handling, while the success and read tests assert no console or
  // page errors on the normal path.
  await openApp(page);

  await page.route(/\/api\/apps\/alpha\/restart\?/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "restart unavailable", code: "runtime_unavailable" }),
    }),
  );

  await page.locator("#app-restart").click();
  await page.locator("#app-restart-dialog").getByRole("button", { name: "Restart agent" }).click();

  await expect(page.getByText("restart unavailable")).toBeVisible();
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
});

test("mounts without a fallback flash or console errors", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_PATH);

  await page.goto(APP_PATH, { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("renders clean, dirty, detached, and conflicted git states", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await openApp(page);
  await openGroup(page, "git");
  await expect(page.locator("#repository-card").getByText("Clean", { exact: true })).toBeVisible();
  await expect(page.locator("#remotes-card")).toContainText("origin");

  prepareGitState(PROJECT_ONE, "beta", "dirty");
  await page.goto(BETA_PATH);
  await openGroup(page, "git");
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();
  await expect(page.locator("#repository-card")).toContainText("Changes");
  await expect(page.locator("#git-change-counts")).toContainText("Staged 1");
  await expect(page.locator("#git-change-counts")).toContainText("Unstaged 1");
  await expect(page.locator("#git-change-counts")).toContainText("Untracked 1");
  await expect(page.locator("#git-changes-body")).toContainText("staged.txt");
  await expect(page.locator("#git-changes-body")).toContainText("untracked.txt");
  await expect(page.locator("#git-commit-form")).toBeVisible();

  prepareGitState(PROJECT_TWO, "gamma", "detached");
  await page.goto(GAMMA_PATH);
  await openGroup(page, "git");
  await expect(page.getByRole("heading", { name: "gamma", exact: true })).toBeVisible();
  await expect(page.locator("#git-branch")).toContainText("Detached HEAD");
  await expect(page.locator("#repository-card")).toContainText("Detached");
  await expect(page.locator("#git-branch-select")).toContainText("Choose a branch");
  await expect(page.locator("#git-update")).toBeDisabled();
  await expect(page.locator("#git-push")).toBeDisabled();
  await expect(page.locator("#git-commit")).toHaveCount(0);

  prepareGitState(PROJECT_ONE, "beta", "conflicted");
  await page.goto(BETA_PATH);
  await openGroup(page, "git");
  await expect(page.locator("#repository-card")).toContainText("Conflicts");
  await expect(page.locator("#git-change-counts")).toContainText("Conflicted 1");
  await expect(page.locator("#git-commit")).toBeDisabled();
  await expect(page.locator("#git-switch")).toBeDisabled();
  await expect(page.locator("#git-commit-hint")).toContainText("Resolve conflicts");

  await settle(page);
  expectNoPageErrors(errors);
});

test("refreshes status on demand and renders ahead and behind counts", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "ahead");
  await openApp(page);
  await openGroup(page, "git");
  await expect(page.locator("#git-upstream")).toContainText("1 ahead");

  prepareGitState(PROJECT_ONE, "alpha", "behind");
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-upstream")).toContainText("1 behind");

  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-upstream")).toContainText("origin/main");
  await expect(page.locator("#git-upstream")).not.toContainText("behind");
  await expect(page.locator("#git-upstream")).not.toContainText("ahead");

  await settle(page);
  expectNoPageErrors(errors);
});

test("commits every change group and updates the last commit", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "beta", "dirty");
  await signIn(page, BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();
  await openGroup(page, "git");

  await page.locator("#git-commit-message").fill("E2E commit from SPA");
  await page.locator("#git-commit").click();

  await expect(toast(page, "Committed as")).toBeVisible();
  await expect(page.locator("#repository-card")).toContainText("Clean");
  await expect(page.locator("#git-clean")).toContainText("Working tree clean");
  await expect(page.locator("#git-commit-form")).toHaveCount(0);
  await expect(page.locator("#last-commit-card")).toContainText("E2E commit from SPA");

  await settle(page);
  expectNoPageErrors(errors);
});

test("fetches, updates, pushes, and switches branches", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "behind");
  await openApp(page);
  await openGroup(page, "git");
  await expect(page.locator("#git-upstream")).toContainText("1 behind");

  await page.locator("#git-fetch").click();
  await expect(toast(page, "Fetched all remotes.")).toBeVisible();
  await expect(page.locator("#git-upstream")).toContainText("1 behind");

  await page.locator("#git-update").click();
  await expect(toast(page, "Branch updated to")).toBeVisible();
  await expect(page.locator("#git-upstream")).not.toContainText("behind");
  await expect(page.locator("#repository-card")).toContainText("Clean");

  prepareGitState(PROJECT_ONE, "alpha", "ahead");
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-upstream")).toContainText("1 ahead");
  await page.locator("#git-push").click();
  await expect(toast(page, "Pushed to origin/main.")).toBeVisible();
  await expect(page.locator("#git-upstream")).not.toContainText("ahead");

  await page.locator("#git-branch-select").selectOption("feature");
  await page.locator("#git-switch").click();
  await expect(toast(page, "Switched to feature.")).toBeVisible();
  await expect(page.locator("#git-branch")).toContainText("feature");

  await page.locator("#git-switch").click();
  await expect(page.locator("#git-notice")).toContainText("You are already on feature.");

  await settle(page);
  expectNoPageErrors(errors);
});

test("maps git action and status failures to the legacy messages", async ({ page }) => {
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await openApp(page);
  await openGroup(page, "git");

  await page.route(/\/git\/push$/, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "push rejected upstream", code: "push_rejected" }),
    }),
  );
  await page.locator("#git-push").click();
  await expect(
    toast(
      page,
      "The remote has commits you do not have. Fetch and update the branch, then try again.",
    ),
  ).toBeVisible();
  await expect(page.locator("#git-notice")).toContainText("Push rejected");
  await page.unroute(/\/git\/push$/);

  await page.route(/\/git\/update$/, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "diverged", code: "diverged" }),
    }),
  );
  await page.locator("#git-update").click();
  await expect(
    toast(page, "The branch has diverged from its upstream. Reconcile it in the IDE."),
  ).toBeVisible();
  await expect(page.locator("#git-notice")).toContainText("Update stopped");
  await page.unroute(/\/git\/update$/);

  await page.route(/\/git\/status$/, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "coordinator unavailable", code: "git_failed" }),
    }),
  );
  await page.locator("#git-refresh").click();
  await expect(page.locator("#repository-card")).toContainText("Repository status unavailable");
  await expect(page.locator("#repository-card")).toContainText("coordinator unavailable");
  await page.unroute(/\/git\/status$/);
  await page.locator("#repository-card").getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#repository-card")).toContainText("Clean");
});

test("validates the commit message and warns before switching to the current branch", async ({
  page,
}) => {
  prepareGitState(PROJECT_ONE, "beta", "dirty");
  await signIn(page, BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();
  await openGroup(page, "git");

  let commits = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/git/commit")) {
      commits += 1;
    }
  });
  await page.locator("#git-commit").click();
  await expect(page.locator("#git-commit-error")).toContainText("A message is required");
  expect(commits).toBe(0);

  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await page.goto(APP_PATH);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await openGroup(page, "git");
  await page.locator("#git-branch-select").selectOption("main");
  await page.locator("#git-switch").click();
  await expect(page.locator("#git-notice")).toContainText("You are already on main.");
});

test("drives the custom image matrix through build, logs, poll, and rollback", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();
  await openGroup(page, "image");

  await expect(page.locator("#image-panel")).toHaveAttribute("data-status", "error");
  await expect(page.locator("#image-status")).toContainText("Build failed");
  await expect(page.locator("#image-ref")).toHaveText("hanse-beta:broken");
  await expect(page.locator("#image-error")).toContainText("fixture build failed");
  await expect(page.locator("#image-build")).toContainText("Retry build");

  await page.locator("#image-build").click();
  await expect(toast(page, "Image build started.")).toBeVisible();
  await expect(page.locator("#image-status")).toContainText("Building");
  await expect(page.locator("#image-build")).toBeDisabled();
  await expect(page.locator("#image-logs-details")).toHaveAttribute("open", "");
  await expect(page.locator("#image-logs")).toContainText("Building fixture image", {
    timeout: 10_000,
  });

  await expect(page.locator("#image-status")).toContainText("Built", { timeout: 15_000 });
  await expect(page.locator("#image-ref")).toHaveText("hanse-beta:rebuilt");
  await page.locator("#image-refresh").click();
  await expect(page.locator("#image-logs")).toContainText("Build complete.");

  if (!(await page.locator("#image-details").getAttribute("open"))) {
    await page.locator("#image-details > summary").click();
  }
  await page.locator("#image-rollback").click();
  await expect(page.locator("#image-rollback-dialog")).toBeVisible();
  await expect(page.locator("#image-rollback-dialog")).toContainText("hanse-beta:broken");
  await page.locator("#image-rollback-confirm").click();
  await expect(toast(page, "Image rolled back.")).toBeVisible();
  await expect(page.locator("#image-ref")).toHaveText("hanse-beta:broken");

  await settle(page);
  expectNoPageErrors(errors);
});

test("checks the default image and renders an out-of-date custom image", async ({ page }) => {
  const errors = collectPageErrors(page);
  await openApp(page);
  await openGroup(page, "image");

  await page.locator("#image-check").click();
  await expect(toast(page, "Default image is current.")).toBeVisible();
  await expect(page.locator("#image-ref")).toHaveText("Default agent image");

  await page.goto(GAMMA_PATH);
  await openGroup(page, "image");
  await expect(page.getByRole("heading", { name: "gamma", exact: true })).toBeVisible();
  await expect(page.locator("#image-status")).toContainText("Out of date");
  await expect(page.locator("#image-panel")).toContainText("Drift");
  await expect(page.locator("#image-ref")).toHaveText("hanse-gamma:latest");

  await settle(page);
  expectNoPageErrors(errors);
});

test("grants, revokes, approves, rejects, and refreshes app-scoped SSH", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();
  await openGroup(page, "ssh");

  await expect(page.locator("#ssh-panel")).toContainText("2 pending approvals");
  await expect(page.locator("#ssh-grants")).toContainText("test-host");
  await expect(page.locator("#ssh-audit")).toContainText("echo app audit e2e");

  const rejectRow = page.locator("#ssh-approvals tbody tr", { hasText: "echo reject app e2e" });
  await rejectRow.getByRole("button", { name: "Reject" }).click();
  await expect(toast(page, "Approval recorded")).toBeVisible();
  await expect(
    page.locator("#ssh-approvals tbody tr", { hasText: "echo reject app e2e" }),
  ).toHaveCount(0);

  // Approving supersedes the other pending request for the same app/host, so reject first.
  const approveRow = page.locator("#ssh-approvals tbody tr", { hasText: "echo approve app e2e" });
  await approveRow.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.locator("#toast-region .toast", { hasText: "Approval recorded" }).last(),
  ).toBeVisible();
  await expect(
    page.locator("#ssh-approvals tbody tr", { hasText: "echo approve app e2e" }),
  ).toHaveCount(0);

  await page
    .locator("#ssh-grants tbody tr")
    .first()
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(toast(page, "Grant revoked")).toBeVisible();

  await page.locator("#ssh-access-manage summary").click();
  const secondHost = page.locator("#ssh-allowlist label", { hasText: "app-host" });
  await expect(secondHost).toBeVisible();
  await secondHost.locator("input[type='checkbox']").check();
  await page.locator("#ssh-allowlist-save").click();
  await expect(toast(page, "Allowlist saved")).toBeVisible();
  await expect(page.locator("#ssh-panel")).toContainText("2 allowed hosts");

  await page.locator("#ssh-audit-refresh").click();
  await expect(toast(page, "Audit refreshed.")).toBeVisible();
  await expect(page.locator("#ssh-audit")).toContainText("echo app audit e2e");

  await settle(page);
  expectNoPageErrors(errors);
});

test("collapses groups by default and remembers open state per app", async ({ page }) => {
  const errors = collectPageErrors(page);
  await openApp(page);

  await expect(page.locator("#group-git-toggle")).toHaveAttribute("aria-expanded", "false");
  await openGroup(page, "git");
  await expect(page.locator("#group-git-toggle")).toHaveAttribute("aria-expanded", "true");

  await page.goto(BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();
  await expect(page.locator("#group-git-toggle")).toHaveAttribute("aria-expanded", "false");

  await page.goto(APP_PATH);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.locator("#group-git-toggle")).toHaveAttribute("aria-expanded", "true");

  await settle(page);
  expectNoPageErrors(errors);
});

test("deletes an application only with the exact name", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();
  await openGroup(page, "danger");

  await page.locator("#app-delete").click();
  const dialog = page.locator("#application-delete-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Type beta to confirm");
  const submit = dialog.getByRole("button", { name: "Delete application" });
  await expect(submit).toBeDisabled();

  await dialog.locator("#application-delete-confirm").fill("wrong");
  await expect(submit).toBeDisabled();

  const request = page.waitForRequest(
    (candidate) =>
      candidate.method() === "POST" &&
      candidate.url().endsWith(`/api/projects/${PROJECT_ONE}/apps/beta/delete`),
  );
  await dialog.locator("#application-delete-confirm").fill("beta");
  await submit.click();
  const posted = await request;
  const body = posted.postData() ?? "";
  expect(body).toContain("confirm=beta");
  expect(body).toContain("return_to=%2Fprojects%2F");
  await expect(toast(page, "Application deleted.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}$`));

  await settle(page);
  expectNoPageErrors(errors);
});

test("renders the Memory card between the state strip and Git with summary, chart, OOM, and table", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  const memory = await mockMemory(page, "normal");
  await openMemoryCard(page);

  const placement = await page.evaluate(() => {
    const state = document.querySelector("#app-state");
    const card = document.querySelector("#app-memory");
    const git = document.querySelector("#group-git-toggle");
    if (state === null || card === null || git === null) return null;
    return {
      afterState: (state.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      beforeGit: (card.compareDocumentPosition(git) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    };
  });
  expect(placement).toEqual({ afterState: true, beforeGit: true });

  const values = memorySummaryValues(page);
  await expect(values).toHaveCount(4);
  await expect(values.nth(0)).toHaveText("500 MiB");
  await expect(values.nth(1)).toHaveText("1.5 GiB");
  await expect(values.nth(2)).toHaveText("400 MiB");
  await expect(values.nth(3)).toHaveText("2 GiB");
  const labels = page.locator("#app-memory .memory-summary .watch__label");
  await expect(labels.nth(0)).toHaveText("Current");
  await expect(labels.nth(1)).toContainText("Peak");
  await expect(labels.nth(2)).toHaveText("Average");
  await expect(labels.nth(3)).toHaveText("Limit");

  await expect(page.locator("#app-memory .memory-chart__svg")).toBeVisible();
  await expect(page.locator("#app-memory .memory-chart__line")).toHaveCount(1);
  await expect(page.locator("#app-memory .memory-chart__band")).toHaveCount(1);
  await expect(page.locator("#app-memory .memory-chart__limit")).toHaveCount(1);
  await expect(page.locator("#app-memory .memory-chart__limit-label")).toContainText("Limit 2 GiB");
  await expect(page.locator("#app-memory .memory-legend")).toContainText("min–max band");
  await expect(page.locator("#app-memory .memory-legend")).toContainText("working-set average");
  await expect(page.locator("#app-memory .memory-legend")).toContainText("limit");
  await expect(page.locator("#app-memory .memory-legend")).toContainText("OOM");

  await expect(page.locator("#app-memory .memory-oom-badge")).toHaveText(/1\s*OOM/);
  const marker = page.locator("#app-memory .memory-oom");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("aria-label", /^OOM at \d{2}:\d{2}$/);
  await expect(page.locator("#app-memory .memory-chart__now")).toHaveCount(1);

  await page.locator("#app-memory details.memory-table > summary").click();
  const table = page.locator("#app-memory details.memory-table");
  await expect(table).toHaveAttribute("open", "");
  await expect(table.locator("thead th")).toHaveText([
    "Bucket start",
    "Min",
    "Average",
    "Max",
    "OOM",
  ]);
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveCount(4);

  await expect(
    page.locator('#app-memory a[href$="/settings#setting-runtime-memory"]'),
  ).toHaveAttribute("href", `/projects/${PROJECT_ONE}/apps/alpha/settings#setting-runtime-memory`);
  expect(memory.requests.length).toBeGreaterThan(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("persists the memory range and bucket and disables 10-minute buckets at 72h", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  const memory = await mockMemory(page, "normal");
  await openMemoryCard(page);

  const range = page.locator("#app-memory .segmented");
  await expect(range.getByRole("button", { name: "24 h" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#memory-bucket")).toHaveValue("auto");
  expect(
    memory.requests.some((query) => query.get("window") === "24h" && query.get("bucket") === "30m"),
  ).toBe(true);

  await range.getByRole("button", { name: "6 h" }).click();
  await expect(range.getByRole("button", { name: "6 h" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => new URL(page.url()).searchParams.get("mem")).toBe("6h:auto");
  await expect
    .poll(() =>
      memory.requests.some(
        (query) => query.get("window") === "6h" && query.get("bucket") === "10m",
      ),
    )
    .toBe(true);

  await page.locator("#memory-bucket").selectOption("30m");
  await expect.poll(async () => new URL(page.url()).searchParams.get("mem")).toBe("6h:30m");
  await expect
    .poll(() => memory.requests.some((query) => query.get("bucket") === "30m"))
    .toBe(true);

  await range.getByRole("button", { name: "72 h" }).click();
  await expect(range.getByRole("button", { name: "72 h" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => new URL(page.url()).searchParams.get("mem")).toBe("72h:30m");
  await expect(page.locator('#memory-bucket option[value="10m"]')).toHaveAttribute("disabled", "");
  await expect(page.locator("#memory-bucket-reason")).toContainText("the 72-hour range");
  await expect
    .poll(() =>
      memory.requests.some(
        (query) => query.get("window") === "72h" && query.get("bucket") === "30m",
      ),
    )
    .toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await expect(
    page.locator("#app-memory .segmented").getByRole("button", { name: "72 h" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#memory-bucket")).toHaveValue("30m");
  await expect(page.locator('#memory-bucket option[value="10m"]')).toHaveAttribute("disabled", "");
  await expect.poll(async () => new URL(page.url()).searchParams.get("mem")).toBe("72h:30m");

  await settle(page);
  expectNoPageErrors(errors);
});

test("renders two coalesced OOM markers and the OOM badge", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await mockMemory(page, "oom");
  await openMemoryCard(page);

  await expect(page.locator("#app-memory .memory-oom-badge")).toHaveText(/2\s*OOM/);
  const markers = page.locator("#app-memory .memory-oom");
  await expect(markers).toHaveCount(1);
  await expect(markers.first()).toHaveAttribute("aria-label", /^2 OOM events near \d{2}:\d{2}$/);
  await expect(page.locator("#app-memory .memory-chart__note")).toContainText(
    "coalesced to at most one per minute",
  );

  await markers.first().click();
  await expect(page.locator("#app-memory .memory-readout")).toContainText("2 OOM events near");
  await expect(page.locator("#app-memory .memory-readout")).toContainText(
    "container exited with code 137",
  );

  await settle(page);
  expectNoPageErrors(errors);
});

test("renders the never-sampled and no-data-in-range memory states", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  const memory = await mockMemory(page, "never");
  await openMemoryCard(page);

  await expect(page.locator("#app-memory .memory-empty")).toHaveText(
    "No memory samples yet. Samples appear after this agent starts.",
  );
  await expect(memorySummaryValues(page).nth(3)).toHaveText("—");
  await expect(page.locator("#app-memory .memory-chart__svg")).toHaveCount(0);
  await expect(page.locator("#app-memory .memory-oom-badge")).toHaveCount(0);

  memory.mode = "range";
  await page.reload();
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.locator("#app-memory .memory-empty")).toContainText(
    "No samples in the last 24 hours.",
  );
  await memorySummaryValues(page).nth(3).waitFor();
  await expect(memorySummaryValues(page).nth(3)).toHaveText("—");

  await page.locator("#app-memory").getByRole("button", { name: "Show 72 hours" }).click();
  await expect.poll(async () => new URL(page.url()).searchParams.get("mem")).toBe("72h:auto");
  await expect(page.locator("#app-memory .memory-empty")).toContainText(
    "No samples in the last 72 hours.",
  );
  await expect(
    page.locator("#app-memory").getByRole("button", { name: /^Show \d+ hours$/ }),
  ).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("shows a retryable memory error and recovers", async ({ page }) => {
  const memory = await mockMemory(page, "error");
  await openApp(page);

  const alert = page.locator("#app-memory .memory-error[role='alert']");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("memory sampling unavailable");
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.locator("#app-memory .memory-chart__svg")).toHaveCount(0);

  memory.mode = "normal";
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toHaveCount(0);
  await expect(memorySummaryValues(page).nth(0)).toHaveText("500 MiB");
  await expect(memorySummaryValues(page).nth(3)).toHaveText("2 GiB");
});

test("collapses the memory chart behind Show chart on a 390px viewport", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await mockMemory(page, "normal");
  await openMemoryCard(page);

  const toggle = page.locator("#app-memory .memory-chart-toggle");
  await expect(toggle).toHaveText("Show chart");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#memory-chart-body")).toHaveCount(0);
  await expect(page.locator("#app-memory .memory-summary")).toBeVisible();
  await expect(page.locator("#app-memory .memory-oom-badge")).toBeVisible();
  await expect(page.locator('#memory-bucket option[value="10m"]')).toHaveAttribute("disabled", "");
  await expect(page.locator("#memory-bucket-reason")).toContainText("screens narrower than 768 px");

  await toggle.click();
  await expect(page.locator("#memory-chart-body")).toBeVisible();
  await expect(toggle).toHaveText("Hide chart");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#app-memory .memory-legend")).toBeVisible();
  await expect(page.locator("#app-memory .memory-oom")).toBeVisible();
  await expect(page.locator("#app-memory .memory-summary")).toBeVisible();
  await expect(page.locator("#app-memory .memory-oom-badge")).toBeVisible();

  await toggle.click();
  await expect(page.locator("#memory-chart-body")).toHaveCount(0);
  await expect(toggle).toHaveText("Show chart");
  await expect(page.locator("#app-memory .memory-summary")).toBeVisible();
  await expect(page.locator("#app-memory .memory-oom-badge")).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
