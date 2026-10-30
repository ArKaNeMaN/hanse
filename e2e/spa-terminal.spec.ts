import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  E2E_TOKEN,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

const APP_PATH = `/projects/${PROJECT_ONE}/apps/alpha`;
const TERMINAL_PATH = `/terminal?app=alpha&project=${PROJECT_ONE}`;

async function signInAt(page: Page, origin: string, path: string): Promise<void> {
  await page.goto(`${origin}/login?next=${encodeURIComponent(path)}`);
  if (new URL(page.url()).pathname !== "/login") {
    await page.goto(`${origin}${path}`);
    return;
  }
  await page.getByLabel("Operator token (required)").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === path.split("?")[0]);
}

test("first paint has the default IDE topbar, one vendor link, and one host", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, TERMINAL_PATH);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator(".topbar__actions a")).toHaveCount(1);
  await expect(page.locator(".topbar__actions #chat-input-needed")).toHaveCount(0);
  await expect(page.locator(".topbar__actions #chat-policy-chip")).toHaveCount(0);
  await expect(page.locator(".topbar__actions [data-chat-context-toggle]")).toHaveCount(0);
  await expect(page.locator('link[href="/assets/vendor/xterm/xterm-6.0.0.css"]')).toHaveCount(1);
  await expect(page.locator("#terminal-host")).toHaveCount(1);

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator(".topbar__actions a")).toHaveCount(1);
  await expect(page.locator('link[href="/assets/vendor/xterm/xterm-6.0.0.css"]')).toHaveCount(1);
  await expect(page.locator("#terminal-host")).toHaveCount(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("client navigation does not duplicate the topbar, stylesheet, or host", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_PATH);
  await page.evaluate(() => {
    (window as unknown as { __stage2Spa: boolean }).__stage2Spa = true;
  });

  await page.locator(`a[href="${TERMINAL_PATH}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/terminal\\?app=alpha&project=${PROJECT_ONE}`));
  expect(
    await page.evaluate(
      () => (window as unknown as { __stage2Spa?: boolean }).__stage2Spa === true,
    ),
  ).toBe(true);
  await expect(page.locator(".topbar__actions a")).toHaveCount(1);
  await expect(page.locator('link[href="/assets/vendor/xterm/xterm-6.0.0.css"]')).toHaveCount(1);
  await expect(page.locator("#terminal-host")).toHaveCount(1);
  await expect(page.locator("#terminal-host .xterm")).toHaveCount(1);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.locator("#terminal-host .xterm")).toHaveCount(1);
  await expect(page.locator('link[href="/assets/vendor/xterm/xterm-6.0.0.css"]')).toHaveCount(1);
  await expect(page.locator(".topbar__actions a")).toHaveCount(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("?legacy=1 serves the legacy document for a full rollback drill", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `${TERMINAL_PATH}&legacy=1`);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator('script[src="/assets/terminal.js"]')).toHaveCount(1);
  await expect(page.locator(".terminal-shell")).toHaveCount(1);
  await settle(page);
  expectNoPageErrors(errors);
});

test("HANSE_UI_LEGACY=1 and allowlist removal still serve the legacy terminal", async ({
  page,
}) => {
  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    await signInAt(page, origin, TERMINAL_PATH);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.locator('script[src="/assets/terminal.js"]')).toHaveCount(1);
    await expect(page.locator(".terminal-shell")).toHaveCount(1);
    await expect(page.locator('link[href="/assets/vendor/xterm/xterm-6.0.0.css"]')).toHaveCount(1);
  }
});
