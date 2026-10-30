import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  E2E_TOKEN,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
  upstreamInfo,
} from "./support/helpers.js";

const TERMINAL_PATH = `/terminal?app=alpha&project=${PROJECT_ONE}`;
const BETA_TERMINAL_PATH = `/terminal?app=beta&project=${PROJECT_ONE}`;

function isSpa(): boolean {
  return test.info().project.name === "spa";
}

function status(page: Page) {
  return page.locator(".terminal-toolbar__status .status");
}

async function openTerminal(page: Page, path = TERMINAL_PATH): Promise<void> {
  await signIn(page, path);
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator(".terminal-toolbar__title")).toContainText("alpha / Operator terminal");
}

async function waitForLive(page: Page): Promise<void> {
  await expect(status(page)).toContainText("Live", { timeout: 15_000 });
}

async function upstreamState(page: Page) {
  const port = Number(new URL(page.url()).port);
  return (await fetch(`${upstreamInfo(port).url}/__state`).then((response) => response.json())) as {
    runner: {
      connections: number;
      resizes: Array<{ cols: number; rows: number }>;
      closed: boolean;
      lastCloseCode: number | null;
    };
  };
}

async function closeRunner(page: Page, code: 1000 | 1001 | 1011): Promise<void> {
  const port = Number(new URL(page.url()).port);
  const response = await fetch(`${upstreamInfo(port).url}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runnerClose: code }),
  });
  expect(response.ok).toBe(true);
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

test("direct load connects, renders the host, and round-trips input and resize", async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTerminal(page);
  await waitForLive(page);

  await expect(page.locator('link[href="/assets/vendor/xterm/xterm-6.0.0.css"]')).toHaveCount(1);
  await expect(page.locator("script[src='/assets/vendor/xterm/xterm-6.0.0.js']")).toHaveCount(1);
  await expect(page.locator("#terminal-host")).toHaveCount(1);
  await expect(page.locator("#terminal-host .xterm")).toHaveCount(1);
  if (isSpa()) {
    await expect(page.locator("#hanse-boot")).toHaveCount(1);
    await expect(page.locator('script[src="/assets/terminal.js"]')).toHaveCount(0);
  } else {
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.locator('script[src="/assets/terminal.js"]')).toHaveCount(1);
  }

  await page.locator("#terminal-host").click();
  await page.keyboard.type("echo-e2e");
  await expect(page.locator("#terminal-host .xterm-rows")).toContainText("echo-e2e", {
    timeout: 15_000,
  });

  await expect(page.locator("#terminal-copy")).toBeDisabled();
  // The copy path is SPA-owned; the legacy client is only the rollback document.
  if (isSpa()) {
    const screen = page.locator("#terminal-host .xterm-screen");
    const box = await screen.boundingBox();
    if (box !== null) {
      for (const offset of [4, 8, 12]) {
        await page.mouse.move(box.x + 2, box.y + offset);
        await page.mouse.down();
        await page.mouse.move(box.x + Math.min(300, box.width - 4), box.y + offset, {
          steps: 5,
        });
        await page.mouse.up();
        await page.waitForTimeout(100);
        if (await page.locator("#terminal-copy").isEnabled()) {
          break;
        }
      }
    }
    await expect(page.locator("#terminal-copy")).toBeEnabled({ timeout: 10_000 });
    await page.locator("#terminal-copy").click();
    await expect(page.locator("#terminal-announcer")).toContainText("Copied selection.");
  }

  const before = (await upstreamState(page)).runner.resizes.length;
  await page.setViewportSize({ width: 640, height: 520 });
  await expect
    .poll(async () => (await upstreamState(page)).runner.resizes.length, { timeout: 15_000 })
    .toBeGreaterThan(before);
  const resize = (await upstreamState(page)).runner.resizes.at(-1);
  expect(resize?.cols).toBeGreaterThanOrEqual(1);
  expect(resize?.cols).toBeLessThanOrEqual(1000);
  expect(resize?.rows).toBeGreaterThanOrEqual(1);
  expect(resize?.rows).toBeLessThanOrEqual(1000);

  await settle(page);
  expectNoPageErrors(errors);
});

test("a client navigation into the terminal reuses the vendor stylesheet", async ({ page }) => {
  test.skip(!isSpa(), "legacy terminal links intentionally full-document-load");
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}/apps/alpha`);
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
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#terminal-title")).toContainText("alpha / Operator terminal");
  await expect(page.locator('link[href="/assets/vendor/xterm/xterm-6.0.0.css"]')).toHaveCount(1);
  await expect(page.locator("#terminal-host .xterm")).toHaveCount(1);
  await waitForLive(page);

  await settle(page);
  expectNoPageErrors(errors);
});

test("shows the stopped state for a stopped agent and links to chat", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, BETA_TERMINAL_PATH);
  await expect(page.locator(".empty-state__title")).toContainText("Agent is not running");
  await expect(status(page)).toContainText("Agent stopped");
  await expect(page.locator("[data-terminal-chat]")).toHaveAttribute(
    "href",
    `/chat?app=beta&project=${PROJECT_ONE}`,
  );
  await expect(page.locator("[data-terminal-retry]")).toBeVisible();
  await settle(page);
  expectNoPageErrors(errors);
});

test("shows the stopped state when the runtime reports an error", async ({ page }) => {
  await page.route(/\/api\/apps\/alpha\/runtime\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state: "error" }),
    }),
  );
  await openTerminal(page);
  await expect(page.locator(".empty-state__title")).toContainText("Agent is not running");
  await expect(status(page)).toContainText("Agent stopped");
});

test("manual close and reconnect keep one socket and one host", async ({ page }) => {
  const errors = collectPageErrors(page);
  await openTerminal(page);
  await waitForLive(page);

  const before = (await upstreamState(page)).runner.connections;
  await page.locator("#terminal-close").click();
  await expect(status(page)).toContainText("Terminal closed");
  await expect(page.locator("#terminal-banner")).toContainText(
    "Terminal closed. The application keeps running.",
  );

  await page.locator("#terminal-reconnect").click();
  await waitForLive(page);
  await expect(page.locator("#terminal-host")).toHaveCount(1);
  await expect(page.locator("#terminal-host .xterm")).toHaveCount(1);
  await expect
    .poll(async () => (await upstreamState(page)).runner.connections, { timeout: 15_000 })
    .toBeGreaterThan(before);

  await settle(page);
  expectNoPageErrors(errors);
});

for (const code of [1000, 1001] as const) {
  test(`a normal shell exit (${code}) is reported and does not auto-reconnect`, async ({
    page,
  }) => {
    await openTerminal(page);
    await waitForLive(page);
    await closeRunner(page, code);
    await expect(status(page)).toContainText("Shell exited", { timeout: 15_000 });
    await expect(page.locator("#terminal-banner")).toContainText(
      "Shell exited. Reconnect to start a new shell.",
    );
    await expect(page.locator("#terminal-host")).toHaveCount(1);
  });
}

test("a 1011 failure reports and reconnects within the bounded retry", async ({ page }) => {
  await openTerminal(page);
  await waitForLive(page);
  await closeRunner(page, 1011);
  await expect(status(page)).toContainText("Connection failed", { timeout: 15_000 });
  await expect(page.locator("#terminal-banner")).toContainText("Connection failed");
  await waitForLive(page);
});

test("auth expiry on a retryable close redirects to login with next", async ({ page }) => {
  test.skip(!isSpa(), "the legacy client has no cookie auth probe");
  await openTerminal(page);
  await waitForLive(page);
  await page.route("**/api/ui/chrome**", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
  );
  await page.context().clearCookies();

  await closeRunner(page, 1011);
  await expect(status(page)).toContainText(/Connection failed|Paused/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 15_000 });
  const next = new URL(page.url()).searchParams.get("next") ?? "";
  expect(next).toContain("/terminal");
  expect(next).toContain("app=alpha");
});

test("a runner-unavailable upgrade shows a retrying status without a page error", async ({
  page,
}) => {
  await page.routeWebSocket(/\/api\/apps\/alpha\/terminal/, (ws) => {
    ws.close({ code: 1011 });
  });
  const errors = collectPageErrors(page);
  await openTerminal(page);
  await expect(status(page)).toContainText(/Connection failed|Reconnecting/, { timeout: 15_000 });
  expectNoPageErrors(errors);
});

test("?legacy=1 still serves the legacy terminal document", async ({ page }) => {
  await signIn(page, `${TERMINAL_PATH}&legacy=1`);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator('script[src="/assets/terminal.js"]')).toHaveCount(1);
  await expect(page.locator(".terminal-shell")).toHaveCount(1);
  await expect(page.locator('link[href="/assets/vendor/xterm/xterm-6.0.0.css"]')).toHaveCount(1);
});

test("the legacy and empty-allowlist servers still serve the legacy terminal", async ({ page }) => {
  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    await signInAt(page, origin, TERMINAL_PATH);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.locator('script[src="/assets/terminal.js"]')).toHaveCount(1);
    await expect(page.locator(".terminal-shell")).toHaveCount(1);
  }
});
