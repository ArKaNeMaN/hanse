import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  E2E_TOKEN,
  expectNoPageErrors,
  PROJECT_ONE,
  signIn,
  upstreamInfo,
} from "./support/helpers.js";

const APP_PATH = `/projects/${PROJECT_ONE}/apps/alpha`;
const CHAT_PATH = `/chat?app=alpha&project=${PROJECT_ONE}`;
const SESSION_ID = "ses_e2ealpha";

function isSpa(): boolean {
  return test.info().project.name === "spa";
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

function expectNoUnexpected(errors: string[], allowed: readonly RegExp[] = []): void {
  const unexpected = errors.filter((error) => !allowed.some((pattern) => pattern.test(error)));
  expect(unexpected, unexpected.join("\n")).toEqual([]);
}

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

test("legacy chat remains the rollback document", async ({ page }) => {
  test.skip(isSpa(), "legacy mode only");
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator('script[src="/assets/chat.js"]')).toHaveCount(1);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await expect(page.locator('.session-item[data-session-id="ses_e2ealpha"]')).toHaveCount(1);
  await page.waitForTimeout(400);
  expectNoUnexpected(errors, [/50[023]/]);
});

test("legacy sessions rail keeps tree search and disclosure parity", async ({ page }) => {
  test.skip(isSpa(), "legacy mode only");
  const errors = collectPageErrors(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);

  const search = page.locator("#session-search");
  await search.fill("grandchild");
  await expect(page.locator('.session-node[data-session-id="ses_e2egrandchild"]')).toBeVisible();
  await expect(page.locator('.session-node[data-session-id="ses_e2ealpha"]')).toBeVisible();
  await expect(
    page.locator('.session-node[data-session-id="ses_e2ealpha"] .session-chevron').first(),
  ).toHaveAttribute("aria-expanded", "true");
  await search.fill("");
  await page
    .locator('.session-node[data-session-id="ses_e2ealpha"] .session-chevron')
    .first()
    .click();
  await expect(page.locator('.session-node[data-session-id="ses_e2echild"]')).toBeVisible();

  await page.waitForTimeout(400);
  expectNoUnexpected(errors, [/50[023]/]);
});

test("SPA direct load renders the chat shell, boot props, sessions, and messages", async ({
  page,
}) => {
  test.skip(!isSpa(), "SPA mode only");
  const errors = collectPageErrors(page);
  await installEventSourceCounter(page);
  await signIn(page, CHAT_PATH);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator('script[src="/assets/chat.js"]')).toHaveCount(0);
  await expect(page.locator(".page__body--chat")).toHaveCount(1);
  await expect(page.locator(".page-header")).toHaveCount(0);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await expect(page.locator("#chat-scroll")).toHaveCount(1);
  await expect(page.locator("[data-chat-sessions-rail]")).toHaveCount(1);
  await expect(page.locator('.session-item[data-session-id="ses_e2ealpha"]')).toHaveCount(1);
  await expect(page.getByText("Hello from the synthetic E2E fixture.")).toBeVisible();
  await expect(page.getByText("Synthetic assistant reply.")).toBeVisible();
  await expect(page.locator("[data-chat-composer-input]")).toBeEnabled();
  await expect(page.locator("[data-chat-send]")).toBeDisabled();

  await expect(page.locator(".topbar__actions #chat-input-needed")).toHaveCount(1);
  await expect(page.locator(".topbar__actions #chat-policy-chip")).toHaveCount(1);
  await expect(page.locator(".topbar__actions #chat-input-needed-count")).toHaveText("0");
  await expect(page.locator(".topbar__actions [data-chat-context-toggle]")).toHaveCount(1);
  await expect(page.locator(".topbar__actions a")).toHaveCount(1);

  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(1);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA client navigation resolves to ChatPage and does not duplicate the surface or stream", async ({
  page,
}) => {
  test.skip(!isSpa(), "SPA mode only");
  const errors = collectPageErrors(page);
  await installEventSourceCounter(page);
  await signIn(page, APP_PATH);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.getByRole("link", { name: "Open chat" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/chat\\?app=alpha&project=${PROJECT_ONE}`));
    await expect(page.locator("#chat-shell")).toHaveCount(1);
    await expect(page.locator("#chat-scroll")).toHaveCount(1);
    await expect.poll(async () => (await eventSourceStats(page)).active).toBe(1);
    await expect.poll(async () => (await eventSourceStats(page)).created).toBe(cycle + 1);

    const ids = await page
      .locator("#chat-scroll [data-message-id]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id")));
    expect(new Set(ids).size).toBe(ids.length);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}/apps/alpha$`));
    await expect.poll(async () => (await eventSourceStats(page)).active).toBe(0);
  }

  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA renders live deltas, tool parts, status, and a resync warning", async ({ page }) => {
  test.skip(!isSpa(), "SPA mode only");
  const errors = collectPageErrors(page);
  const previousStreams = await upstreamStreamCount(page).catch(() => 0);
  await signIn(page, CHAT_PATH);
  await expect(page.getByText("Synthetic assistant reply.")).toBeVisible();
  await expect(page.locator(".chat-runtime")).toContainText("Live");
  await waitForUpstreamStream(page, previousStreams);
  await page.waitForTimeout(500);

  await control(page, {
    frames: [
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          messageID: "msg_e2e_live",
          part: {
            id: "prt_e2e_live_text",
            sessionID: SESSION_ID,
            messageID: "msg_e2e_live",
            type: "text",
            text: "Live ",
          },
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: SESSION_ID,
          messageID: "msg_e2e_live",
          partID: "prt_e2e_live_text",
          field: "text",
          delta: "delta.",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          messageID: "msg_e2e_live",
          part: {
            id: "prt_e2e_live_tool",
            sessionID: SESSION_ID,
            messageID: "msg_e2e_live",
            type: "tool",
            tool: "e2e_tool",
            state: { status: "running", input: { command: "echo fixture" } },
          },
        },
      },
      {
        type: "session.status",
        properties: { sessionID: SESSION_ID, status: { type: "busy" } },
      },
    ],
  });

  await expect(page.getByText(/Live delta\./)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-tool="e2e_tool"]')).toHaveCount(1);
  await expect(page.locator(".chat-runtime")).toContainText("Live");

  // A delta over the server's per-frame budget emits a stream.warning and forces a resync.
  await control(page, {
    event: {
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        messageID: "msg_e2e_live",
        partID: "prt_e2e_live_text",
        field: "text",
        delta: "x".repeat(65 * 1024),
      },
    },
  });
  await expect(page.getByText(/dropped a text delta larger than/).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA reconnects after the upstream stream closes without a second EventSource", async ({
  page,
}) => {
  test.skip(!isSpa(), "SPA mode only");
  const errors = collectPageErrors(page);
  await installEventSourceCounter(page);
  const previousStreams = await upstreamStreamCount(page).catch(() => 0);
  await signIn(page, CHAT_PATH);
  await expect(page.locator(".chat-runtime")).toContainText("Live");
  await waitForUpstreamStream(page, previousStreams);

  await control(page, { streamClose: true });
  await expect(page.locator(".chat-runtime")).toContainText("Live", { timeout: 20_000 });
  await expect.poll(async () => (await eventSourceStats(page)).created).toBe(1);
  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(1);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA chat redirects to login when an authenticated read expires", async ({ page }) => {
  test.skip(!isSpa(), "SPA mode only");
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await page.context().clearCookies();
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 20_000 });
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("next") ?? "")).toContain("/chat");
});

test("SPA shows the stopped shell and preserves a requested session", async ({ page }) => {
  test.skip(!isSpa(), "SPA mode only");
  const errors = collectPageErrors(page);
  await signIn(page, `/chat?app=beta&project=${PROJECT_ONE}&session=ses_keep_me`);
  await expect(page.locator("[data-chat-stopped]")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/session=ses_keep_me/);
  await page.waitForTimeout(400);
  expectNoUnexpected(errors, [/503/, /500/]);
});

test("SPA off-set and ?legacy=1 chat still serve the legacy document", async ({ page }) => {
  test.skip(!isSpa(), "SPA mode only");
  const errors = collectPageErrors(page);
  await signIn(page, `${CHAT_PATH}&legacy=1`);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator('script[src="/assets/chat.js"]')).toHaveCount(1);
  await expect(page.locator("#chat-shell")).toHaveCount(1);

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    await signInAt(page, origin, CHAT_PATH);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.locator('script[src="/assets/chat.js"]')).toHaveCount(1);
    await expect(page.locator("#chat-shell")).toHaveCount(1);
  }
  await page.waitForTimeout(400);
  expectNoUnexpected(errors, [/50[023]/]);
});
