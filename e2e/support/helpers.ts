import { expect, type Page } from "@playwright/test";

export const E2E_TOKEN = "test-operator-token";
export const PROJECT_ONE = "e2e-project-one";
export const PROJECT_TWO = "e2e-project-two";

export async function signIn(page: Page, next = "/projects"): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Operator token (required)").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

/** Collect browser console errors and uncaught page errors for a spec. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Wait for page-triggered fetches (git status, image status) to settle. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

export function expectNoPageErrors(errors: string[]): void {
  expect(errors, errors.join("\n")).toEqual([]);
}
