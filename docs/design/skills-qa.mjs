#!/usr/bin/env node
/*
 * Browser gate for the managed-skills pages.
 *
 * Usage:
 *   node docs/design/skills-qa.mjs
 *
 * Seeds a throwaway coordinator DB, starts the real HTTP server on an ephemeral
 * port, and captures the global, project, and application Skills pages at 1440
 * and 390 in dark mode. Writes screenshots plus report.json to
 * docs/design/artifacts/skills/ and exits 1 on any failed assertion, console
 * error, or page error.
 *
 * Playwright and Chromium are resolved like docs/design/capture.mjs; no product
 * dependency is added. When the local `tsx` dev dependency is available the
 * script re-executes itself through it to load the TypeScript sources; otherwise
 * it imports the built `dist/` output (run `npm run build` first).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, "artifacts", "skills");
const REPORT = path.join(OUT, "report.json");
const RUNNER = process.env.SKILLS_QA_RUNNER ?? "";

if (RUNNER === "") {
  const tsx = path.resolve(process.cwd(), "node_modules", ".bin", "tsx");
  if (existsSync(tsx)) {
    const result = spawnSync(tsx, [fileURLToPath(import.meta.url)], {
      stdio: "inherit",
      env: { ...process.env, SKILLS_QA_RUNNER: "tsx" },
    });
    process.exit(result.status ?? 1);
  }
}

process.env.LD_LIBRARY_PATH = [path.join(homedir(), ".local", "lib"), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

function findPlaywrightModule() {
  const candidates = [];
  const npxRoot = path.join(homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"));
    }
  }
  candidates.push("/usr/lib/node_modules/gsd-pi/node_modules/playwright/index.mjs");
  candidates.push(path.resolve(process.cwd(), "node_modules", "playwright", "index.mjs"));
  return candidates.find((candidate) => existsSync(candidate));
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) {
    return process.env.PLAYWRIGHT_CHROMIUM;
  }
  const root = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((entry) => entry.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((entry) => path.join(root, entry, "chrome-linux64", "chrome"))
    .find((candidate) => existsSync(candidate));
}

const playwrightPath = findPlaywrightModule();
if (!playwrightPath) {
  console.error(
    "skills-qa: Playwright not found. Install it once with `npx playwright --version`.",
  );
  process.exit(1);
}

const runtimeRoot = RUNNER === "tsx" ? "../../src" : "../../dist";
let modules;
try {
  const [serverModule, coordinatorModule, gitModule, identityModule, skillsModule, storeModule] =
    await Promise.all([
      import(`${runtimeRoot}/http/server.js`),
      import(`${runtimeRoot}/coordinator/service.js`),
      import(`${runtimeRoot}/git/service.js`),
      import(`${runtimeRoot}/identity/principals.js`),
      import(`${runtimeRoot}/skills/index.js`),
      import(`${runtimeRoot}/store/index.js`),
    ]);
  modules = {
    createHttpServer: serverModule.createHttpServer,
    CoordinatorService: coordinatorModule.CoordinatorService,
    GitService: gitModule.GitService,
    createPrincipal: identityModule.createPrincipal,
    SkillService: skillsModule.SkillService,
    openDatabase: storeModule.openDatabase,
    runMigrations: storeModule.runMigrations,
  };
} catch (error) {
  console.error(
    `skills-qa: could not load the coordinator (${String(error)}). Install dev dependencies or run \`npm run build\`.`,
  );
  process.exit(1);
}

const { chromium } = await import(`file://${playwrightPath}`);
mkdirSync(OUT, { recursive: true });

const report = {
  tool: "skills-qa",
  startedAt: new Date().toISOString(),
  status: "PASS",
  assertions: 0,
  screenshots: [],
  routes: [],
  errors: [],
};

function check(condition, message) {
  report.assertions += 1;
  if (!condition) {
    report.status = "FAIL";
    report.errors.push(message);
    throw new Error(message);
  }
}

const temp = mkdtempSync(path.join(tmpdir(), "hanse-skills-qa-"));
const db = modules.openDatabase(path.join(temp, "coordinator.db"));
let server;
let browser;

try {
  modules.runMigrations(db);
  const workspace = path.join(temp, "workspace");
  const projectRoot = path.join(workspace, "p");
  const appRoot = path.join(projectRoot, "apps", "web");
  mkdirSync(appRoot, { recursive: true });
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Project Alpha','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:web','p','web','apps/web','app','AGENTS.md',?)",
  ).run(now);

  const skills = new modules.SkillService({ db });
  skills.create(
    "global",
    {},
    {
      name: "release-checklist",
      description: "Use when preparing a release to verify version, changelog, and rollback.",
      content:
        "# Release checklist\n\n1. Confirm the tree is clean.\n2. Run the full suite.\n3. Record the rollback plan.",
    },
    "qa",
  );
  skills.create(
    "global",
    {},
    {
      name: "triage-bugs",
      description: "Use when triaging an incoming bug report into a reproducible ticket.",
      content: "# Triage\n\nReproduce, isolate, and record the smallest failing case.",
    },
    "qa",
  );
  skills.create(
    "project",
    { projectId: "p" },
    {
      name: "project-notes",
      description: "Project-specific conventions for this repository.",
      content: "# Project notes\n\nKeep changes small and run the project gates.",
    },
    "qa",
  );
  skills.create(
    "project",
    { projectId: "p" },
    {
      name: "triage-bugs",
      description: "Tombstone",
      content: "Tombstone",
      enabled: false,
    },
    "qa",
  );
  skills.create(
    "app",
    { projectId: "p", appKey: "web" },
    {
      name: "app-playbook",
      description: "Application-specific deploy playbook for the web app.",
      content: "# App playbook\n\nBuild, smoke test, and deploy.",
    },
    "qa",
  );

  const human = modules.createPrincipal(db, { kind: "human", name: "qa" });
  const deps = {
    db,
    workspaceRoot: workspace,
    git: new modules.GitService({ workspaceRoot: workspace }),
    skills,
    agentsHome: path.join(temp, "agents"),
    baselinePlugins: [],
    getProjects: () => [
      {
        id: "p",
        name: "Project Alpha",
        rootPath: projectRoot,
        workspaceRoot: workspace,
        service: new modules.CoordinatorService(db, "p"),
      },
    ],
  };

  server = modules.createHttpServer(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  report.baseUrl = base;

  browser = await chromium.launch(
    findChromium() === undefined ? {} : { executablePath: findChromium() },
  );
  const viewports = [
    { name: "1440", width: 1440, height: 900 },
    { name: "390", width: 390, height: 844 },
  ];
  const routes = [
    { slug: "global", url: "/skills", scope: "global" },
    { slug: "project", url: "/projects/p/skills", scope: "project" },
    { slug: "app", url: "/projects/p/apps/web/skills", scope: "app" },
  ];

  for (const viewport of viewports) {
    for (const route of routes) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: "dark",
      });
      await context.addCookies([{ name: "hanse_token", value: human.token, url: base }]);
      await context.addInitScript(() => {
        try {
          localStorage.setItem("hanse-theme", "dark");
        } catch (error) {
          void error;
        }
      });
      const page = await context.newPage();
      const errors = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          errors.push(message.text());
        }
      });
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${base}${route.url}`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);

      check(
        (await page.locator("#skills-surface").count()) === 1,
        `${route.slug}/${viewport.name}: #skills-surface missing`,
      );
      check(
        (await page.locator(".settings-nav").count()) >= 1,
        `${route.slug}/${viewport.name}: scope nav missing`,
      );
      check(
        (await page.locator('[data-dialog-open="skill-new-dialog"]').count()) >= 1,
        `${route.slug}/${viewport.name}: New skill action missing`,
      );
      check(
        (await page.locator(".nav-item.is-active", { hasText: "Skills" }).count()) === 1,
        `${route.slug}/${viewport.name}: Skills nav item is not active`,
      );
      if (route.scope === "global") {
        check(
          (await page.locator('.settings-nav__scopes [aria-current="page"]').count()) === 1,
          `${route.slug}/${viewport.name}: Global scope is not marked`,
        );
      } else {
        check(
          (await page.locator('.settings-nav__scopes a[href="/skills"]').count()) === 1,
          `${route.slug}/${viewport.name}: Global scope link missing`,
        );
      }
      if (route.scope === "app") {
        check(
          (await page.locator('.settings-nav__scopes a[href="/projects/p/skills"]').count()) === 1,
          `${route.slug}/${viewport.name}: Project scope link missing`,
        );
      }
      check(
        errors.length === 0,
        `${route.slug}/${viewport.name}: console/page errors: ${errors.join(" | ")}`,
      );

      const file = path.join(OUT, `skills-${route.slug}-${viewport.name}-dark.png`);
      await page.screenshot({ path: file, fullPage: true });
      report.routes.push({ slug: route.slug, viewport: viewport.name, url: route.url });
      report.screenshots.push(path.relative(process.cwd(), file));
      await context.close();
    }
  }

  async function openDialogScreenshot(viewport, file) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    await context.addCookies([{ name: "hanse_token", value: human.token, url: base }]);
    await context.addInitScript(() => {
      try {
        localStorage.setItem("hanse-theme", "dark");
      } catch (error) {
        void error;
      }
    });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${base}/projects/p/apps/web/skills`, { waitUntil: "networkidle" });
    await page.locator('[data-dialog-open="skill-new-dialog"]').first().click();
    const dialog = page.locator("#skill-new-dialog");
    await dialog.waitFor({ state: "visible" });
    check(await dialog.isVisible(), `dialog/${viewport.name}: new-skill dialog is not visible`);
    await page.waitForTimeout(150);
    await page.screenshot({ path: file, fullPage: false });
    check(
      errors.length === 0,
      `dialog/${viewport.name}: console/page errors: ${errors.join(" | ")}`,
    );
    report.screenshots.push(path.relative(process.cwd(), file));
    await context.close();
  }

  await openDialogScreenshot(
    { name: "1440", width: 1440, height: 900 },
    path.join(OUT, "skills-dialog-1440-dark.png"),
  );
  await openDialogScreenshot(
    { name: "390", width: 390, height: 844 },
    path.join(OUT, "skills-dialog-390-dark.png"),
  );

  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    await context.addCookies([{ name: "hanse_token", value: human.token, url: base }]);
    await context.addInitScript(() => {
      try {
        localStorage.setItem("hanse-theme", "dark");
      } catch (error) {
        void error;
      }
    });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${base}/projects/p/apps/web/skills`, { waitUntil: "networkidle" });

    await page.locator('[data-dialog-open="skill-new-dialog"]').first().click();
    await page.locator("#skill-new-dialog").waitFor({ state: "visible" });
    await page.fill("#skill-new-name", "qa-created");
    await page.fill("#skill-new-description", "Use when QA verifies the in-place skill save path.");
    await page.fill("#skill-new-content", "# QA created\n\nCreated through the dialog.");
    await page.locator('#skill-new-dialog button[type="submit"]').click();
    await page
      .locator('#skills-surface [data-skill-name="qa-created"]')
      .first()
      .waitFor({ state: "attached" });
    check(
      (await page.locator("#skill-new-dialog").isVisible()) === false,
      "create: dialog did not close after a fragment save",
    );
    check(
      (await page.locator("#toast-region .toast").count()) >= 1,
      "create: success toast missing after a fragment save",
    );
    const created = skills.resolve({ projectId: "p", appKey: "web" });
    check(
      created.rows.some((row) => row.name === "qa-created" && row.enabled),
      "create: skill was not persisted",
    );

    const row = page.locator('#skills-defined details.setting-row[data-skill-name="qa-created"]');
    await page
      .locator('#skills-effective [data-skill-name="qa-created"]')
      .getByRole("link", { name: "Edit here" })
      .click();
    check(
      await row.evaluate((element) => element instanceof HTMLDetailsElement && element.open),
      "editor: Edit here did not open the defined row",
    );
    await page.waitForTimeout(150);
    const editorFile = path.join(OUT, "skills-editor-1440-dark.png");
    await page.screenshot({ path: editorFile, fullPage: true });
    report.screenshots.push(path.relative(process.cwd(), editorFile));

    await row.locator('button[type="submit"]', { hasText: "Disable here" }).click();
    await page
      .locator('#skills-surface [data-skill-name="qa-created"] .badge-warning')
      .first()
      .waitFor({ state: "visible" });
    const disabled = skills.resolve({ projectId: "p", appKey: "web" });
    check(
      disabled.rows.some((entry) => entry.name === "qa-created" && !entry.enabled),
      "toggle: disable did not persist",
    );

    await row.locator("[data-skill-delete]").click();
    const deleteDialog = page.locator("#skill-delete-dialog");
    await deleteDialog.waitFor({ state: "visible" });
    await deleteDialog.locator('button[type="submit"]').click();
    await page
      .locator('#skills-defined details.setting-row[data-skill-name="qa-created"]')
      .waitFor({ state: "detached" });
    const deleted = skills.resolve({ projectId: "p", appKey: "web" });
    check(
      !deleted.rows.some((entry) => entry.name === "qa-created"),
      "delete: skill was not removed",
    );
    check(errors.length === 0, `interaction: console/page errors: ${errors.join(" | ")}`);
    await context.close();
  }

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "FAIL";
  report.errors.push(String(error));
  console.error(String(error));
  process.exitCode = 1;
} finally {
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (browser !== undefined) {
    await browser.close();
  }
  if (server !== undefined) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  db.close();
  rmSync(temp, { recursive: true, force: true });
}
