import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  devModuleUrls,
  loadUiManifest,
  renderSpaDocument,
  serializeBoot,
  uiDevUrl,
} from "../src/http/spa.js";

const dirs: string[] = [];

afterEach(() => {
  delete process.env.HANSE_UI_DEV_URL;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function uiFixture(manifest: unknown, files: string[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-ui-manifest-"));
  dirs.push(root);
  const uiDir = path.join(root, "ui");
  mkdirSync(path.join(uiDir, ".vite"), { recursive: true });
  writeFileSync(path.join(uiDir, ".vite", "manifest.json"), JSON.stringify(manifest), "utf8");
  for (const file of files) {
    const target = path.join(uiDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "fixture", "utf8");
  }
  return root;
}

function logger() {
  return { warn: vi.fn() };
}

describe("UI manifest loader", () => {
  it("loads a complete entry and prefixes the UI base", () => {
    const root = uiFixture(
      {
        "main.ts": {
          file: "assets/main-abc.js",
          src: "main.ts",
          isEntry: true,
          css: ["assets/main-abc.css"],
        },
      },
      ["assets/main-abc.js", "assets/main-abc.css"],
    );
    const manifest = loadUiManifest({ assetsRoot: root });
    expect(manifest).toEqual({
      entry: "/assets/ui/assets/main-abc.js",
      css: ["/assets/ui/assets/main-abc.css"],
      files: ["/assets/ui/assets/main-abc.js", "/assets/ui/assets/main-abc.css"],
    });
  });

  it("falls back with ui.manifest_invalid when the manifest is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hanse-ui-missing-"));
    dirs.push(root);
    const log = logger();
    expect(loadUiManifest({ assetsRoot: root, logger: log })).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("ui.manifest_invalid", { reason: "missing" });
  });

  it("falls back on invalid JSON and non-object manifests", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hanse-ui-invalid-"));
    dirs.push(root);
    mkdirSync(path.join(root, "ui", ".vite"), { recursive: true });
    writeFileSync(path.join(root, "ui", ".vite", "manifest.json"), "{", "utf8");
    const log = logger();
    expect(loadUiManifest({ assetsRoot: root, logger: log })).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("ui.manifest_invalid", { reason: "invalid_json" });
  });

  it("falls back when the entry or a declared file is missing", () => {
    const noEntry = uiFixture({ "main.ts": { file: "assets/main.js", isEntry: false } });
    expect(loadUiManifest({ assetsRoot: noEntry })).toBeUndefined();

    const missingFile = uiFixture({
      "main.ts": { file: "assets/main.js", src: "main.ts", isEntry: true },
    });
    expect(loadUiManifest({ assetsRoot: missingFile })).toBeUndefined();

    const missingCss = uiFixture(
      {
        "main.ts": {
          file: "assets/main.js",
          src: "main.ts",
          isEntry: true,
          css: ["assets/main.css"],
        },
      },
      ["assets/main.js"],
    );
    expect(loadUiManifest({ assetsRoot: missingCss })).toBeUndefined();
  });

  it("rejects traversal and absolute paths", () => {
    const traversal = uiFixture(
      { "main.ts": { file: "../escape.js", src: "main.ts", isEntry: true } },
      ["../escape.js"],
    );
    expect(loadUiManifest({ assetsRoot: traversal })).toBeUndefined();

    const absolute = uiFixture({
      "main.ts": { file: "/etc/passwd", src: "main.ts", isEntry: true },
    });
    expect(loadUiManifest({ assetsRoot: absolute })).toBeUndefined();
  });
});

describe("UI boot and dev URLs", () => {
  it("normalizes HANSE_UI_DEV_URL and emits the Vite client and entry", () => {
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173/";
    expect(uiDevUrl()).toBe("http://127.0.0.1:5173");
    expect(devModuleUrls("http://127.0.0.1:5173/")).toEqual([
      "http://127.0.0.1:5173/assets/ui/@vite/client",
      "http://127.0.0.1:5173/assets/ui/main.ts",
    ]);
    delete process.env.HANSE_UI_DEV_URL;
    expect(uiDevUrl()).toBeUndefined();
  });

  it("escapes < in the boot JSON so it cannot close the script element", () => {
    expect(serializeBoot({ summary: "</script><script>alert(1)</script>" })).toBe(
      '{"summary":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}',
    );
    expect(serializeBoot(undefined)).toBe("null");
  });

  it("renders the SPA document with the shell script only, boot JSON, and fallback", () => {
    const html = renderSpaDocument({
      title: "Projects",
      active: "projects",
      breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Projects" }],
      projects: [{ id: "alpha", name: "Alpha", appCount: 1 }],
      pendingCount: 0,
      operatorName: "alice",
      route: { id: "projects", params: {} },
      props: { rows: [{ name: "<unsafe>" }] },
      chrome: {
        sidebarNav: "",
        breadcrumb: "",
        title: "Projects",
        active: "projects",
        pendingCount: 0,
        sshPendingCount: 0,
      },
      manifest: {
        entry: "/assets/ui/assets/main.js",
        css: ["/assets/ui/assets/main.css"],
        files: [],
      },
    });
    expect(html).toContain('<script src="/assets/app.js" defer></script>');
    expect(html).not.toContain("/assets/app-content.js");
    expect(html).toContain('<script id="hanse-boot" type="application/json">');
    expect(html).toContain("\\u003cunsafe>");
    expect(html).toContain('id="ui-fallback"');
    expect(html).toContain('<script type="module" src="/assets/ui/assets/main.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/assets/ui/assets/main.css" />');
    expect(html).toContain('id="route-announcer"');
    expect(html).toContain('id="sidebar-nav"');
    expect(html).toContain('id="breadcrumb-host"');
  });

  it("prefers dev module URLs over the manifest entry", () => {
    const html = renderSpaDocument({
      title: "Projects",
      active: "projects",
      breadcrumb: [{ label: "Projects" }],
      projects: [],
      pendingCount: 0,
      operatorName: "alice",
      route: { id: "projects", params: {} },
      props: {},
      chrome: {
        sidebarNav: "",
        breadcrumb: "",
        title: "Projects",
        active: "projects",
        pendingCount: 0,
        sshPendingCount: 0,
      },
      devUrl: "http://127.0.0.1:5173",
    });
    expect(html).toContain(
      '<script type="module" src="http://127.0.0.1:5173/assets/ui/@vite/client"></script>',
    );
    expect(html).toContain(
      '<script type="module" src="http://127.0.0.1:5173/assets/ui/main.ts"></script>',
    );
  });
});
