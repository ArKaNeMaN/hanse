import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, settle, signIn } from "./support/helpers.js";
import {
  E2E_EXTERNAL_SKILL_NAME,
  E2E_SKILL_HUB_ENDPOINT,
  E2E_SKILL_SOURCE_TOKEN,
} from "./support/seed.js";

const SOURCE_SLUG = "e2e-skills";
const SOURCE_NAME = "E2E Skills";
const ADDED_NAME = "E2E Added Source";
const ADDED_SLUG = "e2e-added-source";
const REPLACED_TOKEN = "e2e-replaced-skill-source-token-sentinel";
const ARTIFACTS = path.resolve("docs/design/artifacts/skill-sources");
const THEMES = ["dark", "light"] as const;
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

function sourceRow(page: Page, slug: string): Locator {
  return page.locator(`[data-skill-source="${slug}"]`);
}

async function openSources(page: Page): Promise<void> {
  await page.locator('.settings-console__rail-item[data-section="sources"]').click();
  await expect(page.locator("#settings-sources")).toBeVisible();
}

function primaryActionButton(row: Locator): Locator {
  return row.locator(".skill-source-actions > button").first();
}

async function openMenu(row: Locator, name: string): Promise<void> {
  const details = row.locator("details.skill-source-menu");
  const open = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) {
    await details.locator("summary").click();
  }
  await details
    .locator(".skill-source-menu__panel")
    .getByRole("button", { name, exact: true })
    .click();
}

async function applyTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
}

function toast(page: Page, text: string | RegExp): Locator {
  return page.locator("#toast-region .toast").filter({ hasText: text });
}

test("captures the settings and external-skills surfaces at desktop/phone in both themes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");
  await openSources(page);
  await expect(sourceRow(page, SOURCE_SLUG)).toBeVisible();

  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      if (page.url().includes("/skills")) {
        await page.goto("/settings");
      }
      await openSources(page);
      await expect(sourceRow(page, SOURCE_SLUG)).toBeVisible();
      await applyTheme(page, theme);

      const section = page.locator("#settings-sources");
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({
        path: path.join(ARTIFACTS, `settings-sources-${viewport.name}-${theme}.png`),
      });

      await sourceRow(page, SOURCE_SLUG).locator("button.skill-source-name").click();
      const drawer = page.locator("dialog.source-drawer");
      await expect(drawer).toBeVisible();
      await expect(
        drawer.locator(`[data-source-skill="${E2E_EXTERNAL_SKILL_NAME}"]`),
      ).toBeVisible();
      await drawer.screenshot({
        path: path.join(ARTIFACTS, `source-drawer-${viewport.name}-${theme}.png`),
      });
      await drawer.getByRole("button", { name: "Close skill source details" }).click();
      await expect(drawer).not.toBeVisible();

      await page.getByRole("button", { name: "Add source", exact: true }).first().click();
      const addDialog = page.getByRole("dialog", { name: "Add skill source" });
      await expect(addDialog).toBeVisible();
      await addDialog.screenshot({
        path: path.join(ARTIFACTS, `add-source-dialog-${viewport.name}-${theme}.png`),
      });
      await addDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(addDialog).not.toBeVisible();

      await page.goto("/skills");
      await applyTheme(page, theme);
      await expect(page.locator("[data-skill-inventory]")).toBeVisible();
      await expect(page.locator('[data-skill-mode="external"]')).toBeVisible();
      await page.locator("[data-skill-inventory]").screenshot({
        path: path.join(ARTIFACTS, `skills-external-${viewport.name}-${theme}.png`),
      });

      await page
        .locator(".skills-filters")
        .getByRole("link", { name: "External", exact: true })
        .click();
      await expect(page).toHaveURL(/filter=external/);
      await expect(page.locator('[data-skill-mode="external"]')).toBeVisible();
      await page.locator("[data-skill-inventory]").screenshot({
        path: path.join(ARTIFACTS, `skills-external-filter-${viewport.name}-${theme}.png`),
      });

      await page.locator('[data-skill-mode="external"]').click();
      const externalDrawer = page.locator("dialog.external-skill-drawer");
      await expect(externalDrawer).toBeVisible();
      await expect(
        externalDrawer.getByRole("button", { name: "references/guide.md", exact: true }),
      ).toBeVisible();
      await externalDrawer.screenshot({
        path: path.join(ARTIFACTS, `external-skill-drawer-${viewport.name}-${theme}.png`),
      });
      await externalDrawer.getByRole("button", { name: "Close external skill details" }).click();
      await expect(externalDrawer).not.toBeVisible();
    }
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("settings lists the seeded source with status, revision, counts, and bytes", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");
  await openSources(page);

  const row = sourceRow(page, SOURCE_SLUG);
  await expect(row).toBeVisible();
  await expect(row).toContainText(SOURCE_NAME);
  await expect(row).toContainText(SOURCE_SLUG);
  await expect(row.locator(".status")).toHaveText(/Ready/);
  await expect(row).toContainText("e2e-rev");
  await expect(row).toContainText(/1\s*·\s*199 B/);
  await expect(row).toContainText("skills-hub.e2e.test");

  expect(await page.content()).not.toContain(E2E_SKILL_SOURCE_TOKEN);

  await settle(page);
  expectNoPageErrors(errors);
});

test("a direct settings hash opens and scrolls to the skill sources section", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await openSources(page);
  await expect(sourceRow(page, SOURCE_SLUG)).toBeVisible();
  await page.goto("/settings#settings-sources");

  await expect(page).toHaveURL(/\/settings#settings-sources$/);
  await expect(
    page.locator('.settings-console__rail-item[data-section="sources"]'),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#settings-sources")).toBeInViewport();
  await expect(sourceRow(page, SOURCE_SLUG)).toBeVisible();

  await page.goto("/settings#settings-sources");
  await expect(
    page.locator('.settings-console__rail-item[data-section="sources"]'),
  ).toHaveAttribute("aria-current", "page");
  await expect(sourceRow(page, SOURCE_SLUG)).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("sync now and check for updates report their result", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");
  await openSources(page);

  const row = sourceRow(page, SOURCE_SLUG);
  await expect(row).toBeVisible();

  await primaryActionButton(row).click();
  await expect(toast(page, /Already up to date|Synced \d+ skills/)).toBeVisible();
  await expect(row.locator(".status")).toHaveText(/Ready/);

  await openMenu(row, "Check for updates");
  const check = row.locator(".skill-source-check");
  await expect(check).toContainText("Up to date");
  await expect(check).toContainText("e2e-rev-1");

  await settle(page);
  expectNoPageErrors(errors);
});

test("pin, unpin, disable, and enable drive the row state", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");
  await openSources(page);

  const row = sourceRow(page, SOURCE_SLUG);
  await expect(row).toBeVisible();

  await openMenu(row, "Pin");
  await expect(toast(page, "Source pinned.")).toBeVisible();
  await expect(row.locator(".badge").filter({ hasText: "Pinned" })).toBeVisible();
  await expect(primaryActionButton(row)).toHaveText(/Unpin/);

  await primaryActionButton(row).click();
  await expect(toast(page, "Source unpinned.")).toBeVisible();
  await expect(row.locator(".badge").filter({ hasText: "Pinned" })).toHaveCount(0);
  await expect(row.locator(".status")).toHaveText(/Ready/);

  await openMenu(row, "Disable");
  const disableDialog = page.getByRole("dialog", { name: "Disable source?" });
  await expect(disableDialog).toBeVisible();
  await disableDialog.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(toast(page, "Source disabled.")).toBeVisible();
  await expect(row.locator(".status")).toHaveText(/Disabled/);
  await expect(primaryActionButton(row)).toHaveText(/Enable/);

  await primaryActionButton(row).click();
  await expect(toast(page, "Source enabled. Syncing...")).toBeVisible();
  await expect(row.locator(".status")).toHaveText(/Ready/);

  await settle(page);
  expectNoPageErrors(errors);
});

test("the token is write-only: replace and clear never expose its value", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");
  await openSources(page);

  const row = sourceRow(page, SOURCE_SLUG);
  await expect(row).toBeVisible();
  await row.locator("button.skill-source-name").click();

  const drawer = page.locator("dialog.source-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".source-drawer__credential")).toContainText("Set");

  await drawer.getByRole("button", { name: "Replace token", exact: true }).click();
  const replaceDialog = page.getByRole("dialog", { name: "Replace token?" });
  await expect(replaceDialog).toBeVisible();
  await replaceDialog.locator("#skill-source-new-token").fill(REPLACED_TOKEN);
  await replaceDialog.getByRole("button", { name: "Replace token", exact: true }).click();
  await expect(toast(page, "Token replaced.")).toBeVisible();

  let content = await page.content();
  expect(content).not.toContain(REPLACED_TOKEN);
  expect(content).not.toContain(E2E_SKILL_SOURCE_TOKEN);

  await drawer.getByRole("button", { name: "Clear token", exact: true }).click();
  const clearDialog = page.getByRole("dialog", { name: "Clear token?" });
  await expect(clearDialog).toBeVisible();
  await clearDialog.getByRole("button", { name: "Clear token", exact: true }).click();
  await expect(toast(page, "Token cleared.")).toBeVisible();
  await expect(drawer.locator(".source-drawer__credential")).toContainText("Not set");

  content = await page.content();
  expect(content).not.toContain(REPLACED_TOKEN);
  expect(content).not.toContain(E2E_SKILL_SOURCE_TOKEN);

  await drawer.getByRole("button", { name: "Close skill source details" }).click();
  await expect(drawer).not.toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("create a source against the fake hub and hard-delete it with the typed slug", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");
  await openSources(page);

  await page.getByRole("button", { name: "Add source", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add skill source" });
  await expect(dialog).toBeVisible();
  await dialog.locator("#skill-source-name").fill(ADDED_NAME);
  await expect(dialog.locator("#skill-source-slug")).toHaveValue(ADDED_SLUG);
  await dialog.locator("#skill-source-endpoint").fill(E2E_SKILL_HUB_ENDPOINT);
  await dialog.locator("#skill-source-buckets").fill("default");
  await dialog.getByRole("button", { name: "Add and sync", exact: true }).click();

  const added = sourceRow(page, ADDED_SLUG);
  await expect(added).toBeVisible();
  await expect(added.locator(".status")).toHaveText(/Ready/, { timeout: 15_000 });
  await expect(added).toContainText(/1\s*·\s*199 B/);
  expect(await page.content()).not.toContain(E2E_SKILL_SOURCE_TOKEN);

  await openMenu(added, "Delete");
  const deleteDialog = page.getByRole("dialog", { name: "Delete skill source?" });
  await expect(deleteDialog).toBeVisible();
  await expect(
    deleteDialog.getByRole("button", { name: "Delete source", exact: true }),
  ).toBeDisabled();
  await deleteDialog.locator("#skill-source-delete-slug").fill(ADDED_SLUG);

  const deleteRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/api/skill-sources/") &&
      request.url().endsWith("/delete"),
  );
  await deleteDialog.getByRole("button", { name: "Delete source", exact: true }).click();
  expect((await deleteRequest).postDataJSON()).toEqual({ hard: true });

  await expect(added).toHaveCount(0);
  await expect(toast(page, "Source deleted.")).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("external rows are read-only, filterable, and open a working preview drawer", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");

  await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  const external = page.locator('[data-skill-mode="external"]');
  await expect(external).toBeVisible();
  await expect(external).toContainText(E2E_EXTERNAL_SKILL_NAME);
  await expect(external).toContainText("Source");
  await expect(external).toContainText("Hub");
  await expect(external).toContainText(SOURCE_NAME);
  await expect(external).toContainText("default");

  expect(await page.locator('[data-skill-inventory] a[href*="/skills/null"]').count()).toBe(0);
  expect(await page.locator("[data-skill-inventory] [data-skill-row] a[href]").count()).toBe(0);
  expect(await page.content()).not.toContain("/skills/null");
  expect(await page.content()).not.toContain(E2E_SKILL_SOURCE_TOKEN);

  await page
    .locator(".skills-filters")
    .getByRole("link", { name: "External", exact: true })
    .click();
  await expect(page).toHaveURL(/\/skills\?filter=external$/);
  await expect(page.locator('[data-skill-mode="external"]')).toHaveCount(1);
  await expect(page.locator('[data-skill-mode="managed"]')).toHaveCount(0);

  await external.click();
  const drawer = page.locator("dialog.external-skill-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Read-only");
  await expect(drawer).toContainText(SOURCE_NAME);
  await expect(drawer).toContainText("This skill is provided by");
  await expect(
    drawer.getByRole("link", { name: "Manage source", exact: true }).first(),
  ).toHaveAttribute("href", "/settings#settings-sources");

  const guide = drawer.getByRole("button", { name: "references/guide.md", exact: true });
  await expect(drawer.getByRole("button", { name: "SKILL.md", exact: true })).toBeVisible();
  await guide.click();
  await expect(guide).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.locator(".skill-source-preview__text")).toContainText("# External guide");

  const binary = drawer.getByRole("button", { name: "assets/logo.bin", exact: true });
  await binary.click();
  await expect(binary).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.locator(".skill-source-preview")).toContainText("Binary file");
  await expect(drawer.locator(".skill-source-preview")).toContainText("sha256");

  await drawer.getByRole("button", { name: "Close external skill details" }).click();
  await expect(drawer).not.toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
