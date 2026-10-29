import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";
import {
  E2E_HTTPS_TOKEN,
  E2E_KNOWN_HOSTS_SENTINEL,
  E2E_PRIVATE_KEY_SENTINEL,
  E2E_PROVIDER_SECRET,
} from "./support/seed.js";

const SETTINGS_PATHS = [
  "/settings",
  `/projects/${PROJECT_ONE}/settings`,
  `/projects/${PROJECT_ONE}/apps/alpha/settings`,
];

function isSpa(projectName: string): boolean {
  return projectName === "spa";
}

async function openRow(page: Page, id: string): Promise<void> {
  const row = page.locator(`#${id}`);
  const open = await row.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) {
    await row.locator("> summary").click();
  }
}

async function expectToast(page: Page, text: string): Promise<void> {
  await expect(page.locator("#toast-region")).toContainText(text);
}

test("renders the global, project, and application settings scopes", async ({ page }, info) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  for (const path of SETTINGS_PATHS) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#settings-agent")).toBeVisible();
    await expect(page.locator("#setting-llm-model")).toBeVisible();
    await expect(page.locator("#settings-git")).toBeVisible();
    if (isSpa(info.project.name)) {
      await expect(page.locator("#hanse-boot")).toHaveCount(1);
    } else {
      await expect(page.locator("#hanse-boot")).toHaveCount(0);
    }
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("saves, inherits, and clears a scoped setting", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);
  const path = `/projects/${PROJECT_ONE}/settings`;

  await page.goto(path);
  await openRow(page, "setting-git-user-name");
  await page.locator("#setting-git-user-name form input[name='value']").fill("E2E Project Git");
  await page.locator("#setting-git-user-name form").getByRole("button", { name: "Save" }).click();
  await expectToast(page, "Settings saved.");

  await page.goto(path);
  await openRow(page, "setting-git-user-name");
  await expect(page.locator("#setting-git-user-name form input[name='value']")).toHaveValue(
    "E2E Project Git",
  );
  await expect(page.locator("#setting-git-user-name")).toContainText("Set");

  await page
    .locator("#setting-git-user-name form")
    .getByRole("button", { name: "Inherit" })
    .click();
  await expectToast(page, "Settings saved.");

  await page.goto(path);
  await openRow(page, "setting-git-user-name");
  await expect(page.locator("#setting-git-user-name")).toContainText(/default/i);

  await page.locator("#setting-git-user-name form").getByRole("button", { name: "Clear" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Clear setting" }).click();
  await expectToast(page, "Setting cleared.");

  await page.goto(path);
  await openRow(page, "setting-git-user-name");
  await expect(page.locator("#setting-git-user-name")).toContainText("Cleared");

  await settle(page);
  expectNoPageErrors(errors);
});

test("renders providers and custom model providers masked", async ({ page }, info) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");

  await expect(page.locator("#provider-deepseek")).toBeVisible();
  await expect(page.locator("#provider-deepseek input[name='key']")).toHaveAttribute(
    "placeholder",
    "Not shown",
  );
  await expect(page.locator("#custom-provider-e2e-llm")).toBeVisible();
  await expect(page.locator("#custom-provider-e2e-llm")).toContainText("E2E LLM");
  if (isSpa(info.project.name)) {
    await expect(page.locator("#custom-provider-e2e-llm")).toContainText("Not shown");
  }
  expect(await page.content()).not.toContain(E2E_PROVIDER_SECRET);

  await page.locator("#providers details.provider-add").locator("summary").click();
  await page.locator("#provider-new").fill("e2e-extra-provider");
  await page.locator("#provider-new-key").fill("e2e-extra-provider-key");
  await page
    .locator("#providers details.provider-add form")
    .getByRole("button", { name: "Save" })
    .click();
  await expectToast(page, "Provider key updated.");
  await expect(page.locator("#provider-e2e-extra-provider")).toBeVisible();
  expect(await page.content()).not.toContain("e2e-extra-provider-key");

  await page.locator("#custom-providers details.provider-add").locator("summary").click();
  await page.locator("#custom-provider-new-id").fill("e2e-added");
  await page.locator("#custom-provider-new-name").fill("E2E Added");
  await page.locator("#custom-provider-new-url").fill("http://added.example.test/v1");
  await page.locator("#custom-provider-new-models").fill("added-model | 1000 | 100");
  await page
    .locator("#custom-providers details.provider-add form")
    .getByRole("button", { name: "Save" })
    .click();
  await expectToast(page, "Provider saved.");
  await expect(page.locator("#custom-provider-e2e-added")).toBeVisible();

  await openRow(page, "custom-provider-e2e-added");
  if (isSpa(info.project.name)) {
    await page.locator("#custom-provider-e2e-added form button.btn-danger").click();
    const confirm = page.locator("dialog[open]");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete" }).click();
  } else {
    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator("#custom-provider-e2e-added form button.btn-danger").click();
  }
  await expectToast(page, isSpa(info.project.name) ? "Provider deleted." : "Provider saved.");
  await expect(page.locator("#custom-provider-e2e-added")).toHaveCount(0);
  expect(await page.content()).not.toContain(E2E_PROVIDER_SECRET);

  await settle(page);
  expectNoPageErrors(errors);
});

test("keeps git credential secrets write-only and tests the remote", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}/apps/alpha/settings`);

  await expect(page.locator("#git-ssh-public-key")).toContainText("ssh-ed25519");
  await expect(page.locator("#git-ssh-fingerprint")).toContainText("SHA256:");
  await expect(page.locator("#git-https-allowed-hosts")).toContainText("git.example.test");
  await expect(page.locator("#git-https-username-value")).toContainText("x-access-token");
  const content = await page.content();
  expect(content).not.toContain(E2E_PRIVATE_KEY_SENTINEL);
  expect(content).not.toContain(E2E_KNOWN_HOSTS_SENTINEL);
  expect(content).not.toContain(E2E_HTTPS_TOKEN);

  await openRow(page, "setting-git-https");
  await page.locator("#git-https-hosts").fill("git.example.test");
  await page.locator("#git-https-username").fill("x-access-token");
  await page.locator("#git-https-token").fill("e2e-draft-token");
  await page
    .locator("#setting-git-https form")
    .getByRole("button", { name: "Test connection" })
    .click();
  await expect(page.locator("#setting-git-https")).toContainText("Connected: 2 refs");
  await expect(page.locator("#setting-git-https")).toContainText("git.example.test");
  expect(await page.content()).not.toContain("e2e-draft-token");

  await page.locator("#setting-git-https form").getByRole("button", { name: "Save" }).click();
  await expectToast(page, "Git credential saved.");
  expect(await page.content()).not.toContain("e2e-draft-token");

  await settle(page);
  expectNoPageErrors(errors);
});

test("shows the restart prompt and restarts the pending agent", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");

  await expect(page.locator("#settings-restart")).toContainText("Restart required");
  await page
    .locator("#settings-restart")
    .getByRole("button", { name: "Restart agent" })
    .first()
    .click();
  await expectToast(page, "Agent restarted.");
  await expect(page.locator("#settings-restart")).not.toContainText("Restart required");

  await settle(page);
  expectNoPageErrors(errors);
});

test("keeps the legacy form success redirect", async ({ page }, info) => {
  test.skip(isSpa(info.project.name), "the SPA mutation contract is covered by spa-settings");
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");

  const response = await page.request.post("/api/settings", {
    headers: { accept: "text/html" },
    form: {
      scope: "global",
      key: "git.user.name",
      action: "set",
      value: "E2E Legacy",
      return_to: "/settings",
    },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toContain("/settings?");
  expect(response.headers().location).toContain("notice=Settings+saved.");

  await settle(page);
  expectNoPageErrors(errors);
});
