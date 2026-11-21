import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("bundled Mermaid licenses", () => {
  it("lists the full bundled tree in components.md", () => {
    const components = readFileSync(path.join(root, "licenses", "components.md"), "utf8");
    for (const name of [
      "mermaid",
      "js-yaml",
      "fastdom",
      "langium",
      "elkjs",
      "chevrotain",
      "dompurify",
      "d3-sankey",
      "katex",
    ]) {
      expect(components).toContain(`| ${name} |`);
    }
    expect(components).toContain("| sourcemap+override |");
    expect(components).toContain("| bundle-override |");
  });

  it("links the generated licenses from the shipped notices", () => {
    const notices = readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("licenses/components.md");
    expect(notices).toContain("licenses/packages/");
    expect(notices).toContain("Mermaid 12.3.0");
  });
});
