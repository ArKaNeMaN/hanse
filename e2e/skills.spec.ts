import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";
import { E2E_HTTPS_TOKEN, E2E_PROVIDER_SECRET } from "./support/seed.js";

const GLOBAL_SKILL = "e2e-global-skill";
const PROJECT_SKILL = "e2e-project-skill";
const CREATED_SKILL = "e2e-created-skill";
const LEGACY_CREATED_SKILL = "e2e-legacy-created";
const PROJECT_SKILLS = `/projects/${PROJECT_ONE}/skills`;
const APP_SKILLS = `/projects/${PROJECT_ONE}/apps/alpha/skills`;

function spaMode(): boolean {
  return test.info().project.name === "spa";
}

test("serves the inventory and workspace in both rendering modes", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const inventory = await page.goto("/skills");
  expect(inventory?.status()).toBe(200);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"]`),
  ).toBeVisible();
  expect(await page.locator("#hanse-boot").count()).toBe(spaMode() ? 1 : 0);

  const projectInventory = await page.goto(PROJECT_SKILLS);
  expect(projectInventory?.status()).toBe(200);
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${PROJECT_SKILL}"]`),
  ).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"]`),
  ).toBeVisible();

  await page.goto("/skills");
  await page.getByRole("link", { name: GLOBAL_SKILL }).first().click();
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#skill-details")).toBeVisible();
  await expect(page.getByText("SKILL.md").first()).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("filters and searches the inventory", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");

  await page.locator(".segmented a", { hasText: "Inherited" }).click();
  await expect(page).toHaveURL(/filter=inherited/);
  await expect(page.getByText("No skills match this filter")).toBeVisible();

  await page.locator(".segmented a", { hasText: "All" }).click();
  await page.locator("#skill-search").fill(GLOBAL_SKILL);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=e2e-global-skill/);
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"]`),
  ).toBeVisible();

  await page.locator("#skill-search").fill("no-such-skill");
  await page.getByRole("button", { name: "Search" }).click();
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
  await page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"] a.mono`).click();
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await page.getByRole("button", { name: "Override here" }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}(\\?.*)?$`));
  await expect(page.getByText("Skill overridden here.")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"]`),
  ).toHaveAttribute("data-skill-state", "enabled");

  // Remove the override again (danger zone on the owned copy).
  await page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"] a.mono`).click();
  await page.locator("#skill-confirm-name").fill(GLOBAL_SKILL);
  await page.getByRole("button", { name: "Delete skill" }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}(\\?.*)?$`));
  await expect(page.getByText("Skill deleted.")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"]`),
  ).toHaveAttribute("data-skill-state", "inherited");

  // Inherited global skill -> tombstone at application scope.
  await page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"] a.mono`).click();
  await page.getByRole("button", { name: "Disable here" }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}(\\?.*)?$`));
  await expect(page.getByText("Skill disabled here.")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"]`),
  ).toHaveAttribute("data-skill-state", "disabled");

  // Revert the tombstone.
  await page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"] a.mono`).click();
  await page.locator("#skill-confirm-name").fill(GLOBAL_SKILL);
  await page.getByRole("button", { name: "Revert to inherited" }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}(\\?.*)?$`));
  await expect(page.getByText("Skill reverted to inherited.")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${GLOBAL_SKILL}"]`),
  ).toHaveAttribute("data-skill-state", "inherited");

  await settle(page);
  expectNoPageErrors(errors);
});

test("keeps the legacy 303 create path and hides secrets", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills/new?scope=global&legacy=1");

  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await page.locator("#skill-name").fill(LEGACY_CREATED_SKILL);
  await page.locator("#skill-description").fill("Legacy form create.");
  await page.locator("#skill-content").fill("## Legacy\n\nSynthetic content only.\n");
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page).toHaveURL(/\/skills\/\d+\?.*notice=Skill\+created/);
  await expect(page.locator("#skill-details")).toBeVisible();

  const content = await page.content();
  expect(content).not.toContain(E2E_PROVIDER_SECRET);
  expect(content).not.toContain(E2E_HTTPS_TOKEN);

  await settle(page);
  expectNoPageErrors(errors);
});

test("serves the application-scoped inventory", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SKILLS);

  await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  await expect(
    page.locator(`[data-skill-inventory] tr[data-skill-name="${PROJECT_SKILL}"]`),
  ).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
