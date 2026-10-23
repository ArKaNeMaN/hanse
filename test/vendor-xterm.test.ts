import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, handleRequest } from "../src/http/handler.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureDeps(): HttpDeps {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-vendor-xterm-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  return {
    db,
    workspaceRoot: dir,
    git: new GitService({ workspaceRoot: dir }),
    getProjects: () => [],
  };
}

describe("vendored xterm", () => {
  it("records the expected versions, sizes, and checksums", () => {
    const vendorDir = path.join(process.cwd(), "assets", "vendor", "xterm");

    expect(readFileSync(path.join(vendorDir, "VERSION"), "utf8").trim()).toBe(
      [
        "xterm.js 6.0.0",
        "@xterm/addon-fit 0.11.0",
        "@xterm/addon-unicode11 0.9.0",
        "@xterm/addon-unicode-graphemes 0.4.0",
      ].join("\n"),
    );

    const files = [
      "xterm-6.0.0.js",
      "xterm-6.0.0.css",
      "addon-fit-0.11.0.js",
      "addon-unicode11-0.9.0.js",
      "addon-unicode-graphemes-0.4.0.js",
    ];
    for (const file of files) {
      expect(statSync(path.join(vendorDir, file)).size).toBeGreaterThan(0);
    }
    expect(statSync(path.join(vendorDir, "xterm-6.0.0.js")).size).toBeLessThanOrEqual(512 * 1024);
    expect(statSync(path.join(vendorDir, "xterm-6.0.0.css")).size).toBeLessThanOrEqual(12 * 1024);
    expect(statSync(path.join(vendorDir, "addon-fit-0.11.0.js")).size).toBeLessThanOrEqual(
      8 * 1024,
    );
    expect(statSync(path.join(vendorDir, "addon-unicode11-0.9.0.js")).size).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(
      statSync(path.join(vendorDir, "addon-unicode-graphemes-0.4.0.js")).size,
    ).toBeLessThanOrEqual(64 * 1024);

    const sums = readFileSync(path.join(vendorDir, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/));
    expect(sums.map((entry) => entry[1])).toEqual(files);
    for (const [hash, file] of sums) {
      const actual = createHash("sha256")
        .update(readFileSync(path.join(vendorDir, file ?? "")))
        .digest("hex");
      expect(actual).toBe(hash);
    }
  });

  it("ships all addon licences", () => {
    const vendorDir = path.join(process.cwd(), "assets", "vendor", "xterm");
    for (const file of [
      "LICENSE",
      "LICENSE.addon-fit",
      "LICENSE.addon-unicode11",
      "LICENSE.addon-unicode-graphemes",
    ]) {
      expect(readFileSync(path.join(vendorDir, file), "utf8")).toContain("MIT");
    }
  });

  it("activates the vendored unicode providers", () => {
    const terminalJs = readFileSync(path.join(process.cwd(), "assets", "terminal.js"), "utf8");
    expect(terminalJs).toContain("allowProposedApi: true");
    expect(terminalJs).toContain("Unicode11Addon");
    expect(terminalJs).toContain("UnicodeGraphemesAddon");
    expect(terminalJs).toContain('activeVersion = "11"');
    expect(terminalJs).toContain('activeVersion = "15-graphemes"');
  });

  it("serves the allowlisted assets and rejects sibling vendor paths", () => {
    const deps = fixtureDeps();
    const assets = [
      {
        path: "/assets/vendor/xterm/xterm-6.0.0.css",
        contentType: "text/css; charset=utf-8",
        marker: ".xterm",
      },
      {
        path: "/assets/vendor/xterm/xterm-6.0.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "Terminal",
      },
      {
        path: "/assets/vendor/xterm/addon-fit-0.11.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "FitAddon",
      },
      {
        path: "/assets/vendor/xterm/addon-unicode11-0.9.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "Unicode11Addon",
      },
      {
        path: "/assets/vendor/xterm/addon-unicode-graphemes-0.4.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "UnicodeGraphemesAddon",
      },
    ];
    for (const asset of assets) {
      const response = handleRequest(deps, {
        method: "GET",
        path: asset.path,
        headers: {},
      });
      expect(response.status).toBe(200);
      expect(response.contentType).toBe(asset.contentType);
      expect(response.body).toContain(asset.marker);
    }

    const missing = handleRequest(deps, {
      method: "GET",
      path: "/assets/vendor/xterm/README.md",
      headers: {},
    });
    expect(missing.status).toBe(404);
  });
});
