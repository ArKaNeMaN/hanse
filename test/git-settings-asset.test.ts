import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const asset = readFileSync(path.join(process.cwd(), "assets", "git-settings.js"), "utf8");

describe("git settings asset", () => {
  it("submits credential forms as JSON to the git settings route", () => {
    expect(asset).toContain('fetch("/api/settings/git"');
    expect(asset).toContain('"content-type": "application/json"');
    expect(asset).toContain("JSON.stringify(payload)");
    expect(asset).toContain('document.addEventListener("submit"');
    expect(asset).toContain('form.hasAttribute("data-git-auth")');
    expect(asset).toContain('"x-hanse-fragment": "settings"');
    expect(asset).toContain("window.hanseSettings");
    expect(asset).toContain("event.preventDefault()");
    expect(asset).toContain("privateKey:");
    expect(asset).toContain("knownHosts");
    expect(asset).toContain("token:");
  });

  it("disables controls in flight and re-enables them on failure", () => {
    expect(asset).toContain("control.disabled = busy");
    expect(asset).toContain("setBusy(form, true)");
    expect(asset).toContain("setBusy(form, false)");
  });

  it("confirms clears natively before submitting the JSON mutation", () => {
    expect(asset).toContain('action === "clear" && !window.confirm(');
  });

  it("renders errors with textContent and never innerHTML", () => {
    expect(asset).toContain("error.textContent = message");
    expect(asset).not.toContain("innerHTML");
    expect(asset).not.toContain("insertAdjacentHTML");
  });

  it("never places secret values in URLs or data attributes", () => {
    expect(asset).not.toContain("?privateKey");
    expect(asset).not.toContain("?token");
    expect(asset).not.toContain("URLSearchParams");
    expect(asset).not.toContain("data-private");
    expect(asset).not.toContain("data-token");
    expect(asset).not.toContain("data-known");
    expect(asset).not.toContain("data-remote");
    const dataAttributes = [...asset.matchAll(/data-[a-z-]+/g)].map((match) => match[0]);
    expect(new Set(dataAttributes)).toEqual(
      new Set([
        "data-git-auth",
        "data-git-error",
        "data-git-test",
        "data-git-test-result",
        "data-git-test-summary",
        "data-git-test-warnings",
        "data-git-test-error",
      ]),
    );
  });

  it("submits the app-scoped draft to the test endpoint", () => {
    expect(asset).toContain("/git/test");
    expect(asset).toContain("buildTestPayload");
    expect(asset).toContain("testRemote");
    expect(asset).toContain("data-git-test");
    expect(asset).toContain("hasAttribute");
    expect(asset).toContain("submitTest(form)");
    expect(asset).toContain("encodeURIComponent(projectId)");
    expect(asset).toContain("encodeURIComponent(appKey)");
    const start = asset.indexOf("function submitTest");
    const payload = asset.indexOf("const payload = buildTestPayload(form)", start);
    const busy = asset.indexOf("setBusy(form, true)", start);
    expect(payload).toBeGreaterThan(-1);
    expect(busy).toBeGreaterThan(payload);
  });

  it("renders test results and errors with textContent", () => {
    expect(asset).toContain("renderTestResult");
    expect(asset).toContain("renderTestError");
    expect(asset).toContain("summary.textContent");
    expect(asset).toContain("item.textContent = warning");
    expect(asset).toContain("result.error.textContent = message");
    expect(asset).not.toContain("innerHTML");
    expect(asset).not.toContain("insertAdjacentHTML");
  });
});
