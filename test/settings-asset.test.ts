import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const asset = readFileSync(path.join(process.cwd(), "assets", "settings.js"), "utf8");

describe("settings asset", () => {
  it("requests fragment responses instead of navigating after a successful save", () => {
    expect(asset).toContain('"x-hanse-fragment": "settings"');
    expect(asset).toContain("applySections");
    expect(asset).toContain("window.hanseSettings");
    expect(asset).toContain("history.replaceState");
    expect(asset).toContain("data.changed");
    expect(asset).toContain("settings-warnings");
    expect(asset).toContain("beginSave");
    expect(asset).toContain('document.querySelector(".page")');
  });

  it("delegates forms so swapped sections keep working", () => {
    expect(asset).toContain('document.addEventListener("submit"');
    expect(asset).toContain('document.addEventListener("change"');
    expect(asset).toContain("data-settings-driver");
    expect(asset).toContain("settings-clear-form");
  });

  it("maps the Context section for fragment swaps", () => {
    expect(asset).toContain('context: "settings-context"');
    expect(asset).toContain('"x-hanse-fragment": "settings"');
    expect(asset).toContain("replaceSection");
    expect(asset).toContain("SECTION_IDS[name]");
  });

  it("preserves open rows and drafts around the swap", () => {
    expect(asset).toContain("openRowIds");
    expect(asset).toContain("captureDrafts");
    expect(asset).toContain("restoreDrafts");
    expect(asset).toContain("preventScroll");
  });

  it("confirms provider deletion before a fragment save", () => {
    expect(asset).toContain('hasAttribute("data-confirm")');
    expect(asset).toContain("window.confirm");
  });
});
