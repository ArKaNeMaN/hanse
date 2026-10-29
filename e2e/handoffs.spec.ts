import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

function spaMode(): boolean {
  return test.info().project.name === "spa";
}

function unique(label: string): string {
  return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function createAwaitingHandoff(page: Page, summary: string): Promise<string> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(`${origin}/api/handoffs`, {
    form: {
      project: PROJECT_ONE,
      from: "alpha",
      to: "beta",
      summary,
      spec: "E2E inline specification.",
      requires_approval: "1",
    },
    headers: { "x-hanse-client": "spa" },
  });
  expect(response.status()).toBe(202);
  const payload = (await response.json()) as { handoffId: string };
  return payload.handoffId;
}

async function expectAction(
  page: Page,
  action: RegExp,
  click: () => Promise<void>,
  message: string,
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) =>
      action.test(new URL(response.url()).pathname) && response.request().method() === "POST",
  );
  await click();
  const response = await responsePromise;
  expect(response.status()).toBe(spaMode() ? 200 : 303);
  await expect(page.locator("#toast-region")).toContainText(message);
}

async function openReview(page: Page, summary: string): Promise<void> {
  await page
    .locator("tbody tr", { hasText: summary })
    .getByRole("button", { name: "Review" })
    .click();
  await expect(page.locator("dialog.handoff-dialog[open]")).toBeVisible();
}

test("renders the handoff inbox, filters, and search in the active UI mode", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/handoffs");

  expect(await page.locator("#hanse-boot").count()).toBe(spaMode() ? 1 : 0);
  await expect(page.getByRole("heading", { name: "Handoffs", exact: true })).toBeVisible();
  await expect(page.getByText("Requests between sibling applications")).toBeVisible();
  await expect(page.locator(".segmented__item[aria-current='page']")).toContainText("All");

  await page.locator(".segmented__item", { hasText: "Waiting" }).first().click();
  await expect(page).toHaveURL(/\/handoffs\?filter=waiting$/);
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  await expect(page.getByText("E2E handoff summary").first()).toBeVisible();
  expect(await page.locator("#hanse-boot").count()).toBe(spaMode() ? 1 : 0);
  await expect(page.locator(".segmented__item[aria-current='page']")).toContainText("Waiting");
  await expect(page.locator('input[name="filter"]')).toHaveValue("waiting");

  await page.locator("#handoff-search").fill("E2E handoff summary");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/[?&]q=E2E[+%20]handoff[+%20]summary/);
  await expect(page.locator("tbody tr", { hasText: "E2E handoff summary" })).toHaveCount(1);

  await page.getByRole("link", { name: "Clear search" }).click();
  await expect(page).toHaveURL(/\/handoffs\?filter=waiting$/);
  await expect(page.locator("#handoff-search")).toHaveValue("");

  await settle(page);
  expectNoPageErrors(errors);
});

test("approves and rejects waiting rows inline through the decision contract", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/handoffs");

  const approveSummary = unique("Inline approve");
  const approveId = await createAwaitingHandoff(page, approveSummary);
  await page.goto(`/handoffs?filter=waiting&q=${encodeURIComponent(approveSummary)}`);
  const approveRow = page.locator(`#handoff-${approveId}`);
  await expect(approveRow).toContainText("Awaiting approval");

  await expectAction(
    page,
    /^\/api\/handoffs\/[^/]+\/decision$/,
    async () => {
      await approveRow.getByRole("button", { name: "Approve" }).click();
    },
    "Handoff approved.",
  );
  await page.goto(`/handoffs?q=${encodeURIComponent(approveSummary)}`);
  await expect(page.locator("tbody tr", { hasText: approveSummary })).toContainText(
    /Queued|Dispatching/,
  );

  const rejectSummary = unique("Inline reject");
  const rejectId = await createAwaitingHandoff(page, rejectSummary);
  await page.goto(`/handoffs?filter=waiting&q=${encodeURIComponent(rejectSummary)}`);
  const rejectRow = page.locator(`#handoff-${rejectId}`);
  await expect(rejectRow).toContainText("Awaiting approval");

  await expectAction(
    page,
    /^\/api\/handoffs\/[^/]+\/decision$/,
    async () => {
      await rejectRow.getByRole("button", { name: "Reject" }).click();
    },
    "Handoff rejected.",
  );
  await page.goto(`/handoffs?q=${encodeURIComponent(rejectSummary)}`);
  await expect(page.locator("tbody tr", { hasText: rejectSummary })).toContainText("Rejected");

  await settle(page);
  expectNoPageErrors(errors);
});

test("reviews, relaunches, retries, and cancels handoffs with safe Markdown", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/handoffs");

  await page.goto("/handoffs?q=E2E%20inbox%20relaunch%20reply");
  await openReview(page, "E2E inbox relaunch reply");
  const dialog = page.locator("dialog.handoff-dialog[open]");
  await expect(dialog.locator(".prose.handoff-md h4")).toHaveText("Relaunch reply");
  await expect(dialog.locator(".prose.handoff-md strong")).toHaveText("bold");
  await expect(dialog.locator(".prose.handoff-md code")).toHaveText("code");
  await expectAction(
    page,
    /^\/api\/handoffs\/[^/]+\/reply\/relaunch$/,
    async () => {
      await dialog.getByRole("button", { name: "Start in a new session" }).click();
    },
    "Reply started in a new session.",
  );

  await page.goto("/handoffs?q=E2E%20inbox%20retry%20reply");
  await openReview(page, "E2E inbox retry reply");
  await expectAction(
    page,
    /^\/api\/handoffs\/[^/]+\/reply\/deliver$/,
    async () => {
      await page
        .locator("dialog.handoff-dialog[open]")
        .getByRole("button", { name: "Retry reply delivery" })
        .click();
    },
    "Reply delivery queued.",
  );
  await openReview(page, "E2E inbox retry reply");
  await expectAction(
    page,
    /^\/api\/handoffs\/[^/]+\/reply\/cancel$/,
    async () => {
      await page
        .locator("dialog.handoff-dialog[open]")
        .getByRole("button", { name: "Cancel reply" })
        .click();
    },
    "Reply delivery cancelled.",
  );

  await page.goto("/handoffs?q=E2E%20inbox%20cancel%20handoff");
  await openReview(page, "E2E inbox cancel handoff");
  await expectAction(
    page,
    /^\/api\/handoffs\/[^/]+\/cancel$/,
    async () => {
      await page
        .locator("dialog.handoff-dialog[open]")
        .getByRole("button", { name: "Cancel handoff" })
        .click();
    },
    "Handoff cancelled.",
  );

  await settle(page);
  expectNoPageErrors(errors);
});
