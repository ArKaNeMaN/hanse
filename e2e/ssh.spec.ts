import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

test.describe.configure({ mode: "serial" });

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "ZTJlLXRlc3Qta2V5LW5vdC1yZWFs",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");
const KEY_MARKER = "ZTJlLXRlc3Qta2V5LW5vdC1yZWFs";

function spaMode(): boolean {
  return test.info().project.name === "spa";
}

function unique(label: string): string {
  return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function submitAndExpect(
  page: Page,
  match: (url: URL, method: string) => boolean,
  status: number,
  click: () => Promise<void>,
  message?: string,
): Promise<void> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return match(url, response.request().method());
  });
  await click();
  const response = await responsePromise;
  expect(response.status()).toBe(status);
  if (message !== undefined) {
    await expect(page.locator("#toast-region")).toContainText(message);
  }
}

function openHostCard(page: Page, name: string): Locator {
  return page
    .locator(".ssh-host")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
}

async function openHostDetails(card: Locator): Promise<void> {
  const details = card.locator("details.ssh-host__key");
  if ((await details.getAttribute("open")) === null) {
    await details.locator("summary").click();
  }
}

test("renders hosts, scoped access, grants, approvals, audit, and target queries", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/ssh");

  expect(await page.locator("#hanse-boot").count()).toBe(spaMode() ? 1 : 0);
  await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
  await expect(page.getByText("test-host").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hosts", exact: true })).toBeVisible();
  await expect(page.getByText("echo approve e2e")).toBeVisible();

  await page.goto(`/ssh?target=${PROJECT_ONE}:alpha`);
  await expect(page.locator("#ssh-access")).toBeVisible();
  await expect(page.getByText("Access for E2E Project One / alpha")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await expect(page.getByText("test-operator").first()).toBeVisible();
  await expect(page.locator("#ssh-scope")).toHaveValue(`${PROJECT_ONE}:alpha`);

  await page.goto(`/ssh?project=${PROJECT_ONE}&app=alpha`);
  await expect(page.locator("#ssh-access")).toBeVisible();
  await expect(page.getByText("Access for E2E Project One / alpha")).toBeVisible();

  const content = await page.content();
  expect(content).not.toContain("PRIVATE KEY");
  expect(content).not.toContain(KEY_MARKER);

  await settle(page);
  expectNoPageErrors(errors);
});

test("creates, edits, tests, re-pins, and deletes a host", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/ssh");
  const name = unique("SSH host");
  const renamed = `${name} renamed`;

  await page.getByRole("button", { name: "Add host" }).first().click();
  const add = page.locator("#ssh-add-dialog[open]");
  await expect(add).toBeVisible();
  await add.locator('input[name="name"]').fill(name);
  await add.locator('input[name="address"]').fill("203.0.113.20");
  await add.locator('input[name="username"]').fill("deploy");
  await add.locator('input[name="remoteRoot"]').fill("/srv/app");
  await add.locator('textarea[name="privateKey"]').fill(PRIVATE_KEY);
  await submitAndExpect(
    page,
    (url, method) =>
      (spaMode() ? url.pathname === "/api/ssh/hosts" : url.pathname === "/ssh/hosts") &&
      method === "POST",
    spaMode() ? 201 : 303,
    () => add.getByRole("button", { name: "Add host" }).click(),
    "Host added",
  );

  let card = await openHostCard(page, name);
  await expect(card).toBeVisible();
  expect(await page.content()).not.toContain("PRIVATE KEY");
  expect(await page.content()).not.toContain(KEY_MARKER);

  await card.getByRole("button", { name: "Edit host" }).click();
  const edit = page.locator("dialog.ssh-dialog[open]");
  await expect(edit).toBeVisible();
  await edit.locator(`input[name="name"]`).fill(renamed);
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "PATCH" && /\/api\/ssh\/hosts\/[^/]+$/.test(url.pathname)) ||
      (method === "POST" && /\/ssh\/hosts\/[^/]+\/update$/.test(url.pathname)),
    spaMode() ? 200 : 303,
    () => edit.getByRole("button", { name: "Save host" }).click(),
    "Host updated",
  );

  card = await openHostCard(page, renamed);
  await card.getByRole("button", { name: "Edit host" }).click();
  const editAgain = page.locator("dialog.ssh-dialog[open]");
  await editAgain.locator(`input[name="address"]`).fill("fail.invalid");
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "PATCH" && url.pathname.startsWith("/api/ssh/hosts/")) ||
      (method === "POST" && /\/ssh\/hosts\/[^/]+\/update$/.test(url.pathname)),
    spaMode() ? 200 : 303,
    () => editAgain.getByRole("button", { name: "Save host" }).click(),
    "Host updated",
  );

  card = await openHostCard(page, renamed);
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" && /\/api\/ssh\/hosts\/[^/]+\/test$/.test(url.pathname)) ||
      (method === "POST" && /\/ssh\/hosts\/[^/]+\/test$/.test(url.pathname)),
    200,
    () => card.getByRole("button", { name: "Test connection" }).click(),
    spaMode() ? "Timed out while connecting to the test host." : undefined,
  );
  await expect((await openHostCard(page, renamed)).getByText("Test failed")).toBeVisible();

  card = await openHostCard(page, renamed);
  await card.getByRole("button", { name: "Edit host" }).click();
  const editAddress = page.locator("dialog.ssh-dialog[open]");
  await editAddress.locator(`input[name="address"]`).fill("203.0.113.20");
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "PATCH" && url.pathname.startsWith("/api/ssh/hosts/")) ||
      (method === "POST" && /\/ssh\/hosts\/[^/]+\/update$/.test(url.pathname)),
    spaMode() ? 200 : 303,
    () => editAddress.getByRole("button", { name: "Save host" }).click(),
    "Host updated",
  );

  card = await openHostCard(page, renamed);
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" && /\/api\/ssh\/hosts\/[^/]+\/test$/.test(url.pathname)) ||
      (method === "POST" && /\/ssh\/hosts\/[^/]+\/test$/.test(url.pathname)),
    200,
    () => card.getByRole("button", { name: "Test connection" }).click(),
    spaMode() ? "Connection authenticated." : undefined,
  );
  card = await openHostCard(page, renamed);
  await expect(card.getByText("Authenticated")).toBeVisible();

  await openHostDetails(card);
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" && /\/api\/ssh\/hosts\/[^/]+\/test$/.test(url.pathname)) ||
      (method === "POST" && /\/ssh\/hosts\/[^/]+\/test$/.test(url.pathname)),
    200,
    () => card.getByRole("button", { name: "Prepare re-pin" }).click(),
    spaMode() ? "Re-pin observation recorded." : undefined,
  );
  card = await openHostCard(page, renamed);
  await expect(card.locator("input[name='fingerprint']")).toHaveValue(
    "SHA256:e2e-fixture-fingerprint",
  );
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" && /\/api\/ssh\/hosts\/[^/]+\/re-pin$/.test(url.pathname)) ||
      (method === "POST" && /\/ssh\/hosts\/[^/]+\/re-pin$/.test(url.pathname)),
    spaMode() ? 200 : 303,
    () => card.getByRole("button", { name: "Re-pin host key" }).click(),
    "Host key re-pinned",
  );

  card = await openHostCard(page, renamed);
  await card.getByRole("button", { name: "Edit host" }).click();
  const deleteDialog = page.locator("dialog.ssh-dialog[open]");
  if (!spaMode()) {
    page.once("dialog", (dialog) => dialog.accept());
  }
  const deleteResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      (response.request().method() === "DELETE" &&
        /\/api\/ssh\/hosts\/[^/]+$/.test(url.pathname)) ||
      (response.request().method() === "POST" && /\/ssh\/hosts\/[^/]+\/delete$/.test(url.pathname))
    );
  });
  const deleteButton = deleteDialog.locator(".ssh-form__group--danger button.btn-danger");
  await deleteButton.click();
  if (spaMode()) {
    await deleteButton.click();
  }
  expect((await deleteResponse).status()).toBe(spaMode() ? 200 : 303);
  await expect(page.locator("#toast-region")).toContainText("Host deleted");
  await expect(page.locator(".ssh-host", { hasText: renamed })).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("revokes a grant, approves and rejects requests, and saves the allowlist", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/ssh?target=${PROJECT_ONE}:alpha`);

  const grantRow = page.locator("#ssh-access tbody tr", { hasText: "test-host" }).first();
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" &&
        /\/api\/projects\/[^/]+\/apps\/[^/]+\/ssh\/grants\/[^/]+\/revoke$/.test(url.pathname)) ||
      (method === "POST" && /\/ssh\/grants\/[^/]+\/revoke$/.test(url.pathname)),
    spaMode() ? 200 : 303,
    () => grantRow.getByRole("button", { name: "Revoke" }).click(),
    "Grant revoked",
  );

  const rejectCard = page.locator(".ssh-approval", { hasText: "echo reject e2e" });
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" &&
        /\/api\/apps\/[^/]+\/ssh\/approvals\/[^/]+\/decision$/.test(url.pathname)) ||
      (method === "POST" && /\/ssh\/approvals\/[^/]+\/decision$/.test(url.pathname)),
    spaMode() ? 200 : 303,
    () => rejectCard.getByRole("button", { name: "Reject" }).click(),
    "Approval recorded",
  );

  const approveCard = page.locator(".ssh-approval", { hasText: "echo approve e2e" });
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" &&
        /\/api\/apps\/[^/]+\/ssh\/approvals\/[^/]+\/decision$/.test(url.pathname)) ||
      (method === "POST" && /\/ssh\/approvals\/[^/]+\/decision$/.test(url.pathname)),
    spaMode() ? 200 : 303,
    () => approveCard.getByRole("button", { name: "Approve" }).click(),
    "Approval recorded",
  );

  await page.goto(`/ssh?target=${PROJECT_ONE}:alpha`);
  const allowlist = page.locator("#ssh-access .ssh-allowlist input[type='checkbox']").first();
  await allowlist.uncheck();
  const saveAllowlist = page.getByRole("button", { name: "Save allowlist" });
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" && /\/api\/projects\/[^/]+\/apps\/[^/]+\/ssh$/.test(url.pathname)) ||
      (method === "POST" && url.pathname === "/ssh/grants"),
    spaMode() ? 200 : 303,
    () => saveAllowlist.click(),
    "Allowlist saved",
  );

  await page.goto(`/ssh?target=${PROJECT_ONE}:alpha`);
  await page.locator("#ssh-access .ssh-allowlist input[type='checkbox']").first().check();
  await submitAndExpect(
    page,
    (url, method) =>
      (method === "POST" && /\/api\/projects\/[^/]+\/apps\/[^/]+\/ssh$/.test(url.pathname)) ||
      (method === "POST" && url.pathname === "/ssh/grants"),
    spaMode() ? 200 : 303,
    () => page.getByRole("button", { name: "Save allowlist" }).click(),
    "Allowlist saved",
  );

  await settle(page);
  expectNoPageErrors(errors);
});

test("keeps the legacy form path at 303 and never exposes key material", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/ssh");
  const name = unique("SSH legacy form");

  if (spaMode()) {
    const origin = new URL(page.url()).origin;
    const response = await page.request.post(`${origin}/ssh/hosts`, {
      form: {
        name,
        address: "203.0.113.55",
        port: "22",
        username: "deploy",
        remoteRoot: "",
        privateKey: PRIVATE_KEY,
        requireApproval: "0",
        approvalIdleSec: "1800",
        return_to: "/ssh",
      },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);

    const list = await page.request.get(`${origin}/api/ssh/hosts`);
    expect(list.status()).toBe(200);
    const payload = (await list.json()) as { hosts: Array<{ id: string; name: string }> };
    const created = payload.hosts.find((entry) => entry.name === name);
    expect(created).toBeDefined();
    if (created !== undefined) {
      const deleted = await page.request.delete(`${origin}/api/ssh/hosts/${created.id}`);
      expect(deleted.status()).toBe(200);
    }
  }

  const content = await page.content();
  expect(content).not.toContain("PRIVATE KEY");
  expect(content).not.toContain(KEY_MARKER);

  await settle(page);
  expectNoPageErrors(errors);
});
