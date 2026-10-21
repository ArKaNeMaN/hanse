import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderApplication } from "../src/http/application.js";
import type { SiteModel } from "../src/http/dashboard.js";
import type { RegisteredApp } from "../src/registry/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("application SSH panel", () => {
  it("shows allowed hosts, pending approvals, and a manage link in the rail", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hanse-app-ssh-"));
    dirs.push(root);
    mkdirSync(path.join(root, "a"));
    const app = {
      id: "p:a",
      projectId: "p",
      appKey: "a",
      path: "a",
      kind: "web",
      contract: "AGENTS.md",
      imageStatus: "missing",
      imageRef: null,
      imageHash: null,
      imageBaseDigest: null,
      imageBuiltAt: null,
      imageError: null,
    } as RegisteredApp;
    const site: SiteModel = {
      projects: [
        {
          id: "p",
          name: "P",
          rootPath: root,
          workspaceRoot: root,
          baseBranch: "main",
          createdAt: "",
          apps: [app],
          handoffs: [],
        },
      ],
      apps: new Map([
        [
          "p:a",
          {
            id: "p:a",
            appKey: "a",
            path: "a",
            kind: "web",
            projectId: "p",
            projectName: "P",
            projectRoot: root,
          },
        ],
      ]),
      runtime: new Map(),
      pendingRestart: new Map(),
      pendingRestartReasons: new Map(),
      pendingCount: 0,
      sshPendingCount: 2,
      sshPendingByApp: new Map([["p:a", 2]]),
      sshHostsByApp: new Map([["p:a", 1]]),
      startingCount: 0,
      runningCount: 0,
      errorCount: 0,
      stoppedCount: 1,
      appCount: 1,
      handoffCount: 0,
    };
    const page = renderApplication(site, "p", "a", { operatorName: "op" });
    expect(page).toBeDefined();
    const html = page ?? "";
    expect(html).toContain('class="rail-stack"');
    expect(html).toContain('id="ssh-panel"');
    expect(html).toContain('id="ssh-panel-title">SSH access</h2>');
    expect(html).toContain("1 allowed host");
    expect(html).toContain("2 pending approvals");
    expect(html).toContain('data-state="awaiting_approval"');
    expect(html).toContain("/ssh?project=p&amp;app=a");
    expect(html.indexOf('id="git-panel"')).toBeLessThan(html.indexOf('id="ssh-panel"'));
    expect(html.indexOf('class="rail-stack"')).toBeLessThan(html.indexOf('id="ssh-panel"'));
    expect(html.indexOf('id="image-panel"')).toBeLessThan(html.indexOf('id="ssh-panel"'));
  });

  it("renders the no-pending state without a status stamp", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hanse-app-ssh-"));
    dirs.push(root);
    mkdirSync(path.join(root, "a"));
    const app = {
      id: "p:a",
      projectId: "p",
      appKey: "a",
      path: "a",
      kind: "web",
      contract: "AGENTS.md",
      imageStatus: "missing",
      imageRef: null,
      imageHash: null,
      imageBaseDigest: null,
      imageBuiltAt: null,
      imageError: null,
    } as RegisteredApp;
    const site: SiteModel = {
      projects: [
        {
          id: "p",
          name: "P",
          rootPath: root,
          workspaceRoot: root,
          baseBranch: "main",
          createdAt: "",
          apps: [app],
          handoffs: [],
        },
      ],
      apps: new Map(),
      runtime: new Map(),
      pendingRestart: new Map(),
      pendingRestartReasons: new Map(),
      pendingCount: 0,
      sshPendingCount: 0,
      sshPendingByApp: new Map(),
      sshHostsByApp: new Map([["p:a", 3]]),
      startingCount: 0,
      runningCount: 0,
      errorCount: 0,
      stoppedCount: 1,
      appCount: 1,
      handoffCount: 0,
    };
    const page = renderApplication(site, "p", "a", { operatorName: "op" }) ?? "";
    expect(page).toContain("3 allowed hosts");
    expect(page).toContain("No pending approvals.");
    expect(page).not.toContain('data-state="awaiting_approval"');
  });
});
