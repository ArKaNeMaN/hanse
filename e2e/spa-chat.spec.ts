import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  E2E_TOKEN,
  expectNoPageErrors,
  PROJECT_ONE,
  signIn,
  upstreamInfo,
} from "./support/helpers.js";

const CHAT_PATH = `/chat?app=alpha&project=${PROJECT_ONE}&session=ses_e2ealpha`;

function isSpa(): boolean {
  return test.info().project.name === "spa";
}

async function control(page: Page, body: Record<string, unknown>): Promise<void> {
  const port = Number(new URL(page.url()).port);
  const response = await fetch(`${upstreamInfo(port).url}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
}

async function upstreamStreamCount(page: Page): Promise<number> {
  const port = Number(new URL(page.url()).port);
  const state = (await fetch(`${upstreamInfo(port).url}/__state`).then((response) =>
    response.json(),
  )) as { requests: string[] };
  return state.requests.filter((request) => request.startsWith("GET /event")).length;
}

async function waitForUpstreamStream(page: Page, previous: number): Promise<void> {
  await expect
    .poll(async () => upstreamStreamCount(page), { timeout: 15_000 })
    .toBeGreaterThan(previous);
}

async function eventSourceStats(page: Page): Promise<{ created: number; active: number }> {
  return page.evaluate(() => {
    const stats = (
      window as unknown as { __chatEventSourceStats?: { created: number; active: number } }
    ).__chatEventSourceStats;
    return stats ?? { created: 0, active: 0 };
  });
}

async function installEventSourceCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Original = window.EventSource;
    let created = 0;
    let active = 0;
    class CountingEventSource extends Original {
      private counted = true;
      constructor(url: string | URL, config?: EventSourceInit) {
        super(url, config);
        created += 1;
        active += 1;
      }
      override close(): void {
        if (this.counted) {
          this.counted = false;
          active -= 1;
        }
        super.close();
      }
    }
    Object.defineProperty(window, "EventSource", {
      value: CountingEventSource,
      configurable: true,
    });
    Object.defineProperty(window, "__chatEventSourceStats", {
      value: {
        get created() {
          return created;
        },
        get active() {
          return active;
        },
      },
      configurable: true,
    });
  });
}

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

test("SPA chat exposes session navigation while every message path stays read-only", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  const messageWrites: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/messages|\/abort|\/pending|\/attachments|\/question|\/permission/.test(request.url())
    ) {
      messageWrites.push(`${request.method()} ${request.url()}`);
    }
  });
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);

  await expect(page.locator("[data-chat-session-search]")).toHaveCount(1);
  await expect(page.locator("[data-chat-new-session]")).toHaveCount(1);
  await expect(page.locator("[data-session-delete]").first()).toBeAttached();
  await expect(page.locator("[data-chat-composer-input]")).toBeDisabled();
  await expect(page.locator("[data-chat-send]")).toBeDisabled();
  await expect(page.locator("[data-chat-abort]")).toHaveCount(0);
  await expect(page.locator("[data-chat-queue]")).toHaveCount(0);
  expect(messageWrites, messageWrites.join("\n")).toEqual([]);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA session tree supports search, disclosure, new, and subtree delete", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);

  const search = page.locator("[data-chat-session-search]");
  await search.fill("grandchild");
  await expect(page.locator('.session-node[data-session-id="ses_e2ealpha"]')).toBeVisible();
  await expect(page.locator('.session-node[data-session-id="ses_e2echild"]')).toBeVisible();
  await expect(page.locator('.session-node[data-session-id="ses_e2egrandchild"]')).toBeVisible();
  await expect(
    page.locator('.session-node[data-session-id="ses_e2ealpha"] .session-chevron').first(),
  ).toHaveAttribute("aria-expanded", "true");
  await search.fill("");
  await expect(page.locator('.session-node[data-session-id="ses_e2echild"]')).toBeHidden();
  await page
    .locator('.session-node[data-session-id="ses_e2ealpha"] .session-chevron')
    .first()
    .click();
  await expect(page.locator('.session-node[data-session-id="ses_e2echild"]')).toBeVisible();
  await page
    .locator('.session-node[data-session-id="ses_e2echild"] .session-chevron')
    .first()
    .click();
  await expect(page.locator('.session-node[data-session-id="ses_e2egrandchild"]')).toBeVisible();

  await page.locator("[data-chat-new-session]").click();
  await expect(page).toHaveURL(/session=ses_e2ecreated\d+/);
  const created = new URL(page.url()).searchParams.get("session") ?? "";
  expect(created).toMatch(/^ses_e2ecreated\d+$/);
  await expect(page.locator(`button.session-item[data-session-id="${created}"]`)).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(`[data-session-delete="${created}"]`).click();
  await expect(page.locator(`.session-node[data-session-id="${created}"]`)).toHaveCount(0);
  await expect(page).toHaveURL(/session=ses_e2ealpha/);

  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA history pages on scroll-top, keeps an anchor, and offers new messages", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  const previousStreams = await upstreamStreamCount(page).catch(() => 0);
  await signIn(page, `/chat?app=alpha&project=${PROJECT_ONE}&session=ses_e2ehistory`);
  await expect(page.locator("#chat-scroll [data-message-id]")).toHaveCount(30);
  await waitForUpstreamStream(page, previousStreams);

  const scroll = page.locator("#chat-scroll");
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("#chat-scroll [data-message-id]")).toHaveCount(35);
  await expect(page.locator("[data-chat-history-start]")).toBeVisible();
  const anchorTop = await scroll.evaluate((node) => node.scrollTop);
  expect(anchorTop).toBeGreaterThan(0);
  const ids = await page
    .locator("#chat-scroll [data-message-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id")));
  expect(new Set(ids).size).toBe(ids.length);

  await control(page, {
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_e2ehistory",
        messageID: "msg_e2e_history_live",
        part: {
          id: "prt_e2e_history_live",
          sessionID: "ses_e2ehistory",
          messageID: "msg_e2e_history_live",
          type: "text",
          text: "Synthetic history live message.",
        },
      },
    },
  });
  await expect(page.locator("[data-chat-new-messages]")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-chat-new-messages]").click();
  await expect(page.getByText("Synthetic history live message.")).toBeVisible();
  await expect(page.locator("[data-chat-new-messages]")).toHaveCount(0);

  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA session switching keeps one stream and no duplicate messages", async ({ page }) => {
  test.skip(!isSpa(), "SPA mode only");
  const errors = collectPageErrors(page);
  await installEventSourceCounter(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator('[data-message-id="msg_e2e_user"]')).toHaveCount(1);

  await page.locator('.session-item[data-session-id="ses_e2ehistory"]').click();
  await expect(page).toHaveURL(/session=ses_e2ehistory/);
  await expect(page.locator("#chat-scroll [data-message-id]")).toHaveCount(30);
  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(1);

  await page.locator('.session-item[data-session-id="ses_e2ealpha"]').click();
  await expect(page).toHaveURL(/session=ses_e2ealpha/);
  await expect(page.locator('[data-message-id="msg_e2e_user"]')).toHaveCount(1);
  await expect(page.locator('[data-message-id="msg_e2e_assistant"]')).toHaveCount(1);
  const ids = await page
    .locator("#chat-scroll [data-message-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id")));
  expect(new Set(ids).size).toBe(ids.length);
  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(1);
  await expect.poll(async () => (await eventSourceStats(page)).created).toBe(1);

  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});
