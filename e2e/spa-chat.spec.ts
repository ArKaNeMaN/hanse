import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  E2E_TOKEN,
  expectNoPageErrors,
  PROJECT_ONE,
  signIn,
} from "./support/helpers.js";

const CHAT_PATH = `/chat?app=alpha&project=${PROJECT_ONE}&session=ses_e2ealpha`;

test("server first paint already carries the chat topbar set with zeroed counters", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);

  const html = await (await page.request.get(CHAT_PATH)).text();
  expect(html).toContain('id="chat-input-needed"');
  expect(html).toContain('id="chat-policy-chip"');
  expect(html).toContain("data-chat-context-toggle");
  expect(html).toContain('id="chat-input-needed-count" aria-hidden="true">0');
  expect(html).toMatch(/id="chat-input-needed"[^>]* hidden/);
  expect(html).toMatch(/id="chat-policy-chip"[^>]* hidden/);
  expect(html).toContain("page__body--chat");

  const boot = JSON.parse((await page.locator("#hanse-boot").textContent()) ?? "{}") as Record<
    string,
    unknown
  >;
  expect(boot).toMatchObject({ route: { id: "chat" } });
  expect(Array.isArray(boot.spaRoutes)).toBe(true);
  expect((boot.spaRoutes as string[]).includes("chat")).toBe(true);
  expect(boot).not.toHaveProperty("initialSession");
  expect(JSON.stringify(boot)).not.toContain("session=");

  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await expect(page.locator("[data-chat-composer-input]")).toBeDisabled();
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("deep link, refresh, and back/forward keep one chat host and the requested session", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await expect(page).toHaveURL(/session=ses_e2ealpha/);

  await page.reload();
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await expect(page.locator("#chat-scroll")).toHaveCount(1);
  await expect(page).toHaveURL(/session=ses_e2ealpha/);

  await page.goto(`/projects/${PROJECT_ONE}/apps/alpha`);
  await page.getByRole("link", { name: "Open chat" }).first().click();
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await expect(page.locator("#chat-scroll")).toHaveCount(1);
  await expect(page.locator('[data-message-id="msg_e2e_user"]')).toHaveCount(1);
  await expect(page.locator('[data-message-id="msg_e2e_assistant"]')).toHaveCount(1);

  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("unknown or missing application chat stays on the legacy fallback", async ({ page }) => {
  const noApp = await page.goto(`/login?next=${encodeURIComponent("/chat")}`);
  expect(noApp?.status()).toBeLessThan(500);
  await page.getByLabel("Operator token (required)").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/chat");

  const response = await page.goto(`/chat?app=missing&project=${PROJECT_ONE}`);
  expect(response?.status()).toBe(404);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator("#chat-shell")).toHaveCount(0);
});

test("SPA chat is a read-only surface with no mutation controls", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);

  const enabledButtons = await page
    .locator("#chat-shell button:not([disabled])")
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim()));
  expect(enabledButtons.some((label) => /send|stop|abort|delete|new session/i.test(label))).toBe(
    false,
  );
  await expect(page.locator("[data-chat-composer-input]")).toBeDisabled();
  await expect(page.locator("[data-chat-send]")).toBeDisabled();
  await expect(page.locator('#chat-shell input[type="search"]')).toHaveCount(0);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});
