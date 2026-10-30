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
  await expect(page.locator("[data-chat-composer-input]")).toBeEnabled();
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

test("SPA chat exposes session navigation and an enabled composer without automatic writes", async ({
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
  await expect(page.locator("[data-chat-composer-input]")).toBeEnabled();
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

async function newComposerSession(page: Page): Promise<string> {
  await page.locator("[data-chat-new-session]").click();
  await expect(page).toHaveURL(/session=ses_e2ecreated\d+/);
  const id = new URL(page.url()).searchParams.get("session") ?? "";
  expect(id).toMatch(/^ses_e2ecreated\d+$/);
  return id;
}

function composerInput(page: Page) {
  return page.locator("[data-chat-composer-input]");
}

async function messageIDs(page: Page): Promise<string[]> {
  return page
    .locator("#chat-scroll [data-message-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id") ?? ""));
}

test("SPA composer saves, restores, and deletes-if-empty a workspace draft", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  const session = await newComposerSession(page);
  const input = composerInput(page);

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes(`/sessions/${session}/draft`),
  );
  await input.fill("E2E draft saved");
  await saved;

  await page.reload();
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await expect(composerInput(page)).toHaveValue("E2E draft saved");

  await page.locator('.session-item[data-session-id="ses_e2ehistory"]').click();
  await expect(page).toHaveURL(/session=ses_e2ehistory/);
  await expect(composerInput(page)).toHaveValue("");
  await page.locator(`.session-item[data-session-id="${session}"]`).click();
  await expect(page).toHaveURL(new RegExp(`session=${session}`));
  await expect(composerInput(page)).toHaveValue("E2E draft saved");

  const cleared = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes(`/sessions/${session}/draft`),
  );
  await composerInput(page).fill("");
  await cleared;
  await expect(page.locator(`.session-item[data-session-id="${session}"]`)).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page).not.toHaveURL(new RegExp(`session=${session}`));
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA send shows one optimistic row, streams a reply, and keeps one EventSource", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await installEventSourceCounter(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  const session = await newComposerSession(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/messages")) {
      writes.push(request.url());
    }
  });

  await composerInput(page).fill("E2E outbound message");
  await composerInput(page).press("Enter");
  await expect(page.getByText("E2E outbound message").first()).toBeVisible();
  await expect(page.locator('#chat-scroll [data-message-id^="local_"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect.poll(() => writes.length).toBe(1);
  await expect(composerInput(page)).toHaveValue("");
  await expect(composerInput(page)).toBeFocused();
  const ids = await messageIDs(page);
  expect(new Set(ids).size).toBe(ids.length);

  await control(page, {
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: session,
        messageID: "msg_e2e_stream_reply",
        part: {
          id: "prt_e2e_stream_reply",
          sessionID: session,
          messageID: "msg_e2e_stream_reply",
          type: "text",
          text: "Streamed E2E reply.",
        },
      },
    },
  });
  await expect(page.getByText("Streamed E2E reply.")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(1);
  await expect.poll(async () => (await eventSourceStats(page)).created).toBe(1);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA falls back to blocking delivery when the async prompt route is unavailable", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await newComposerSession(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/messages")) {
      writes.push(request.url());
    }
  });
  await page.route(/\/messages\?.*async=1/, (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: "async prompt route unavailable",
        code: "async_unavailable",
        outcome: "not_sent",
      }),
    }),
  );

  await composerInput(page).fill("Blocking delivery");
  await composerInput(page).press("Enter");
  await expect(page.getByText("Blocking delivery").first()).toBeVisible();
  await expect.poll(() => writes.filter((url) => url.includes("async=0")).length).toBe(1);
  await expect(page.locator('#chat-scroll [data-message-id^="local_"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  await page.waitForTimeout(400);
  expect(errors.filter((error) => !error.includes("502"))).toEqual([]);
});

test("SPA unknown delivery exposes Check again and Remove", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await newComposerSession(page);
  await page.route(/\/messages\?/, (route) => {
    if (route.request().method() !== "POST") {
      return route.continue();
    }
    return route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: "upstream unavailable",
        code: "agent_unavailable",
        outcome: "unknown",
        messageID: "msg_e2e_unknown",
      }),
    });
  });

  await composerInput(page).fill("Unknown delivery");
  await composerInput(page).press("Enter");
  await expect(page.locator('[data-message-id="msg_e2e_unknown"]')).toContainText(
    "Unknown delivery",
  );
  await expect(page.locator("[data-chat-send-recovery]")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-chat-send-check]").click();
  await expect(page.locator("[data-chat-send-recovery]")).toBeVisible();
  await page.locator("[data-chat-send-remove]").click();
  await expect(page.locator('[data-message-id="msg_e2e_unknown"]')).toHaveCount(0);
  await expect(page.locator("[data-chat-send-recovery]")).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(errors.filter((error) => !error.includes("502"))).toEqual([]);
});

test("SPA queue strip and dialog show deriveQueue rows, then Stop settles idle", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await newComposerSession(page);
  await control(page, {
    event: {
      type: "session.status",
      properties: {
        sessionID: new URL(page.url()).searchParams.get("session"),
        status: { type: "busy" },
      },
    },
  });

  await composerInput(page).fill("Queued first");
  await composerInput(page).press("Enter");
  await expect(page.getByText("Queued first").first()).toBeVisible();
  await composerInput(page).fill("Queued second");
  await composerInput(page).press("Enter");
  await expect(page.locator("[data-chat-queue-strip]")).toBeVisible();
  await expect(page.locator("[data-chat-queue-strip]")).toContainText("Queued second");

  await page.locator("[data-chat-queue-open]").click();
  await expect(page.locator("[data-chat-queue-dialog]")).toBeVisible();
  await expect(page.locator("[data-chat-queue-dialog] [data-queue-id]")).toHaveCount(1);
  await page.locator("[data-chat-queue-close]").click();
  await expect(page.locator("[data-chat-queue-dialog]")).toHaveCount(0);

  await page.locator("[data-chat-abort]").click();
  await control(page, {
    event: {
      type: "session.status",
      properties: {
        sessionID: new URL(page.url()).searchParams.get("session"),
        status: { type: "idle" },
      },
    },
  });
  await expect(page.locator("[data-chat-abort]")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator("[data-chat-send]")).toBeVisible();
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA Stop after a rapid send keeps one accepted row and settles idle", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await newComposerSession(page);
  await control(page, {
    event: {
      type: "session.status",
      properties: {
        sessionID: new URL(page.url()).searchParams.get("session"),
        status: { type: "busy" },
      },
    },
  });

  await composerInput(page).fill("Rapid draft");
  await composerInput(page).press("Enter");
  await expect(page.getByText("Rapid draft").first()).toBeVisible();
  await expect(page.locator('#chat-scroll [data-message-id^="local_"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  await page.locator("[data-chat-abort]").click();
  await control(page, {
    event: {
      type: "session.status",
      properties: {
        sessionID: new URL(page.url()).searchParams.get("session"),
        status: { type: "idle" },
      },
    },
  });
  await expect(page.locator("[data-chat-abort]")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator("[data-chat-send]")).toBeVisible();
  await expect(page.locator('#chat-scroll [data-message-id^="local_"]')).toHaveCount(0);
  await expect(page.locator("[data-chat-send-error]")).toHaveCount(0);
  const ids = await messageIDs(page);
  expect(new Set(ids).size).toBe(ids.length);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA redirects to login with next when auth expires mid-send", async ({ page }) => {
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await newComposerSession(page);
  await expect(page.locator("#chat-shell")).toHaveCount(1);

  await composerInput(page).fill("Auth expiry send");
  await page.context().clearCookies();
  await composerInput(page).press("Enter");
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 15_000 });
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("next") ?? "")).toContain("/chat");
});

test("SPA feed renders markdown tables, reasoning, tools, bash, OMO, handoff, notices, and unknown parts", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await installWorkerCounter(page);
  await signIn(page, `/chat?app=alpha&project=${PROJECT_ONE}&session=ses_e2erender`);
  await expect(page.locator("#chat-shell")).toHaveCount(1);

  const scroll = page.locator("#chat-scroll");
  await expect(scroll.locator("table")).toHaveCount(1);
  await expect(scroll.locator("table")).toContainText("alpha");
  await expect(scroll.locator(".chat-reasoning")).toHaveCount(1);
  await expect(scroll.locator('[data-tool="bash"]')).toContainText("fixture tests passed");
  await expect(scroll.locator("[data-omo-card]")).toContainText("BACKGROUND TASK COMPLETED");
  await expect(scroll.locator("[data-handoff-card]")).toContainText("Fixture handoff reply");
  await expect(scroll.locator("[data-handoff-card]")).toContainText("Reviewed in the fixture.");
  await expect(scroll).toContainText("Unsupported content: mystery");
  await expect(scroll).toContainText("<script>window.__bad = true</script>");
  expect(
    await page.evaluate(() => (window as unknown as { __bad?: boolean }).__bad),
  ).toBeUndefined();
  await expect(page.locator('script[src*="prism"]')).toHaveCount(0);
  expect(await workerStats(page)).toEqual({ constructed: 0, terminated: 0 });

  await control(page, {
    event: {
      type: "notice.created",
      properties: {
        sessionID: "ses_e2erender",
        notice: {
          id: "notice_e2e_render",
          sessionId: "ses_e2erender",
          kind: "agent_stopped",
          reason: "operator_restart",
          createdAt: "2026-10-30T00:00:00.000Z",
        },
      },
    },
  });
  await expect(page.locator('[data-notice-id="notice_e2e_render"]')).toContainText(
    "Agent was restarted here",
  );

  await page.locator('[data-part-id="prt_e2e_render_edit"] summary').click();
  await expect(page.locator('[data-part-id="prt_e2e_render_edit"] .tool-diff__file')).toBeVisible();
  await expect
    .poll(async () => (await workerStats(page)).constructed, { timeout: 15_000 })
    .toBeGreaterThan(0);

  await page.locator('[data-part-id="prt_e2e_render_oversized"] summary').click();
  await expect(
    page.locator('[data-part-id="prt_e2e_render_oversized"] [data-tool-truncated]'),
  ).toContainText(/truncated at 64 KiB per file|truncated at the 128 KiB total limit/);

  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA streams text and tool output without replacing the feed DOM", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  const session = await newComposerSession(page);
  const messageID = "msg_e2e_stream_surface";
  const textPartID = "prt_e2e_stream_text";
  const toolPartID = "prt_e2e_stream_tool";

  await control(page, {
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: session,
        messageID,
        part: {
          id: textPartID,
          sessionID: session,
          messageID,
          type: "text",
          text: "Streaming text start.",
        },
      },
    },
  });
  await expect(page.getByText("Streaming text start.")).toBeVisible({ timeout: 15_000 });
  await page.locator(`[data-part-id="${textPartID}"]`).evaluate((node) => {
    (node as unknown as { __feedIdentity?: string }).__feedIdentity = "kept";
  });

  for (const delta of [" More", " text", " arrives."]) {
    await control(page, {
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: session,
          messageID,
          partID: textPartID,
          partType: "text",
          field: "text",
          delta,
        },
      },
    });
  }
  await expect(page.locator(`[data-part-id="${textPartID}"]`)).toContainText(
    "Streaming text start. More text arrives.",
    { timeout: 15_000 },
  );
  expect(
    await page.locator(`[data-part-id="${textPartID}"]`).evaluate((node) => {
      return (node as unknown as { __feedIdentity?: string }).__feedIdentity;
    }),
  ).toBe("kept");

  await control(page, {
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: session,
        messageID,
        part: {
          id: toolPartID,
          sessionID: session,
          messageID,
          type: "tool",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "npm run e2e" },
            metadata: { output: "first line" },
          },
        },
      },
    },
  });
  const tool = page.locator(`[data-part-id="${toolPartID}"]`);
  await expect(tool).toContainText("first line", { timeout: 15_000 });
  await page.waitForTimeout(150);

  await control(page, {
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: session,
        messageID,
        part: {
          id: toolPartID,
          sessionID: session,
          messageID,
          type: "tool",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "npm run e2e" },
            metadata: { output: "first line\nsecond line" },
          },
        },
      },
    },
  });
  await expect(tool).toContainText("second line", { timeout: 15_000 });
  await expect(page.locator(`#chat-scroll [data-message-id="${messageID}"]`)).toHaveCount(1);

  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA empty session shows the composer-ready empty state", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/chat?app=alpha&project=${PROJECT_ONE}&session=ses_e2echild`);
  await expect(page.locator("[data-chat-empty]")).toContainText(
    "Send the first message to start the agent.",
  );
  await expect(page.locator("[data-chat-composer-input]")).toBeEnabled();
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA render session scrolls cleanly at 390/1440 in light and dark", async ({ page }) => {
  test.slow();
  const errors = collectPageErrors(page);
  await signIn(page, `/chat?app=alpha&project=${PROJECT_ONE}&session=ses_e2erender`);
  for (const width of [390, 1440]) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate((value) => localStorage.setItem("hanse-theme", value), theme);
      await page.reload();
      await expect(page.locator("#chat-shell")).toHaveCount(1);
      await expect(page.locator("#chat-scroll table")).toBeVisible({ timeout: 15_000 });
      await page.locator("#chat-scroll").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event("scroll"));
      });
      await expect(page.locator("[data-chat-message-count]")).toBeVisible();
      await page.locator("#chat-scroll table").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/chat-render-${width}-${theme}.png`,
        fullPage: false,
      });
    }
  }
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

async function installWorkerCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Original = window.Worker;
    let constructed = 0;
    let terminated = 0;
    class CountingWorker extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        constructed += 1;
      }
      override terminate(): void {
        terminated += 1;
        super.terminate();
      }
    }
    Object.defineProperty(window, "Worker", {
      value: CountingWorker,
      configurable: true,
    });
    Object.defineProperty(window, "__chatWorkerStats", {
      value: {
        get constructed() {
          return constructed;
        },
        get terminated() {
          return terminated;
        },
      },
      configurable: true,
    });
  });
}

async function workerStats(page: Page): Promise<{ constructed: number; terminated: number }> {
  return page.evaluate(() => {
    const stats = (
      window as unknown as { __chatWorkerStats?: { constructed: number; terminated: number } }
    ).__chatWorkerStats;
    return stats === undefined
      ? { constructed: 0, terminated: 0 }
      : { constructed: stats.constructed, terminated: stats.terminated };
  });
}

test("SPA loads a 500-message thread and records chunk transfer and heap", async ({
  page,
  context,
}) => {
  test.slow();
  const errors = collectPageErrors(page);
  await signIn(page, `/chat?app=alpha&project=${PROJECT_ONE}&session=ses_e2eperf`);
  const messages = page.locator("#chat-scroll [data-message-id]");
  await expect(messages.first()).toBeVisible({ timeout: 15_000 });

  const chatResources = await page.evaluate(() => {
    const entries = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/assets/ui/")) as PerformanceResourceTiming[];
    return {
      count: entries.length,
      transferBytes: entries.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      gzipBytes: entries.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
    };
  });

  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const count = await messages.count();
    if (count >= 500) break;
    await page.locator("#chat-scroll").evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(async () => messages.count(), { timeout: 15_000 }).toBeGreaterThan(count);
  }
  await expect(messages).toHaveCount(500, { timeout: 30_000 });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  const heap = metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
  const detail = `chat chunk resources=${chatResources.count} transfer=${chatResources.transferBytes}B encoded=${chatResources.gzipBytes}B; 500-message JSHeapUsedSize=${Math.round(heap / 1024)}KiB`;
  test.info().annotations.push({ type: "chat-perf", description: detail });
  console.log(`chat-perf: ${detail}`);

  await page.waitForTimeout(300);
  expectNoPageErrors(errors);
});
