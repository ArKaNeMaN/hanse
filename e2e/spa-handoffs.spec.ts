import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, settle, signIn } from "./support/helpers.js";

const CHROME_FIXTURE = {
  sidebarNav: '<p class="nav-label">Workbench</p>',
  breadcrumb: '<span class="crumb">Swapped Inbox</span>',
  title: "Handoffs Swapped",
  active: "handoffs",
  pendingCount: 0,
  sshPendingCount: 0,
};

const EMPTY_PROPS = {
  counts: { all: 0, waiting: 0, active: 0, closed: 0, replies: 0 },
  filter: "closed",
  query: "",
  filters: [
    { value: "all", label: "All", href: "/handoffs", count: 0, current: false },
    {
      value: "waiting",
      label: "Waiting",
      href: "/handoffs?filter=waiting",
      count: 0,
      current: false,
    },
    { value: "active", label: "Active", href: "/handoffs?filter=active", count: 0, current: false },
    { value: "closed", label: "Closed", href: "/handoffs?filter=closed", count: 0, current: true },
    {
      value: "replies",
      label: "Replies",
      href: "/handoffs?filter=replies",
      count: 0,
      current: false,
    },
  ],
  search: {
    action: "/handoffs",
    filter: "closed",
    query: "",
    hiddenFilter: "closed",
    placeholder: "Id, summary, application",
    clearHref: null,
  },
  returnTo: "/handoffs?filter=closed",
  tableTitle: "Closed handoffs",
  rows: [],
  emptyState: {
    iconName: "branch",
    title: "No handoffs yet",
    body: "Handoffs route work between applications. Open a project to create the first one.",
    actionLabel: "Open a project",
    actionHref: "/projects",
  },
};

test("deep links, filter queries, and refreshes keep the boot document", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/handoffs?filter=waiting&q=E2E");

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Handoffs", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/handoffs\?filter=waiting&q=E2E$/);
  await expect(page.locator("#handoff-search")).toHaveValue("E2E");
  await expect(page.locator(".segmented__item[aria-current='page']")).toContainText("Waiting");
  await expect(page.getByText("Waiting for approval")).toBeVisible();

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#handoff-search")).toHaveValue("E2E");

  await page.goto("/handoffs");
  await expect(page.locator(".segmented__item[aria-current='page']")).toContainText("All");
  await page.locator(".segmented__item", { hasText: "Waiting" }).first().click();
  await expect(page).toHaveURL(/\/handoffs\?filter=waiting$/);
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await page.goBack();
  await expect(page).toHaveURL(/\/handoffs$/);
  await expect(page.locator(".segmented__item[aria-current='page']")).toContainText("All");

  await page.goForward();
  await expect(page).toHaveURL(/\/handoffs\?filter=waiting$/);
  await expect(page.locator(".segmented__item[aria-current='page']")).toContainText("Waiting");
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("navigates to handoffs from overview and swaps chrome, title, and active nav", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/");

  await page.route(/\/api\/ui\/chrome\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CHROME_FIXTURE),
    }),
  );

  await page.locator("#main").getByRole("link", { name: "Handoffs inbox" }).click();
  await expect(page).toHaveURL(/\/handoffs$/);
  await expect(page.getByRole("heading", { name: "Handoffs", exact: true })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#breadcrumb-host")).toContainText("Swapped Inbox");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "handoffs");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "handoffs");
  await expect(page).toHaveTitle("Handoffs Swapped - hanse");

  await settle(page);
  expectNoPageErrors(errors);
});

test("?legacy=1 and the rollback servers serve the legacy inbox", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/handoffs");

  const legacy = await page.goto("/handoffs?legacy=1");
  expect(legacy?.status()).toBe(200);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Handoffs", exact: true })).toBeVisible();
  await expect(page.locator("#handoff-search")).toBeVisible();
  await expect(page.getByText("E2E handoff summary").first()).toBeVisible();

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    const response = await page.goto(`${origin}/handoffs`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Handoffs", exact: true })).toBeVisible();
    await expect(page.locator("#handoff-search")).toBeVisible();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("renders Markdown safely without fallback flash or console errors", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/handoffs?q=E2E%20inbox%20relaunch%20reply");

  await page.goto("/handoffs?q=E2E%20inbox%20relaunch%20reply", {
    waitUntil: "domcontentloaded",
  });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);
  await expect(page.getByRole("heading", { name: "Handoffs", exact: true })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await page
    .locator("tbody tr", { hasText: "E2E inbox relaunch reply" })
    .getByRole("button", { name: "Review" })
    .click();
  const dialog = page.locator("dialog.handoff-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".prose.handoff-md h4")).toHaveText("Relaunch reply");
  await expect(dialog.locator(".prose.handoff-md strong")).toHaveText("bold");
  await expect(dialog.locator(".prose.handoff-md code")).toHaveText("code");
  await expect(dialog.locator(".prose.handoff-md strong")).toHaveCount(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("a project link in the empty state navigates client-side", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/handoffs?filter=waiting");

  await page.route(/\/api\/ui\/handoffs\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_PROPS),
    }),
  );

  await page.locator(".segmented__item", { hasText: "Closed" }).first().click();
  await expect(page).toHaveURL(/\/handoffs\?filter=closed$/);
  await expect(page.getByText("No handoffs yet")).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await page.getByRole("link", { name: "Open a project" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await settle(page);
  expectNoPageErrors(errors);
});
