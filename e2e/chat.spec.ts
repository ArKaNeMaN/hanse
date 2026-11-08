import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  E2E_TOKEN,
  expectNoPageErrors,
  PROJECT_ONE,
  PROJECT_TWO,
  resetUpstreamStatuses,
  signIn,
  upstreamInfo,
} from "./support/helpers.js";

const APP_PATH = `/projects/${PROJECT_ONE}/apps/alpha`;
const CHAT_PATH = `/chat?app=alpha&project=${PROJECT_ONE}`;
const SESSION_ID = "ses_e2ealpha";

test.beforeEach(async () => {
  await resetUpstreamStatuses();
});

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

async function _signInAt(page: Page, origin: string, path: string): Promise<void> {
  await page.goto(`${origin}/login?next=${encodeURIComponent(path)}`);
  if (new URL(page.url()).pathname !== "/login") {
    await page.goto(`${origin}${path}`);
    return;
  }
  await page.getByLabel("Operator token (required)").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === path.split("?")[0]);
}

test("SPA direct load renders the chat shell, boot props, sessions, and messages", async ({
  page,
}) => {
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

  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(2);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA client navigation resolves to ChatPage and does not duplicate the surface or stream", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "spa", "client navigation requires an SPA source page");
  const errors = collectPageErrors(page);
  await installEventSourceCounter(page);
  await signIn(page, APP_PATH);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.getByRole("link", { name: "Open chat" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/chat\\?app=alpha&project=${PROJECT_ONE}`));
    await expect(page.locator("#chat-shell")).toHaveCount(1);
    await expect(page.locator("#chat-scroll")).toHaveCount(1);
    await expect.poll(async () => (await eventSourceStats(page)).active).toBe(2);
    // The application page opens one process stream; each chat visit adds the chat stream and its
    // process stream. Going back re-opens the application page process stream.
    await expect.poll(async () => (await eventSourceStats(page)).created).toBe((cycle + 1) * 3);

    const ids = await page
      .locator("#chat-scroll [data-message-id]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id")));
    expect(new Set(ids).size).toBe(ids.length);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}/apps/alpha$`));
    await expect.poll(async () => (await eventSourceStats(page)).active).toBe(1);
  }

  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA renders live deltas, tool parts, status, and a resync warning", async ({ page }) => {
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
  const errors = collectPageErrors(page);
  await installEventSourceCounter(page);
  const previousStreams = await upstreamStreamCount(page).catch(() => 0);
  await signIn(page, CHAT_PATH);
  await expect(page.locator(".chat-runtime")).toContainText("Live");
  await waitForUpstreamStream(page, previousStreams);

  await control(page, { streamClose: true });
  await expect(page.locator(".chat-runtime")).toContainText("Live", { timeout: 20_000 });
  await expect.poll(async () => (await eventSourceStats(page)).created).toBe(2);
  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(2);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA bfcache pagehide/pageshow keeps one surface and one live source", async ({ page }) => {
  const errors = collectPageErrors(page);
  await installEventSourceCounter(page);
  await signIn(page, CHAT_PATH);
  await expect(page.locator(".chat-runtime")).toContainText("Live");
  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(2);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect.poll(async () => (await eventSourceStats(page)).active).toBe(2);
  await expect.poll(async () => (await eventSourceStats(page)).created).toBe(4);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  const ids = await page
    .locator("#chat-scroll [data-message-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id")));
  expect(new Set(ids).size).toBe(ids.length);
  await page.waitForTimeout(400);
  expectNoPageErrors(errors);
});

test("SPA chat redirects to login when an authenticated read expires", async ({ page }) => {
  await signIn(page, CHAT_PATH);
  await expect(page.locator("#chat-shell")).toHaveCount(1);
  await page.context().clearCookies();
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 20_000 });
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("next") ?? "")).toContain("/chat");
});

test("SPA shows the stopped shell and preserves a requested session", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/chat?app=beta&project=${PROJECT_ONE}&session=ses_keep_me`);
  await expect(page.locator("[data-chat-stopped]")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/session=ses_keep_me/);
  await page.waitForTimeout(400);
  expectNoUnexpected(errors, [/503/, /500/]);
});

test("SPA chat remounts during a slow start with the starting panel and no Start", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  const appId = `${PROJECT_ONE}:beta`;
  await signIn(page, "/");
  try {
    await control(page, {
      event: {
        processSnapshot: {
          appId,
          state: "starting",
          phase: "waiting_ready",
          attemptId: "e2e-slow-start",
          startedAt: new Date(Date.now() - 5_000).toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await page.goto(`/chat?app=beta&project=${PROJECT_ONE}&session=ses_keep_me`);
    await expect(page.locator("[data-chat-starting]")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-chat-starting]")).toContainText("Starting agent");
    await expect(page.locator("[data-chat-process-elapsed]")).toBeVisible();
    await expect(page.locator("[data-chat-start-agent]")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("[data-chat-starting]")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-chat-start-agent]")).toHaveCount(0);
    await page.waitForTimeout(400);
    expectNoUnexpected(errors, [/503/]);
  } finally {
    await control(page, {
      event: { processSnapshot: { appId, state: "stopped", phase: "stopped" } },
    });
  }
});

test("SPA chat shows the persisted process error with Retry and history", async ({ page }) => {
  const errors = collectPageErrors(page);
  const appId = `${PROJECT_TWO}:gamma`;
  await signIn(page, "/");
  try {
    await control(page, {
      event: {
        processSnapshot: {
          appId,
          state: "error",
          phase: "failed",
          attemptId: "e2e-error-start",
          errorCode: "readiness_timeout",
          errorMessage: "The fixture readiness probe timed out.",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await page.goto(`/chat?app=gamma&project=${PROJECT_TWO}`);
    await expect(page.locator("[data-chat-process-error]")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-chat-process-error-message]")).toContainText(
      "The fixture readiness probe timed out.",
    );
    await expect(page.locator("[data-chat-retry-agent]")).toBeVisible();
    await expect(page.locator("[data-chat-process-history]")).toHaveAttribute(
      "href",
      `/projects/${PROJECT_TWO}/apps/gamma#process-history`,
    );
    await expect(page.locator("[data-chat-stopped]")).toHaveCount(0);
    await page.waitForTimeout(400);
    expectNoUnexpected(errors, [/503/]);
  } finally {
    await control(page, {
      event: { processSnapshot: { appId, state: "stopped", phase: "stopped" } },
    });
  }
});
