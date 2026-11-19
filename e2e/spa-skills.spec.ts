import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";
import {
  E2E_COLLISION_SKILL_NAME,
  E2E_DISABLED_TOMBSTONE_NAME,
  E2E_GLOBAL_SKILL_NAME,
  E2E_HTTPS_TOKEN,
  E2E_INVALID_APP_SKILL_NAME,
  E2E_PROVIDER_SECRET,
  E2E_SHADOWED_INVALID_LOCAL_NAME,
} from "./support/seed.js";

const PROJECT_SKILLS = `/projects/${PROJECT_ONE}/skills`;
const APP_SKILLS = `/projects/${PROJECT_ONE}/apps/alpha/skills`;
const NEW_SKILL = `/skills/new?scope=project&project=${PROJECT_ONE}`;

async function chooseTarget(page: Page, name: string | RegExp): Promise<void> {
  await page.locator(".target-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Choose target" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("option", { name, exact: typeof name === "string" }).click();
  await expect(dialog).not.toBeVisible();
}

async function openManagedSkill(page: Page, name: string): Promise<void> {
  await page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${name}"]`).click();
  const drawer = page.locator("dialog.skill-preview-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: "Open full skill" }).click();
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#skill-details")).toBeVisible();
}

test("deep links, refresh, and history stay in one SPA document", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();

  const firstRow = page
    .locator('[data-skill-inventory] [data-skill-row][data-skill-mode="managed"]')
    .first();
  await firstRow.click();
  const drawer = page.locator("dialog.skill-preview-drawer");
  await expect(drawer).toBeVisible();
  const detailHref = await drawer
    .getByRole("link", { name: "Open full skill" })
    .getAttribute("href");
  expect(detailHref).not.toBeNull();
  await page.goto(detailHref ?? "/skills");
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#skill-details")).toBeVisible();

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#skill-details")).toBeVisible();

  await page.goto(NEW_SKILL);
  await expect(page.getByRole("heading", { name: "New skill" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#skill-details")).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/skills\/new/);
  await expect(page.getByRole("heading", { name: "New skill" })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("navigates between global, project, and application skills without a reload", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SKILLS);
  await page.evaluate(() => {
    (window as unknown as { __hanseSpaMarker?: number }).__hanseSpaMarker = 1;
  });

  await chooseTarget(page, /^Global$/);
  await expect(page).toHaveURL(/\/skills$/);
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}$`));

  await chooseTarget(page, "E2E Project One");
  await expect(page).toHaveURL(new RegExp(`${PROJECT_SKILLS}$`));
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "skills");
  await expect(page.locator("#breadcrumb-host")).toContainText("Skills");
  await expect(page).toHaveTitle("Skills - hanse");

  await openManagedSkill(page, E2E_GLOBAL_SKILL_NAME);

  expect(
    await page.evaluate(
      () => (window as unknown as { __hanseSpaMarker?: number }).__hanseSpaMarker,
    ),
  ).toBe(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("keeps the current inventory visible while switching scope", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SKILLS);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();

  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/ui\/skills\?scope=global\b/, async (route) => {
    await held;
    await route.continue();
  });

  await chooseTarget(page, /^Global$/);
  await page.waitForTimeout(150);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  await expect(page.getByText("Loading skills…")).toHaveCount(0);
  release?.();
  await expect(page).toHaveURL(/\/skills$/);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  await page.unroute(/\/api\/ui\/skills\?scope=global\b/);

  await settle(page);
  expectNoPageErrors(errors);
});

test("mounts without a fallback flash, console errors, or secret text", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");

  await page.goto("/skills", { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();

  const content = await page.content();
  expect(content).not.toContain(E2E_PROVIDER_SECRET);
  expect(content).not.toContain(E2E_HTTPS_TOKEN);

  await settle(page);
  expectNoPageErrors(errors);
});

test("target selector switches project and app, marks the current target, and closes on Escape", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");
  const trigger = page.locator(".target-trigger");
  await expect(trigger).toContainText("Global");

  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Choose target" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Search targets" })).toBeFocused();
  await expect(dialog.getByRole("option", { name: "Global", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  await chooseTarget(page, "E2E Project One");
  await expect(page).toHaveURL(new RegExp(`${PROJECT_SKILLS}$`));
  await expect(trigger).toContainText("E2E Project One");

  await trigger.click();
  await dialog.getByRole("option", { name: /alpha/ }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}$`));
  await expect(trigger).toContainText("alpha");

  await settle(page);
  expectNoPageErrors(errors);
});

test("target selector opens a usable menu on mobile", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, APP_SKILLS);

  await page.locator(".target-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Choose target" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option", { name: "Global", exact: true })).toBeVisible();
  await dialog.getByRole("option", { name: "Global", exact: true }).click();
  await expect(page).toHaveURL(/\/skills$/);
  await expect(page.locator(".target-trigger")).toContainText("Global");

  await settle(page);
  expectNoPageErrors(errors);
});

test("attention band filters, clears, and preserves the search", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SKILLS);
  const attention = page.locator(".skills-attention");
  await expect(attention).toBeVisible();
  await expect(attention).toHaveAttribute("data-active", "false");
  await expect(attention).toContainText(E2E_INVALID_APP_SKILL_NAME);
  await expect(attention).toContainText(E2E_SHADOWED_INVALID_LOCAL_NAME);
  await expect(attention).toContainText("+1 more");

  await attention.getByRole("link", { name: "Show only" }).click();
  await expect(page).toHaveURL(/filter=attention/);
  await expect(page.locator("[data-skill-inventory] [data-skill-row]")).toHaveCount(4);
  await expect(
    page.locator(
      `[data-skill-inventory] [data-skill-row][data-skill-name="${E2E_DISABLED_TOMBSTONE_NAME}"]`,
    ),
  ).toBeVisible();
  // The fixture has no baseline plugin root; the deterministic collision comes from the app
  // repository's `.opencode/skill` root, which the same effective-skill scanner reads.
  await expect(
    page.locator(
      `[data-skill-inventory] [data-skill-row][data-skill-name="${E2E_COLLISION_SKILL_NAME}"]`,
    ),
  ).toBeVisible();
  await expect(attention).toHaveAttribute("data-active", "true");
  await expect(attention).toContainText("Showing only");

  await page.locator("#skill-search").fill(E2E_INVALID_APP_SKILL_NAME);
  await expect.poll(() => page.url()).toContain(`q=${E2E_INVALID_APP_SKILL_NAME}`);
  await expect(page).toHaveURL(/filter=attention/);
  await expect(
    page.locator(
      `[data-skill-inventory] [data-skill-row][data-skill-name="${E2E_INVALID_APP_SKILL_NAME}"]`,
    ),
  ).toBeVisible();

  await page.locator("#skill-search").fill("no-such-attention-skill");
  await expect.poll(() => page.url()).toContain("q=no-such-attention-skill");
  await expect(page.getByText("No skills match your search")).toBeVisible();
  await expect(attention).toHaveAttribute("data-active", "true");

  await attention.getByRole("link", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/filter=attention/);
  await expect.poll(() => page.url()).toContain("q=no-such-attention-skill");

  await settle(page);
  expectNoPageErrors(errors);
});

test("cards/list density persists across reload", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SKILLS);
  await expect(page.locator(".skill-card").first()).toBeVisible();

  await page.locator(".skills-density").getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator(".skill-list-row").first()).toBeVisible();
  await expect(page.locator(".skill-card")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".skill-list-row").first()).toBeVisible();
  await expect(page.locator(".skill-card")).toHaveCount(0);

  await page.locator(".skills-density").getByRole("button", { name: "Cards", exact: true }).click();
  await expect(page.locator(".skill-card").first()).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("managed drawer shows content and the effective link with no nested row controls", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SKILLS);

  const rows = page.locator("[data-skill-inventory] [data-skill-row]");
  await expect(rows.first()).toBeVisible();
  expect(
    await page
      .locator(
        "[data-skill-inventory] [data-skill-row] a, [data-skill-inventory] [data-skill-row] button, [data-skill-inventory] [data-skill-row] input, [data-skill-inventory] [data-skill-row] select, [data-skill-inventory] [data-skill-row] textarea",
      )
      .count(),
  ).toBe(0);

  const row = page.locator(
    `[data-skill-inventory] [data-skill-row][data-skill-name="${E2E_SHADOWED_INVALID_LOCAL_NAME}"]`,
  );
  await expect(row).toHaveAttribute("data-skill-state", "invalid");
  await expect(row).toHaveAttribute("data-skill-state-label", "Invalid local override");

  await row.click();
  const drawer = page.locator("dialog.skill-preview-drawer");
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("heading", { name: E2E_SHADOWED_INVALID_LOCAL_NAME }),
  ).toBeVisible();
  await expect(drawer).toContainText(/Invalid/);
  await expect(drawer.locator(".skill-preview-drawer__content")).toContainText(
    "Synthetic content only.",
  );
  await expect(drawer.getByRole("link", { name: "Open full skill" })).toHaveAttribute(
    "href",
    /\/skills\/\d+/,
  );
  await expect(drawer.getByRole("link", { name: "Open effective source" })).toHaveAttribute(
    "href",
    /\/skills\/\d+/,
  );
  await expect(drawer.locator("[data-skill-effective-link]")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(row).toBeFocused();

  await settle(page);
  expectNoPageErrors(errors);
});
