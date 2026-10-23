#!/usr/bin/env node
/*
 * Browser gate for the managed-skill bundles and workspace.
 *
 * Usage:
 *   node docs/design/skills-qa.mjs
 *
 * The harness is self-contained: it starts a throwaway coordinator fixture
 * (`docs/design/skills-qa-server.mts`) with the repository's local tsx, seeds a
 * temporary SQLite database and workspace, then drives the real HTTP UI with
 * Playwright. Screenshots and `report.json` land in
 * docs/design/artifacts/skills/. It exits 1 on a failed assertion, a missing
 * screenshot, an unexpected console error, or a page error.
 *
 * Playwright and Chromium are resolved exactly like docs/design/capture.mjs, so
 * no product dependency is added. Set PLAYWRIGHT_CHROMIUM to override the
 * browser binary.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const OUT = path.join(SCRIPT_DIR, "artifacts", "skills");
const REPORT = path.join(OUT, "report.json");
const SERVER = path.join(SCRIPT_DIR, "skills-qa-server.mts");
const EXPECTED_STATUS = /status of (400|409|422)\b/;

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
  candidates.push(path.join(homedir(), ".local", "lib", "node_modules", "playwright", "index.mjs"));
  candidates.push("/usr/lib/node_modules/gsd-pi/node_modules/playwright/index.mjs");
  candidates.push(path.join(ROOT, "node_modules", "playwright", "index.mjs"));
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
if (playwrightPath === undefined) {
  console.error("skills-qa: Playwright not found. Run `npx playwright --version` once.");
  process.exit(1);
}
const { chromium } = await import(`file://${playwrightPath}`);

mkdirSync(OUT, { recursive: true });
for (const entry of readdirSync(OUT)) {
  if (entry.endsWith(".png")) {
    rmSync(path.join(OUT, entry), { force: true });
  }
}

const report = {
  tool: "skills-qa",
  startedAt: new Date().toISOString(),
  status: "PASS",
  assertions: { total: 0, passed: 0, failed: 0 },
  scenarios: [],
  screenshots: [],
  consoleErrors: [],
  errors: [],
};

function check(condition, message) {
  report.assertions.total += 1;
  if (condition) {
    report.assertions.passed += 1;
    return true;
  }
  report.assertions.failed += 1;
  report.status = "FAIL";
  report.errors.push(message);
  throw new Error(message);
}

async function scenario(name, run) {
  const entry = { name, status: "RUNNING", assertions: 0 };
  report.scenarios.push(entry);
  const before = report.assertions.total;
  try {
    await run();
    entry.status = "PASS";
  } catch (error) {
    entry.status = "FAIL";
    entry.error = String(error);
    throw error;
  } finally {
    entry.assertions = report.assertions.total - before;
  }
}

const temp = mkdtempSync(path.join(tmpdir(), "hanse-skills-qa-run-"));

function startServer() {
  return new Promise((resolve, reject) => {
    const localTsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const useLocal = existsSync(localTsx);
    const command = useLocal ? localTsx : "npx";
    const args = useLocal ? [SERVER] : ["--yes", "tsx", SERVER];
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, SKILLS_QA_TEMP: temp, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`skills-qa: fixture server timed out\n${output}`));
    }, 60_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /^READY (.*)$/m.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        try {
          resolve({ child, ...JSON.parse(match[1]) });
        } catch (error) {
          reject(error);
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`skills-qa: fixture server exited ${code}\n${output}`));
    });
  });
}

async function stopServer(child) {
  if (child === null || child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 6000))]);
  clearTimeout(timer);
}

let serverChild = null;
let browser = null;

try {
  const fixture = await startServer();
  serverChild = fixture.child;
  const base = `http://127.0.0.1:${fixture.port}`;
  const ids = fixture.ids;
  report.fixture = {
    project: "p1",
    application: "web",
    baseUrl: base,
    seeded: ["global", "project", "app"],
    synthetic: true,
  };

  browser = await chromium.launch(
    findChromium() === undefined ? {} : { executablePath: findChromium() },
  );

  async function newContext({ width, height, theme = "dark", javaScriptEnabled = true }) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: theme,
      javaScriptEnabled,
    });
    await context.addCookies([{ name: "hanse_token", value: fixture.token, url: base }]);
    await context.addInitScript((value) => {
      try {
        localStorage.setItem("hanse-theme", value);
      } catch {
        // Storage can be disabled; the system colour scheme still applies.
      }
    }, theme);
    return context;
  }

  function track(page, expectedStatuses) {
    const errors = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      const expected = expectedStatuses.some((pattern) => pattern.test(text));
      if (expected) {
        report.consoleErrors.push({ expected: true, text });
        return;
      }
      errors.push(`console: ${text}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    return errors;
  }

  async function open(context, pathname, options = {}) {
    const page = await context.newPage();
    const errors = track(page, options.expectedStatuses ?? []);
    await page.goto(base + pathname, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready).catch(() => undefined);
    await page.waitForTimeout(120);
    return { page, errors };
  }

  async function assertClean(errors, label) {
    check(errors.length === 0, `${label}: ${errors.join(" | ")}`);
  }

  async function shot(page, name, fullPage = true) {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file, fullPage });
    check(existsSync(file) && statSync(file).size > 0, `screenshot ${name}: missing or empty`);
    report.screenshots.push(path.relative(ROOT, file));
  }

  async function assertNoOverflow(page, label) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check(overflow <= 1, `${label}: horizontal page overflow ${overflow}px`);
  }

  async function textOf(page, selector) {
    const value = await page
      .locator(selector)
      .first()
      .textContent()
      .catch(() => null);
    return value?.trim() ?? "";
  }

  async function rowState(page, name, state, label, context) {
    const row = page.locator(`[data-skill-inventory] tr[data-skill-name="${name}"]`);
    check((await row.count()) === 1, `${context}: row ${name} is missing`);
    check(
      (await row.getAttribute("data-skill-state")) === state,
      `${context}: ${name} state is ${await row.getAttribute("data-skill-state")}, expected ${state}`,
    );
    if (label !== undefined) {
      check(
        (await row.getAttribute("data-skill-state-label")) === label,
        `${context}: ${name} label is ${await row.getAttribute("data-skill-state-label")}, expected ${label}`,
      );
    }
  }

  async function submitJsonUpdate(page, id) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (entry) => entry.url().includes(`/api/skills/${id}`) && entry.request().method() === "POST",
      ),
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.locator("[data-skill-save]").click(),
    ]);
    check(response.status() === 200, `save: HTTP ${response.status()} for skill ${id}`);
    await page.waitForTimeout(100);
  }

  async function submitJsonCreate(page) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (entry) => entry.url().endsWith("/api/skills") && entry.request().method() === "POST",
      ),
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.locator("[data-skill-save]").click(),
    ]);
    check(response.status() === 200, `create: HTTP ${response.status()}`);
    await page.waitForTimeout(100);
  }

  async function submitNative(page, clickLocator) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (entry) => entry.request().method() === "POST" && entry.url().includes("/api/skills"),
      ),
      page.waitForNavigation({ waitUntil: "networkidle" }),
      clickLocator.click(),
    ]);
    await page.waitForTimeout(100);
    return response;
  }

  function addReference(page, referencePath, content) {
    return (async () => {
      await page.locator("[data-skill-add-reference]").first().click();
      await page.waitForTimeout(80);
      await page.locator("[data-skill-reference-path]").last().fill(referencePath);
      await page.locator("[data-skill-reference-content]").last().fill(content);
      await page.waitForTimeout(150);
    })();
  }

  function referencePane(page, referencePath) {
    return page.locator(
      `[data-skill-file][data-skill-file-kind="reference"][data-skill-file-path="${referencePath}"]`,
    );
  }

  await scenario("renderer-fixture", async () => {
    const context = await newContext({ width: 1024, height: 768, theme: "dark" });
    const { page, errors } = await open(context, "/");
    const rendered = await page.evaluate(async () => {
      const { element, renderMarkdown } = await import("/assets/markdown.js");
      const container = document.createElement("div");
      container.id = "qa-preview";
      container.className = "message__body";
      document.body.append(container);
      const render = (text) => {
        const target = document.createElement("div");
        container.append(target);
        renderMarkdown(target, text);
        return target;
      };
      const raw = render(
        '<script>window.__qaXss = 1</script>\n\n<img src="probe" onerror="window.__qaXss = 2">',
      );
      const dangerous = render("[click](javascript:window.__qaXss=3)");
      const quote = render("> quoted line\n> second line");
      const table = render("| Name | Value |\n| :--- | ---: |\n| alpha | 1 |\n| beta | 2 |");
      const fence = render("```js\nconst value = 1 < 2;\n```");
      const reference = render("See [the docs](https://example.test/a?b=1).");
      const helper = element("span", "qa-helper", "helper text");
      return {
        elementType: typeof element,
        renderType: typeof renderMarkdown,
        hasScript: raw.querySelector("script") !== null,
        hasImage: raw.querySelector("img") !== null,
        rawText: raw.textContent,
        xss: window.__qaXss ?? 0,
        dangerousLinks: dangerous.querySelectorAll("a").length,
        dangerousText: dangerous.textContent,
        quoteText: quote.querySelector("blockquote")?.textContent ?? null,
        quoteBreaks: quote.querySelectorAll("blockquote br").length,
        tables: table.querySelectorAll("table.message__table").length,
        headers: Array.from(table.querySelectorAll("th")).map((cell) => cell.textContent),
        aligns: Array.from(table.querySelectorAll("th")).map((cell) => cell.dataset.align),
        rows: Array.from(table.querySelectorAll("tbody tr")).map((row) => row.textContent),
        code: fence.querySelector("pre > code")?.textContent ?? null,
        language: fence.querySelector("pre > code")?.dataset.language ?? null,
        linkHref: reference.querySelector("a")?.getAttribute("href") ?? null,
        linkTarget: reference.querySelector("a")?.getAttribute("target") ?? null,
        linkRel: reference.querySelector("a")?.getAttribute("rel") ?? null,
        linkText: reference.querySelector("a")?.textContent ?? null,
        helperTag: helper.tagName,
        helperClass: helper.className,
        helperText: helper.textContent,
      };
    });
    check(rendered.elementType === "function", "renderer: element is not exported");
    check(rendered.renderType === "function", "renderer: renderMarkdown is not exported");
    check(!rendered.hasScript, "renderer: raw <script> became an element");
    check(!rendered.hasImage, "renderer: raw <img> became an element");
    check(
      rendered.rawText.includes("<script>") && rendered.rawText.includes("<img"),
      "renderer: raw HTML was not preserved as text",
    );
    check(rendered.xss === 0, "renderer: raw HTML executed script");
    check(rendered.dangerousLinks === 0, "renderer: javascript: link became an anchor");
    check(
      rendered.dangerousText.includes("[click](javascript:"),
      "renderer: javascript: link text changed",
    );
    check(rendered.quoteText === "quoted linesecond line", "renderer: blockquote text is wrong");
    check(rendered.quoteBreaks === 1, "renderer: blockquote line break is missing");
    check(rendered.tables === 1, "renderer: table was not rendered");
    check(rendered.headers.join("|") === "Name|Value", "renderer: table headers are wrong");
    check(rendered.aligns.join("|") === "left|right", "renderer: table alignment is wrong");
    check(rendered.rows.join("|") === "alpha1|beta2", "renderer: table rows are wrong");
    check(rendered.code === "const value = 1 < 2;", "renderer: code fence text is wrong");
    check(rendered.language === "js", "renderer: code fence language is wrong");
    check(rendered.linkHref === "https://example.test/a?b=1", "renderer: link href is wrong");
    check(rendered.linkTarget === "_blank", "renderer: link target is wrong");
    check(rendered.linkRel === "noreferrer noopener", "renderer: link rel is wrong");
    check(rendered.linkText === "the docs", "renderer: link text is wrong");
    check(rendered.helperTag === "SPAN", "renderer: element tag is wrong");
    check(rendered.helperClass === "qa-helper", "renderer: element class is wrong");
    check(rendered.helperText === "helper text", "renderer: element text is wrong");
    await shot(page, "renderer-1024-dark.png");
    await assertClean(errors, "renderer-fixture");
    await context.close();
  });

  await scenario("inventory", async () => {
    const scopes = [
      {
        slug: "global",
        pathname: "/skills",
        rows: [
          { name: "release-checklist", state: "enabled", label: "Enabled here" },
          { name: "repair-me", state: "invalid", label: "Invalid here" },
          { name: "shared-rules", state: "enabled", label: "Enabled here" },
        ],
      },
      {
        slug: "project",
        pathname: "/projects/p1/skills",
        rows: [
          { name: "project-notes", state: "enabled", label: "Enabled here" },
          { name: "triage-bugs", state: "disabled", label: "Disabled here" },
          { name: "release-checklist", state: "inherited", label: "Inherited" },
        ],
      },
      {
        slug: "app",
        pathname: "/projects/p1/apps/web/skills",
        rows: [
          { name: "app-playbook", state: "enabled", label: "Enabled here" },
          { name: "shared-rules", state: "invalid", label: "Invalid local override" },
          { name: "app-broken", state: "invalid", label: "Invalid here" },
          { name: "release-checklist", state: "inherited", label: "Inherited" },
        ],
      },
    ];
    for (const theme of ["dark", "light"]) {
      for (const viewport of [
        { name: "1440", width: 1440, height: 900 },
        { name: "390", width: 390, height: 844 },
      ]) {
        const context = await newContext({ ...viewport, theme });
        for (const scope of scopes) {
          const label = `inventory/${scope.slug}/${viewport.name}/${theme}`;
          const { page, errors } = await open(context, scope.pathname);
          check(
            (await page.locator("[data-skill-inventory]").count()) === 1,
            `${label}: inventory table is missing`,
          );
          check(
            (await page.locator(".nav-item.is-active").filter({ hasText: "Skills" }).count()) === 1,
            `${label}: Skills nav item is not active`,
          );
          check(
            (await page.getByRole("link", { name: "New skill" }).count()) >= 1,
            `${label}: New skill action is missing`,
          );
          check(
            (await page.locator('.settings-nav__scopes [aria-current="page"]').count()) === 1,
            `${label}: current scope is not marked`,
          );
          for (const row of scope.rows) {
            await rowState(page, row.name, row.state, row.label, label);
          }
          if (scope.slug === "app") {
            check(
              (await page
                .locator('[data-skill-name="shared-rules"] [data-skill-effective-link]')
                .count()) === 1,
              `${label}: Invalid local override does not link the effective source`,
            );
            check(
              (await page
                .locator('[data-skill-name="app-broken"] [data-skill-effective-link]')
                .count()) === 0,
              `${label}: Invalid here should not link an effective source`,
            );
          }
          await assertNoOverflow(page, label);
          await shot(page, `inventory-${scope.slug}-${viewport.name}-${theme}.png`);
          await assertClean(errors, label);
        }
        await context.close();
      }
    }
  });

  await scenario("workspace-layout", async () => {
    const viewports = [
      { name: "1440", width: 1440, height: 900 },
      { name: "1024", width: 1024, height: 900 },
      { name: "768", width: 768, height: 1000 },
      { name: "390", width: 390, height: 844 },
    ];
    for (const theme of ["dark", "light"]) {
      for (const viewport of viewports) {
        const label = `workspace/${viewport.name}/${theme}`;
        const context = await newContext({ ...viewport, theme });
        const { page, errors } = await open(context, `/skills/${ids.release}`);
        check(
          (await page.locator('[data-skill-workspace][data-skill-enhanced="true"]').count()) === 1,
          `${label}: workspace did not enhance`,
        );
        check(
          (await page.locator("[data-skill-file-list]").count()) === 1,
          `${label}: file rail is missing`,
        );
        check(await page.locator("#skill-content").isVisible(), `${label}: source editor hidden`);
        const tabs = page.locator("[data-skill-file-tabs]");
        const picker = page.locator("[data-skill-file-picker]");
        const viewTabs = page.locator("[data-skill-viewtabs]");
        if (viewport.width >= 1024) {
          check(await tabs.isVisible(), `${label}: file tabs hidden on desktop`);
          check(!(await picker.isVisible()), `${label}: file picker visible on desktop`);
          check(!(await viewTabs.isVisible()), `${label}: Source/Preview tabs visible on desktop`);
        } else {
          check(!(await tabs.isVisible()), `${label}: file tabs visible on narrow layout`);
          check(await picker.isVisible(), `${label}: file picker hidden on narrow layout`);
          check(await viewTabs.isVisible(), `${label}: Source/Preview tabs hidden`);
        }
        if (viewport.width >= 1024) {
          const sourceBox = await page.locator("#skill-file-skill").boundingBox();
          const previewBox = await page.locator("#skill-preview-pane").boundingBox();
          const tabsBox = await tabs.boundingBox();
          check(
            sourceBox !== null &&
              previewBox !== null &&
              previewBox.x > sourceBox.x + sourceBox.width - 4,
            `${label}: source and preview are not side by side`,
          );
          if (viewport.width === 1024) {
            check(
              tabsBox !== null && sourceBox !== null && sourceBox.y > tabsBox.y,
              `${label}: file tabs are not above the source`,
            );
          }
        } else {
          check(
            await page.locator("#skill-file-skill").isVisible(),
            `${label}: source not visible`,
          );
          check(
            !(await page.locator("#skill-preview-pane").isVisible()),
            `${label}: preview visible before the Preview tab`,
          );
          await page.getByRole("tab", { name: "Preview" }).click();
          await page.waitForTimeout(150);
          check(
            await page.locator("#skill-preview-pane").isVisible(),
            `${label}: Preview tab did not show the preview`,
          );
          check(
            !(await page.locator("#skill-file-skill").isVisible()),
            `${label}: Preview tab did not hide the source`,
          );
          await page.getByRole("tab", { name: "Source" }).click();
          await page.waitForTimeout(150);
          check(
            await page.locator("#skill-file-skill").isVisible(),
            `${label}: Source tab did not restore the source`,
          );
        }
        if (viewport.width === 390) {
          const saveBox = await page.locator("[data-skill-save]").boundingBox();
          check(
            saveBox !== null && saveBox.height >= 43.5,
            `${label}: save target is ${saveBox?.height}px, expected >=44px`,
          );
          const editBarBox = await page.locator("[data-skill-editbar]").boundingBox();
          check(
            editBarBox !== null && editBarBox.y + editBarBox.height > 800,
            `${label}: edit bar is not fixed near the bottom`,
          );
          await page
            .locator("select[data-skill-file-select]")
            .selectOption({ label: "references/rollback.md" });
          await page.waitForTimeout(100);
          await page.getByRole("tab", { name: "Preview" }).click();
          await page.waitForTimeout(150);
          check(
            (await textOf(page, "[data-skill-preview]")).includes("Rollback"),
            `${label}: file select and Preview tab do not work together`,
          );
        }
        await assertNoOverflow(page, label);
        await shot(page, `workspace-${viewport.name}-${theme}.png`);
        await assertClean(errors, label);
        await context.close();
      }
    }
  });

  await scenario("preview-safety", async () => {
    const context = await newContext({ width: 1440, height: 900, theme: "dark" });
    const { page, errors } = await open(context, `/skills/${ids.release}`);
    const previewText = await textOf(page, "[data-skill-preview]");
    check(previewText.includes("Release checklist"), "preview: heading is missing");
    check(
      (await page.locator("[data-skill-preview] table").count()) === 1,
      "preview: table missing",
    );
    check(
      (await page.locator("[data-skill-preview] pre > code").textContent())?.includes(
        "npm run release",
      ) === true,
      "preview: code fence missing",
    );
    const link = page.locator('[data-skill-preview] a[href^="https://example.test/"]').first();
    check((await link.count()) === 1, "preview: external link missing");
    check((await link.getAttribute("target")) === "_blank", "preview: link target is wrong");
    check((await link.getAttribute("rel")) === "noreferrer noopener", "preview: link rel is wrong");
    check(
      (await page.locator("[data-skill-preview] script").count()) === 0,
      "preview: raw <script> became an element",
    );
    check(
      (await page.locator("[data-skill-preview] img").count()) === 0,
      "preview: raw <img> became an element",
    );
    check(
      (await page.locator('[data-skill-preview] a[href^="javascript:"]').count()) === 0,
      "preview: javascript: link became an anchor",
    );
    check(previewText.includes("<script>"), "preview: raw HTML is not preserved as text");
    check(previewText.includes("javascript:"), "preview: javascript: link text is not preserved");
    check(
      (await page.evaluate(() => window.__qaXss)) === undefined,
      "preview: raw HTML executed script",
    );
    check(
      (await page.locator("[data-skill-frontmatter]").count()) === 1,
      "preview: frontmatter disclosure missing",
    );
    await page.locator(".skill-frontmatter__summary").click();
    const frontmatter = await textOf(page, ".skill-frontmatter__pre");
    check(frontmatter.includes('name: "release-checklist"'), "preview: frontmatter name is wrong");
    check(frontmatter.includes('license: "MIT"'), "preview: frontmatter license is wrong");
    check(frontmatter.includes('domain: "engineering"'), "preview: frontmatter metadata is wrong");
    await assertNoOverflow(page, "preview-safety");
    await assertClean(errors, "preview-safety");
    await context.close();
  });

  await scenario("workspace-editing", async () => {
    const context = await newContext({ width: 1440, height: 900, theme: "dark" });
    const { page, errors } = await open(context, `/skills/${ids.release}`, {
      expectedStatuses: [EXPECTED_STATUS],
    });
    check(
      (await textOf(page, "[data-skill-status]")) === "All changes saved",
      "editing: initial status is not saved",
    );
    check(
      await page.locator("[data-skill-save]").isDisabled(),
      "editing: save is enabled when clean",
    );
    check(
      await page.locator("[data-skill-discard]").isDisabled(),
      "editing: discard is enabled when clean",
    );
    await page.locator("#skill-content").fill("# Changed heading\n\nA live preview paragraph.");
    await page.waitForTimeout(250);
    check(
      (await textOf(page, "[data-skill-preview]")).includes("Changed heading"),
      "editing: preview did not update",
    );
    check(
      (await textOf(page, "[data-skill-status]")) === "Unsaved changes",
      "editing: dirty status did not appear",
    );
    check(!(await page.locator("[data-skill-save]").isDisabled()), "editing: save stayed disabled");
    check(
      (await page.locator("[data-skill-file-dirty]:visible").count()) >= 1,
      "editing: active file has no dirty dot",
    );
    await shot(page, "workspace-dirty-1440-dark.png");

    await page.route(`**/api/skills/${ids.release}`, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Description is required",
            code: "VALIDATION",
            field: "description",
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.locator("[data-skill-save]").click();
    await page.waitForTimeout(350);
    check(
      (await page.locator(".field-error[data-client-error]").count()) === 1,
      "editing: JSON 400 did not render an inline field error",
    );
    check(
      (await page.locator("#skill-description").getAttribute("aria-invalid")) === "true",
      "editing: invalid field is not marked",
    );
    check(
      (await page.evaluate(() => document.activeElement?.id)) === "skill-description",
      "editing: focus did not move to the invalid field",
    );
    check(
      (await page.locator("#skill-content").inputValue()).includes("Changed heading"),
      "editing: values were not preserved after the 400",
    );
    await shot(page, "workspace-error-1440-dark.png");
    await page.unroute(`**/api/skills/${ids.release}`);

    await page.locator("[data-skill-discard]").click();
    await page.waitForTimeout(200);
    check(
      !(await page.locator("#skill-content").inputValue()).includes("Changed heading"),
      "editing: discard did not restore the server content",
    );
    check(
      (await textOf(page, "[data-skill-status]")) === "All changes saved",
      "editing: discard did not restore the saved status",
    );
    check(
      await page.locator("[data-skill-save]").isDisabled(),
      "editing: discard left save enabled",
    );

    await addReference(page, "references/qa-temp.md", "# QA temp\n");
    check(
      (await page.locator("[data-skill-reference-path]").count()) === 1,
      "editing: first Add reference did not create a row",
    );
    await addReference(page, "references/qa-temp-two.md", "# QA temp two\n");
    check(
      (await page.locator("[data-skill-reference-path]").count()) === 2,
      "editing: Add reference cannot be used twice",
    );
    check(
      (await textOf(page, "[data-skill-status]")) === "Unsaved changes",
      "editing: added references did not mark the form dirty",
    );
    await page.locator("[data-skill-discard]").click();
    await page.waitForTimeout(200);
    check(
      (await referencePane(page, "references/qa-temp.md").count()) === 0,
      "editing: discard kept the first added reference",
    );
    check(
      (await referencePane(page, "references/qa-temp-two.md").count()) === 0,
      "editing: discard kept the second added reference",
    );

    await page.locator("[data-skill-add-metadata]").click();
    await page.waitForTimeout(80);
    await page.locator("[data-skill-add-metadata]").click();
    await page.waitForTimeout(80);
    const keys = page.locator("[data-skill-metadata-key-input]");
    check((await keys.count()) === 2, "editing: Add metadata cannot be used twice");
    await keys.nth(0).fill("qa-note");
    await page.locator("[data-skill-metadata-value-input]").nth(0).fill("verified");
    await keys.nth(1).fill("qa-note-two");
    await page.locator("[data-skill-metadata-value-input]").nth(1).fill("second");
    await page.waitForTimeout(100);
    check(
      (await textOf(page, "[data-skill-status]")) === "Unsaved changes",
      "editing: custom metadata did not mark the form dirty",
    );
    await page.locator("[data-skill-discard]").click();
    await page.waitForTimeout(150);
    check(
      (await page.locator("[data-skill-metadata-row]").count()) === 0,
      "editing: discard kept custom metadata rows",
    );

    await addReference(page, "references/qa-temp.md", "# QA temp\n");
    await submitJsonUpdate(page, ids.release);
    check(
      (await referencePane(page, "references/qa-temp.md").count()) === 1,
      "editing: saved reference is missing",
    );
    check(
      (await page.locator("#skill-license").inputValue()) === "MIT",
      "editing: license was not preserved after saving a reference",
    );
    check(
      (await page.locator("#skill-compatibility").inputValue()) === "Node >= 20",
      "editing: compatibility was not preserved after saving a reference",
    );
    check(
      (await page.locator("#skill-metadata-domain").inputValue()) === "engineering",
      "editing: metadata was not preserved after saving a reference",
    );

    const tempTab = page.locator(
      '[data-skill-file-tab][data-skill-file-path="references/qa-temp.md"]',
    );
    check((await tempTab.count()) === 1, "editing: saved reference tab is missing");
    await tempTab.click();
    await page.waitForTimeout(100);
    const tempId = await tempTab.getAttribute("data-skill-file-id");
    check(typeof tempId === "string" && tempId.length > 0, "editing: reference id is missing");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(`#${tempId} [data-skill-remove-reference]`).click();
    await page.waitForTimeout(150);
    check(
      (await textOf(page, "[data-skill-status]")) === "Unsaved changes",
      "editing: removing a reference did not mark the form dirty",
    );
    await submitJsonUpdate(page, ids.release);
    check(
      (await referencePane(page, "references/qa-temp.md").count()) === 0,
      "editing: removed reference is still present",
    );

    await page.locator("[data-skill-add-metadata]").click();
    await page.waitForTimeout(80);
    await page.locator("[data-skill-metadata-key-input]").last().fill("qa-note");
    await page.locator("[data-skill-metadata-value-input]").last().fill("verified");
    await page.waitForTimeout(100);
    await submitJsonUpdate(page, ids.release);
    check(
      (await page.locator("[data-skill-metadata-key-input]").count()) === 1,
      "editing: saved custom metadata row is missing",
    );
    check(
      (await page.locator("[data-skill-metadata-key-input]").first().inputValue()) === "qa-note",
      "editing: saved custom metadata key is wrong",
    );
    check(
      (await page.locator("[data-skill-metadata-value-input]").first().inputValue()) === "verified",
      "editing: saved custom metadata value is wrong",
    );
    await page.locator("[data-skill-remove-metadata]").first().click();
    await page.waitForTimeout(120);
    await submitJsonUpdate(page, ids.release);
    check(
      (await page.locator("[data-skill-metadata-key-input]").count()) === 0,
      "editing: removed custom metadata is still present",
    );
    check(
      (await page.locator("#skill-license").inputValue()) === "MIT" &&
        (await page.locator("#skill-license").inputValue()).length > 0,
      "editing: license was lost after the metadata round-trip",
    );
    await assertClean(errors, "workspace-editing");
    await context.close();
  });

  await scenario("invalid-repair", async () => {
    const context = await newContext({ width: 1440, height: 900, theme: "dark" });
    const { page, errors } = await open(context, `/skills/${ids.repair}`);
    check(
      (await page.locator("[data-skill-issues]").count()) === 1,
      "repair: issue strip is missing",
    );
    const raw = page.locator("[data-skill-metadata-raw]");
    check(await raw.isVisible(), "repair: raw metadata editor is hidden");
    check(await raw.isEnabled(), "repair: raw metadata editor is disabled");
    check(
      (await raw.inputValue()) === '{"author":',
      "repair: invalid stored metadata was not preserved",
    );
    check(
      (await page.locator("[data-skill-clear-metadata]").count()) === 1,
      "repair: Clear metadata is missing",
    );
    await shot(page, "workspace-repair-1440-dark.png");
    await page.locator("#skill-description").fill("A corrupt row, edited through the body.");
    await page.waitForTimeout(100);
    await submitJsonUpdate(page, ids.repair);
    check(
      (await page.locator("[data-skill-metadata-raw]").inputValue()) === '{"author":',
      "repair: a body save did not preserve invalid raw metadata",
    );
    check(
      (await page.locator("#skill-description").inputValue()).includes("edited through the body"),
      "repair: the body edit was not saved",
    );
    await page.locator("[data-skill-clear-metadata]").click();
    await page.waitForTimeout(150);
    check(
      !(await page.locator("#skill-metadata-raw").isVisible()),
      "repair: Clear metadata did not hide the raw editor",
    );
    check(
      (await textOf(page, "[data-skill-status]")) === "Unsaved changes",
      "repair: clearing metadata did not mark the form dirty",
    );
    await submitJsonUpdate(page, ids.repair);
    check(
      (await page.locator("[data-skill-metadata-raw]").count()) === 0,
      "repair: clearing metadata did not remove the invalid JSON",
    );
    check(
      (await page.locator("[data-skill-issues]").count()) === 0,
      "repair: the issue strip survived the repair",
    );
    await assertClean(errors, "invalid-repair");
    await context.close();
  });

  await scenario("read-only-context", async () => {
    const context = await newContext({ width: 1440, height: 900, theme: "dark" });
    const from = encodeURIComponent("/projects/p1/apps/web/skills");
    const { page, errors } = await open(context, `/skills/${ids.opsGuide}?from=${from}`, {
      expectedStatuses: [EXPECTED_STATUS],
    });
    check(
      (await textOf(page, "[data-skill-state]")) === "Inherited",
      "read-only: inherited state is not shown",
    );
    check(
      (await page.locator("[data-skill-editbar]").count()) === 0,
      "read-only: edit bar is present",
    );
    check(
      (await page.locator("[data-skill-override]").count()) === 1,
      "read-only: Override here is missing",
    );
    check(
      (await page.locator("[data-skill-disable]").count()) === 1,
      "read-only: Disable here is missing",
    );
    check(
      (await page.locator("[data-skill-source-static]").count()) >= 1,
      "read-only: source is not a static pre",
    );
    check(
      (await textOf(page, "[data-skill-preview]")).includes("Operations guide"),
      "read-only: preview did not render",
    );
    await page.getByRole("tab", { name: /references\/runbook\.md/ }).click();
    await page.waitForTimeout(150);
    check(
      (await textOf(page, "[data-skill-preview]")).includes("Runbook"),
      "read-only: file tabs do not drive the preview",
    );
    await shot(page, "workspace-inherited-1440-dark.png");

    let message = "";
    page.once("dialog", async (dialog) => {
      message = dialog.message();
      await dialog.dismiss();
    });
    await page.locator("[data-skill-disable] button").click();
    await page.waitForTimeout(200);
    check(
      message.includes("Disable this skill"),
      "read-only: Disable did not ask for confirmation",
    );
    check(page.url().includes(`from=${from}`), "read-only: cancelling Disable navigated away");

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("[data-skill-override] button").click();
    await page.waitForURL((url) => url.pathname === "/projects/p1/apps/web/skills");
    await page.waitForLoadState("networkidle");
    check(
      (await page.locator('[data-skill-name="ops-guide"]').getAttribute("data-skill-state")) ===
        "enabled",
      "read-only: Override here did not create the editable copy",
    );
    await page.locator('[data-skill-name="ops-guide"] a[aria-label="Open ops-guide"]').click();
    await page.waitForLoadState("networkidle");
    check(
      (await textOf(page, "[data-skill-state]")) === "Enabled here",
      "read-only: overridden workspace is not editable",
    );
    check(
      (await page.locator("[data-skill-editbar]").count()) === 1,
      "read-only: overridden workspace has no edit bar",
    );
    await page.locator("#skill-confirm-name").fill("wrong-name");
    let response = await submitNative(page, page.locator("[data-skill-danger] button"));
    check(response.status() === 422, `read-only: delete mismatch returned ${response.status()}`);
    check(
      (await page.locator("#skill-confirm-name-error").count()) === 1,
      "read-only: delete mismatch did not render a field error",
    );
    await page.locator("#skill-confirm-name").fill("ops-guide");
    response = await submitNative(page, page.locator("[data-skill-danger] button"));
    check(response.status() === 303, `read-only: delete returned ${response.status()}`);
    check(
      (await page.locator('[data-skill-name="ops-guide"]').getAttribute("data-skill-state")) ===
        "inherited",
      "read-only: deleting the override did not restore inheritance",
    );

    const deployFrom = encodeURIComponent("/projects/p1/apps/web/skills");
    const deploy = await open(context, `/skills/${ids.deployNotes}?from=${deployFrom}`, {
      expectedStatuses: [EXPECTED_STATUS],
    });
    const deployPage = deploy.page;
    check(
      (await textOf(deployPage, "[data-skill-state]")) === "Inherited",
      "disable: deploy-notes is not inherited",
    );
    let disableMessage = "";
    deployPage.once("dialog", async (dialog) => {
      disableMessage = dialog.message();
      await dialog.accept();
    });
    await deployPage.locator("[data-skill-disable] button").click();
    await deployPage.waitForURL((url) => url.pathname === "/projects/p1/apps/web/skills");
    await deployPage.waitForLoadState("networkidle");
    check(disableMessage.includes("Disable this skill"), "disable: Disable did not confirm");
    check(
      (await deployPage
        .locator('[data-skill-name="deploy-notes"]')
        .getAttribute("data-skill-state")) === "disabled",
      "disable: Disable here did not create a tombstone",
    );
    await deployPage
      .locator('[data-skill-name="deploy-notes"] a[aria-label="Open deploy-notes"]')
      .click();
    await deployPage.waitForLoadState("networkidle");
    check(
      (await textOf(deployPage, "[data-skill-state]")) === "Disabled here",
      "disable: tombstone workspace state is wrong",
    );
    check(
      (await deployPage.locator("[data-skill-danger]").textContent())?.includes(
        "Revert to inherited",
      ) === true,
      "disable: revert action is missing",
    );
    await deployPage.locator("#skill-confirm-name").fill("deploy-notes");
    response = await submitNative(deployPage, deployPage.locator("[data-skill-danger] button"));
    check(response.status() === 303, `disable: revert returned ${response.status()}`);
    check(
      (await deployPage
        .locator('[data-skill-name="deploy-notes"]')
        .getAttribute("data-skill-state")) === "inherited",
      "disable: revert did not restore inheritance",
    );
    await assertClean(errors, "read-only-context");
    await assertClean(deploy.errors, "read-only-context/deploy-notes");
    await context.close();
  });

  await scenario("create", async () => {
    const context = await newContext({ width: 1440, height: 900, theme: "dark" });
    const { page, errors } = await open(context, "/skills/new?scope=global", {
      expectedStatuses: [EXPECTED_STATUS],
    });
    check(
      (await page.locator("[data-skill-form]").count()) === 1,
      "create: bundle form is missing",
    );
    check(
      (await page.locator("[data-skill-file-list]").count()) === 0,
      "create: file rail exists before any reference",
    );
    check(
      (await page.locator(".badge-info").count()) === 1 &&
        (await textOf(page, ".badge-info")) === "Draft",
      "create: draft badge is missing",
    );
    check(
      await page.locator("[data-skill-save]").isDisabled(),
      "create: save is enabled when empty",
    );
    await page.locator("#skill-name").fill("qa-created");
    await page.locator("#skill-description").fill("A skill created by the QA harness.");
    await page.locator("#skill-content").fill("# QA created\n\nCreated through the real form.");
    await page.waitForTimeout(150);
    check(!(await page.locator("[data-skill-save]").isDisabled()), "create: save stayed disabled");
    await addReference(page, "references/guide.md", "# Guide\n");
    check(
      (await page.locator("[data-skill-file-list]").count()) === 1,
      "create: adding a reference did not create the file rail",
    );
    await shot(page, "create-1440-dark.png");
    await submitJsonCreate(page);
    check(
      /^\/skills\/\d+$/.test(new URL(page.url()).pathname),
      "create: success did not land on the new workspace",
    );
    check(
      (await page.locator("#skill-description").inputValue()) ===
        "A skill created by the QA harness.",
      "create: description was not saved",
    );
    check(
      (await referencePane(page, "references/guide.md").count()) === 1,
      "create: reference was not saved",
    );

    const duplicate = await open(context, "/skills/new?scope=global", {
      expectedStatuses: [EXPECTED_STATUS],
    });
    const duplicatePage = duplicate.page;
    await duplicatePage.locator("#skill-name").fill("release-checklist");
    await duplicatePage.locator("#skill-description").fill("Duplicate name probe.");
    await duplicatePage.locator("#skill-content").fill("# Duplicate\n");
    await duplicatePage.waitForTimeout(150);
    const [response] = await Promise.all([
      duplicatePage.waitForResponse(
        (entry) => entry.url().endsWith("/api/skills") && entry.request().method() === "POST",
      ),
      duplicatePage.locator("[data-skill-save]").click(),
    ]);
    check(response.status() === 409, `create: duplicate returned ${response.status()}`);
    await duplicatePage.waitForTimeout(250);
    check(
      (await duplicatePage.locator(".field-error[data-client-error]").count()) === 1,
      "create: 409 did not render an inline name error",
    );
    check(
      (await duplicatePage.locator("#skill-name").getAttribute("aria-invalid")) === "true",
      "create: duplicate name is not marked invalid",
    );
    check(
      (await duplicatePage.evaluate(() => document.activeElement?.id)) === "skill-name",
      "create: 409 did not focus the name field",
    );
    check(
      new URL(duplicatePage.url()).pathname === "/skills/new",
      "create: 409 left the create page",
    );
    await assertClean(duplicate.errors, "create/duplicate");
    await assertClean(errors, "create");
    await context.close();
  });

  await scenario("create-narrow", async () => {
    const context = await newContext({ width: 390, height: 844, theme: "light" });
    const { page, errors } = await open(context, "/skills/new?scope=global");
    check((await page.locator("[data-skill-form]").count()) === 1, "create/390: form is missing");
    await assertNoOverflow(page, "create/390");
    await shot(page, "create-390-light.png");
    await assertClean(errors, "create/390");
    await context.close();
  });

  await scenario("nojs-workspace", async () => {
    const context = await newContext({
      width: 1024,
      height: 900,
      theme: "dark",
      javaScriptEnabled: false,
    });
    const { page, errors } = await open(context, `/skills/${ids.release}`);
    check(
      (await page.locator("[data-skill-file]").count()) === 3,
      "no-js: expected three stacked file editors",
    );
    for (const id of ["skill-file-skill", "skill-file-ref-0", "skill-file-ref-1"]) {
      check(await page.locator(`#${id}`).isVisible(), `no-js: ${id} is not visible`);
    }
    check(
      !(await page.locator("[data-skill-viewtabs]").isVisible()),
      "no-js: Source/Preview tabs are visible",
    );
    check(
      !(await page.locator("[data-skill-file-picker]").isVisible()),
      "no-js: file picker is visible",
    );
    check(await page.locator("#skill-metadata-domain").isDisabled(), "no-js: metadata is enabled");
    check(await page.locator("#skill-license").isDisabled(), "no-js: license is enabled");
    check(
      await page.locator("#skill-compatibility").isDisabled(),
      "no-js: compatibility is enabled",
    );
    check(
      await page.locator("[data-skill-reference-content]").first().isDisabled(),
      "no-js: reference content is enabled",
    );
    check(
      (await page.locator('input[name="license"]').count()) === 0,
      "no-js: license is a named field",
    );
    check(
      (await page.locator('input[name="metadata"]').count()) === 0,
      "no-js: metadata is a named field",
    );
    check(
      (await page.locator('textarea[name="references"]').count()) === 0,
      "no-js: references are named fields",
    );
    const bundle = await page.locator('input[name="bundle"]').inputValue();
    check(bundle.length > 0, "no-js: hidden bundle snapshot is missing");
    const snapshot = JSON.parse(bundle);
    check(snapshot.license === "MIT", "no-js: snapshot lost the license");
    check(snapshot.compatibility === "Node >= 20", "no-js: snapshot lost compatibility");
    check(snapshot.metadata.domain === "engineering", "no-js: snapshot lost metadata");
    check(
      Array.isArray(snapshot.references) && snapshot.references.length === 2,
      "no-js: snapshot lost references",
    );
    check(
      (await textOf(page, "[data-skill-preview]")).includes("Preview requires JavaScript"),
      "no-js: preview does not state that it needs JavaScript",
    );
    await assertNoOverflow(page, "no-js/workspace");
    await shot(page, "nojs-workspace-1024-dark.png");

    await page.locator("#skill-description").fill("Saved without JavaScript.");
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        (entry) =>
          entry.request().method() === "POST" && entry.url().includes(`/api/skills/${ids.release}`),
      ),
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.locator("[data-skill-save]").click(),
    ]);
    check(saveResponse.status() === 303, `no-js: save returned ${saveResponse.status()}`);
    check(
      (await page.locator("#skill-description").inputValue()) === "Saved without JavaScript.",
      "no-js: body save did not persist",
    );
    check(
      (await page.locator("#skill-license").inputValue()) === "MIT",
      "no-js: body save lost the license snapshot",
    );
    check(
      (await page.locator("#skill-compatibility").inputValue()) === "Node >= 20",
      "no-js: body save lost compatibility",
    );
    check(
      (await page.locator("#skill-metadata-domain").inputValue()) === "engineering",
      "no-js: body save lost metadata",
    );
    check(
      (await page.locator("[data-skill-file-kind='reference']").count()) === 2,
      "no-js: body save lost references",
    );

    await page.locator("#skill-description").fill("Discard this without JavaScript.");
    const [discardResponse] = await Promise.all([
      page.waitForResponse(
        (entry) =>
          entry.request().method() === "POST" && entry.url().includes(`/api/skills/${ids.release}`),
      ),
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.locator("[data-skill-discard]").click(),
    ]);
    check(discardResponse.status() === 303, `no-js: discard returned ${discardResponse.status()}`);
    check(
      !(await page.locator("#skill-description").inputValue()).includes("Discard this"),
      "no-js: discard did not restore the saved description",
    );
    await assertClean(errors, "no-js/workspace");
    await context.close();
  });

  await scenario("nojs-create-conflict", async () => {
    const context = await newContext({
      width: 1440,
      height: 900,
      theme: "dark",
      javaScriptEnabled: false,
    });
    const { page, errors } = await open(context, "/skills/new?scope=global", {
      expectedStatuses: [EXPECTED_STATUS],
    });
    await page.locator("#skill-name").fill("release-checklist");
    await page.locator("#skill-description").fill("A duplicate skill name.");
    await page.locator("#skill-content").fill("# Duplicate\n");
    const response = await submitNative(page, page.locator("[data-skill-save]"));
    check(response.status() === 409, `no-js create: duplicate returned ${response.status()}`);
    check(
      (await page.locator("[data-skill-conflict]").count()) === 1,
      "no-js create: conflict notice is missing",
    );
    check(
      (await page.locator("[data-skill-conflict] a").getAttribute("href"))?.startsWith(
        `/skills/${ids.release}`,
      ) === true,
      "no-js create: conflict link does not open the existing skill",
    );
    check(
      (await page.locator("#skill-name").inputValue()) === "release-checklist",
      "no-js create: 409 did not preserve the submitted name",
    );
    await assertNoOverflow(page, "no-js/create-conflict");
    await shot(page, "create-conflict-1440-dark.png");
    await assertClean(errors, "no-js/create-conflict");
    await context.close();
  });

  await scenario("nojs-create-422", async () => {
    const context = await newContext({ width: 1024, height: 900, theme: "dark" });
    const response = await context.request.post(`${base}/api/skills`, {
      headers: { accept: "text/html" },
      form: {
        action: "create",
        scope: "global",
        name: "qa-invalid-ref",
        description: "A create request with an invalid reference path.",
        content: "# QA invalid\n",
        enabled: "1",
        bundle: JSON.stringify({
          license: null,
          compatibility: null,
          metadata: {},
          metadataRaw: null,
          references: [{ path: "references/Bad Name.md", content: "# Bad\n" }],
        }),
      },
    });
    check(response.status() === 422, `no-js create: 422 returned ${response.status()}`);
    const body = await response.text();
    check(body.includes("data-skill-form-error"), "no-js create: 422 error summary is missing");
    check(body.includes("qa-invalid-ref"), "no-js create: 422 lost the submitted name");
    check(body.includes("Bad Name.md"), "no-js create: 422 lost the submitted reference");
    await context.close();
  });

  report.finishedAt = new Date().toISOString();
  if (report.assertions.failed > 0) {
    report.status = "FAIL";
  }
  for (const relative of report.screenshots) {
    const file = path.join(ROOT, relative);
    if (!(existsSync(file) && statSync(file).size > 0)) {
      report.status = "FAIL";
      report.errors.push(`screenshot ${relative}: missing or empty`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "FAIL";
  report.finishedAt = new Date().toISOString();
  report.errors.push(String(error));
  console.error(String(error));
  process.exitCode = 1;
} finally {
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (browser !== null) {
    await browser.close();
  }
  await stopServer(serverChild);
  rmSync(temp, { recursive: true, force: true });
}
