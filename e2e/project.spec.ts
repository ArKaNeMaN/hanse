import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  E2E_SPA_REMOTE,
  expectNoPageErrors,
  MASTER_PROJECT,
  PROJECT_ONE,
  PROJECT_TWO,
  settle,
  signIn,
} from "./support/helpers.js";

function unique(label: string): string {
  return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function addApplication(
  page: Page,
  name: string,
  options: { path?: string; remote?: string } = {},
): Promise<void> {
  await page.getByRole("button", { name: "Add app" }).click();
  const dialog = page.locator("#add-app");
  await expect(dialog).toBeVisible();
  await dialog.locator("#add-app-name").fill(name);
  if (options.path !== undefined) {
    await dialog.locator("#add-app-path").fill(options.path);
  }
  if (options.remote !== undefined) {
    await dialog.locator("#add-app-remote").fill(options.remote);
  }
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/projects/${PROJECT_ONE}/apps` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Add application" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  await expect(page.locator("#toast-region")).toContainText("Application added.");
}

async function createHandoff(
  page: Page,
  summary: string,
  options: { requiresApproval?: boolean } = {},
): Promise<number> {
  await page.getByRole("button", { name: "New handoff" }).click();
  const dialog = page.locator("#new-handoff");
  await expect(dialog).toBeVisible();
  await dialog.locator("#handoff-summary").fill(summary);
  await dialog.locator("#handoff-from").selectOption("alpha");
  await dialog.locator("#handoff-to").selectOption("beta");
  await dialog.locator("#handoff-spec").fill("E2E specification.");
  if (options.requiresApproval !== true) {
    await dialog.getByLabel("Require operator approval for this handoff").uncheck();
  }
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/handoffs" &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create handoff" }).click();
  const response = await responsePromise;
  return response.status();
}

async function openReview(page: Page, summary: string): Promise<void> {
  await page
    .locator('section[aria-labelledby="project-handoffs-title"] tbody tr', { hasText: summary })
    .getByRole("button", { name: "Review" })
    .click();
  await expect(page.locator("dialog.handoff-dialog")).toBeVisible();
}

test("renders the project header, watch strip, apps, handoffs, policy, manifest, and danger zone", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await expect(page.getByText("Applications, handoff routes")).toBeVisible();

  const watchValues = await page.locator(".watch__value").allTextContents();
  expect(watchValues[0]).toBe("2");
  expect(watchValues[1]).toBe("1");
  expect(watchValues[2]).toBe("1");
  expect(watchValues[3]?.length).toBeGreaterThan(0);

  const apps = page.locator('section[aria-labelledby="apps-title"]');
  await expect(apps.getByRole("link", { name: "alpha", exact: true })).toHaveAttribute(
    "href",
    `/projects/${PROJECT_ONE}/apps/alpha`,
  );
  await expect(apps.getByRole("link", { name: "beta", exact: true })).toBeVisible();
  await expect(apps).toContainText("Running");
  await expect(apps).toContainText("Stopped");
  await expect(apps.getByRole("link", { name: "Chat" }).first()).toHaveAttribute(
    "href",
    `/chat?app=alpha&project=${PROJECT_ONE}`,
  );

  const handoffs = page.locator('section[aria-labelledby="project-handoffs-title"]');
  await expect(handoffs).toContainText("E2E handoff summary");
  await expect(handoffs).toContainText("E2E reply handoff");
  await expect(handoffs.locator("tbody tr").first()).toBeVisible();

  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Handoff policy" })).toBeVisible();
  await expect(page.getByText(".hanse/project.yaml")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Danger zone" })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("adds an application by path and by clone", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  const byPath = unique("PathApp").replace(/\s+/g, "-");
  await addApplication(page, byPath, { path: `apps/${byPath}` });
  await expect(
    page
      .locator('section[aria-labelledby="apps-title"]')
      .getByRole("link", { name: byPath, exact: true }),
  ).toBeVisible();

  const byClone = unique("CloneApp").replace(/\s+/g, "-");
  await addApplication(page, byClone, { path: `apps/${byClone}`, remote: E2E_SPA_REMOTE });
  await expect(
    page
      .locator('section[aria-labelledby="apps-title"]')
      .getByRole("link", { name: byClone, exact: true }),
  ).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("creates queued and awaiting-approval handoffs", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  const queued = unique("Queued handoff");
  expect(await createHandoff(page, queued)).toBe(201);
  await expect(page.locator("#toast-region")).toContainText("Handoff created.");
  await expect(page.locator('section[aria-labelledby="project-handoffs-title"]')).toContainText(
    queued,
  );

  const awaiting = unique("Awaiting handoff");
  expect(await createHandoff(page, awaiting, { requiresApproval: true })).toBe(202);
  await expect(page.locator("#toast-region")).toContainText(
    "Handoff created; awaiting operator approval.",
  );
  await expect(page.locator('section[aria-labelledby="project-handoffs-title"]')).toContainText(
    awaiting,
  );

  await settle(page);
  expectNoPageErrors(errors);
});

test("approves and rejects a handoff from the review dialog", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  const approveSummary = unique("Approve handoff");
  expect(await createHandoff(page, approveSummary, { requiresApproval: true })).toBe(202);
  await openReview(page, approveSummary);

  const approveResponse = page.waitForResponse(
    (response) =>
      /\/api\/handoffs\/[^/]+\/decision$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Approve handoff" }).click();
  expect((await approveResponse).status()).toBe(200);
  await expect(page.locator("#toast-region")).toContainText("Handoff approved.");

  const rejectSummary = unique("Reject handoff");
  expect(await createHandoff(page, rejectSummary, { requiresApproval: true })).toBe(202);
  await openReview(page, rejectSummary);

  const rejectResponse = page.waitForResponse(
    (response) =>
      /\/api\/handoffs\/[^/]+\/decision$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reject handoff" }).click();
  expect((await rejectResponse).status()).toBe(200);
  await expect(page.locator("#toast-region")).toContainText("Handoff rejected.");

  await settle(page);
  expectNoPageErrors(errors);
});

test("relaunches, retries, and cancels handoffs through their existing JSON contracts", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  await openReview(page, "E2E reply handoff");
  const relaunchResponse = page.waitForResponse(
    (response) =>
      /\/api\/handoffs\/[^/]+\/reply\/relaunch$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Start in a new session" }).click();
  expect((await relaunchResponse).status()).toBe(200);
  await expect(page.locator("#toast-region")).toContainText("Reply started in a new session.");

  await openReview(page, "E2E retry reply handoff");
  const retryResponse = page.waitForResponse(
    (response) =>
      /\/api\/handoffs\/[^/]+\/reply\/deliver$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Retry reply delivery" }).click();
  expect((await retryResponse).status()).toBe(200);
  await expect(page.locator("#toast-region")).toContainText("Reply delivery queued.");

  await openReview(page, "E2E retry reply handoff");
  const cancelReplyResponse = page.waitForResponse(
    (response) =>
      /\/api\/handoffs\/[^/]+\/reply\/cancel$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Cancel reply" }).click();
  expect((await cancelReplyResponse).status()).toBe(200);
  await expect(page.locator("#toast-region")).toContainText("Reply delivery cancelled.");

  await openReview(page, "E2E cancel handoff");
  const cancelResponse = page.waitForResponse(
    (response) =>
      /\/api\/handoffs\/[^/]+\/cancel$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Cancel handoff" }).click();
  expect((await cancelResponse).status()).toBe(200);
  await expect(page.locator("#toast-region")).toContainText("Handoff cancelled.");

  await settle(page);
  expectNoPageErrors(errors);
});

test("saves and deletes a handoff policy rule", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  const policy = page.locator('section[aria-labelledby="handoff-policy-title"]');
  await policy.locator("#handoff-policy-from").selectOption("alpha");
  await policy.locator("#handoff-policy-to").selectOption("beta");
  await policy.locator("#handoff-policy-dispatch").selectOption("approve");
  await policy.locator("#handoff-policy-reply").selectOption("approve");

  const saveResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/projects/${PROJECT_ONE}/handoff-policy` &&
      response.request().method() === "POST",
  );
  await policy.getByRole("button", { name: "Save rule" }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.locator("#toast-region")).toContainText("Handoff policy saved.");
  await expect(policy.locator("tbody tr", { hasText: "alpha" })).toContainText("approve");

  const deleteResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/projects/${PROJECT_ONE}/handoff-policy/delete` &&
      response.request().method() === "POST",
  );
  await policy
    .locator("tbody tr", { hasText: "alpha" })
    .getByRole("button", { name: "Delete" })
    .click();
  expect((await deleteResponse).status()).toBe(200);
  await expect(page.locator("#toast-region")).toContainText("Handoff policy rule deleted.");
  await expect(policy.locator("tbody tr", { hasText: "alpha" })).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("deletes a project only with the exact name (fake deletion contract)", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_TWO}`);

  await page.getByRole("button", { name: "Delete project" }).click();
  const dialog = page.locator("#project-delete-dialog");
  await expect(dialog).toBeVisible();

  await dialog.locator("#project-delete-confirm").fill("E2E Project");
  await expect(dialog.getByRole("button", { name: "Delete project" })).toBeDisabled();
  await dialog.locator("#project-delete-confirm").fill("E2E Project Two");
  await expect(dialog.getByRole("button", { name: "Delete project" })).toBeEnabled();

  const requestPromise = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === `/api/projects/${PROJECT_TWO}/delete` &&
      request.method() === "POST",
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/projects/${PROJECT_TWO}/delete` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Delete project" }).click();
  const request = await requestPromise;
  expect(new URLSearchParams(request.postData() ?? "").get("confirm")).toBe("E2E Project Two");
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");

  await expect(page).toHaveURL(/\/projects\?notice=/);
  await expect(page.locator("#toast-region")).toContainText("Project deleted.");

  await settle(page);
  expectNoPageErrors(errors);
});

test("the master project is read-only and exposes only navigation links", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${MASTER_PROJECT}`);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Hanse master" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Master agent" })).toBeVisible();
  await expect(page.locator(".watch__label")).toHaveText(["Runtime", "Kind"]);

  await expect(page.getByRole("link", { name: "Open chat" }).first()).toHaveAttribute(
    "href",
    `/chat?app=master&project=${MASTER_PROJECT}`,
  );
  await expect(
    page.locator("#main").getByRole("link", { name: "Skills", exact: true }),
  ).toHaveAttribute("href", `/projects/${MASTER_PROJECT}/apps/master/skills`);

  await expect(page.getByRole("heading", { name: "Danger zone" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add app" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New handoff" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Delete/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Applications" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Handoffs" })).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});
