import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";
import { E2E_GLOBAL_SKILL_NAME, E2E_PROJECT_SKILL_NAME } from "./support/seed.js";

const GLOBAL_SKILL = E2E_GLOBAL_SKILL_NAME;
const PROJECT_SKILL = E2E_PROJECT_SKILL_NAME;
const CREATED_SKILL = "e2e-created-skill";
const _LEGACY_CREATED_SKILL = "e2e-legacy-created";
const PROJECT_SKILLS = `/projects/${PROJECT_ONE}/skills`;
const APP_SKILLS = `/projects/${PROJECT_ONE}/apps/alpha/skills`;

function spaMode(): boolean {
  return test.info().project.name === "spa";
}

async function openManagedSkill(page: Page, name: string): Promise<void> {
  await page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${name}"]`).click();
  const drawer = page.locator("dialog.skill-preview-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: "Open full skill" }).click();
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#skill-details")).toBeVisible();
}

test("serves the inventory and workspace in both rendering modes", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const inventory = await page.goto("/skills");
  expect(inventory?.status()).toBe(200);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${GLOBAL_SKILL}"]`),
  ).toBeVisible();
  expect(await page.locator("#hanse-boot").count()).toBe(spaMode() ? 1 : 0);

  const projectInventory = await page.goto(PROJECT_SKILLS);
  expect(projectInventory?.status()).toBe(200);
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${PROJECT_SKILL}"]`),
  ).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${GLOBAL_SKILL}"]`),
  ).toBeVisible();

  await page.goto("/skills");
  await openManagedSkill(page, GLOBAL_SKILL);
  await expect(page.getByText("SKILL.md").first()).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("filters and searches the inventory", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");

  await page.locator(".skills-filters a", { hasText: "Inherited" }).click();
  await expect(page).toHaveURL(/filter=inherited/);
  await expect(page.getByText("No skills match this filter")).toBeVisible();

  await page.locator(".skills-filters a", { hasText: "All" }).click();
  await page.locator("#skill-search").fill(GLOBAL_SKILL);
  await expect.poll(() => page.url()).toContain(`q=${GLOBAL_SKILL}`);
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${GLOBAL_SKILL}"]`),
  ).toBeVisible();

  await page.locator("#skill-search").fill("no-such-skill");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/q=no-such-skill/);
  await expect(page.getByText("No skills match your search")).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("creates a skill from the SPA or the legacy form", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills/new?scope=global");

  await page.locator("#skill-name").fill(CREATED_SKILL);
  await page.locator("#skill-description").fill("Created by the deterministic fixture.");
  await page.locator("#skill-content").fill("## Created\n\nSynthetic content only.\n");
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#skill-details")).toBeVisible();
  await expect(page.getByRole("heading", { name: CREATED_SKILL })).toBeVisible();
  await expect(page.getByText("Skill created.")).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("overrides, disables, and reverts a skill at application scope", async ({ page }) => {
  const errors = collectPageErrors(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await signIn(page, APP_SKILLS);

  // Inherited global skill -> override at application scope.
  await openManagedSkill(page, GLOBAL_SKILL);
  await page.getByRole("button", { name: "Override here" }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}(\\?.*)?$`));
  await expect(page.getByText("Skill overridden here.")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${GLOBAL_SKILL}"]`),
  ).toHaveAttribute("data-skill-state", "enabled");

  // Remove the override again (danger zone on the owned copy).
  await openManagedSkill(page, GLOBAL_SKILL);
  await page.locator("#skill-confirm-name").fill(GLOBAL_SKILL);
  await page.getByRole("button", { name: "Delete skill" }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}(\\?.*)?$`));
  await expect(page.getByText("Skill deleted.")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${GLOBAL_SKILL}"]`),
  ).toHaveAttribute("data-skill-state", "inherited");

  // Inherited global skill -> tombstone at application scope.
  await openManagedSkill(page, GLOBAL_SKILL);
  await page.getByRole("button", { name: "Disable here" }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}(\\?.*)?$`));
  await expect(page.getByText("Skill disabled here.")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${GLOBAL_SKILL}"]`),
  ).toHaveAttribute("data-skill-state", "disabled");

  // Revert the tombstone.
  await openManagedSkill(page, GLOBAL_SKILL);
  await page.locator("#skill-confirm-name").fill(GLOBAL_SKILL);
  await page.getByRole("button", { name: "Revert to inherited" }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}(\\?.*)?$`));
  await expect(page.getByText("Skill reverted to inherited.")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${GLOBAL_SKILL}"]`),
  ).toHaveAttribute("data-skill-state", "inherited");

  await settle(page);
  expectNoPageErrors(errors);
});

test("serves the application-scoped inventory", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SKILLS);

  await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] [data-skill-row][data-skill-name="${PROJECT_SKILL}"]`),
  ).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
