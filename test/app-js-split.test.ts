import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const APP_JS = readFileSync(`${process.cwd()}/assets/app.js`, "utf8");
const APP_CONTENT_JS = readFileSync(`${process.cwd()}/assets/app-content.js`, "utf8");

interface Loaded {
  dom: JSDOM;
  window: JSDOM["window"];
  document: Document;
}

function load(
  html: string,
  script: string,
  options: { mobile?: boolean; desktop?: boolean } = {},
): Loaded {
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only" });
  const window = dom.window;
  window.matchMedia = ((query: string) => ({
    matches: query.startsWith("(max-width") ? options.mobile === true : options.desktop === true,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.setTimeout = ((handler: () => void) => {
    if (typeof handler === "function") {
      handler();
    }
    return 0;
  }) as unknown as typeof window.setTimeout;
  window.clearTimeout = (() => undefined) as typeof window.clearTimeout;
  if (typeof window.HTMLDialogElement.prototype.showModal !== "function") {
    window.HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof window.HTMLDialogElement.prototype.close !== "function") {
    window.HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new window.Event("close"));
    };
  }
  window.document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof window.Element && event.target.closest("a") !== null) {
        event.preventDefault();
      }
    },
    true,
  );
  window.eval(script);
  return { dom, window, document: window.document };
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("missing fixture element");
  }
  return value;
}

function click(target: Element): void {
  const window = target.ownerDocument.defaultView;
  if (window === null) {
    throw new Error("missing window");
  }
  target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function keydown(target: Element | Document, key: string): void {
  const document = target.nodeType === 9 ? (target as Document) : (target as Element).ownerDocument;
  const window = document.defaultView;
  if (window === null) {
    return;
  }
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
}

const SHELL = `<!doctype html>
<html data-theme="dark"><body>
  <div class="app-shell" data-nav="closed" id="shell">
    <aside class="sidebar">
      <a class="nav-item" href="#projects">Projects</a>
      <button type="button" data-nav-close>Close</button>
    </aside>
    <button type="button" data-nav-toggle aria-expanded="false">Menu</button>
    <button type="button" data-theme-toggle><span data-theme-label>Light</span></button>
  </div>
</body></html>`;

describe("app.js shell behavior", () => {
  it("opens and closes the mobile drawer", () => {
    const { document, window } = load(SHELL, APP_JS);
    const shell = must(document.getElementById("shell"));
    const toggle = must(document.querySelector("[data-nav-toggle]"));
    click(toggle);
    expect(shell.dataset.nav).toBe("open");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    keydown(document, "Escape");
    expect(shell.dataset.nav).toBe("closed");

    click(toggle);
    click(must(document.querySelector("[data-nav-close]")));
    expect(shell.dataset.nav).toBe("closed");
    void window;
  });

  it("closes the drawer on a delegated sidebar link click only on mobile", () => {
    const { document } = load(SHELL, APP_JS, { mobile: true });
    const shell = must(document.getElementById("shell"));
    click(must(document.querySelector("[data-nav-toggle]")));
    click(must(document.querySelector(".sidebar a")));
    expect(shell.dataset.nav).toBe("closed");

    const desktop = load(SHELL, APP_JS, { mobile: false });
    const desktopShell = must(desktop.document.getElementById("shell"));
    click(must(desktop.document.querySelector("[data-nav-toggle]")));
    click(must(desktop.document.querySelector(".sidebar a")));
    expect(desktopShell.dataset.nav).toBe("open");
  });

  it("closes the drawer when the window grows past the drawer breakpoint", () => {
    const { document, window } = load(SHELL, APP_JS, { desktop: false });
    const shell = must(document.getElementById("shell"));
    click(must(document.querySelector("[data-nav-toggle]")));
    window.matchMedia = ((query: string) => ({
      matches: query.startsWith("(min-width"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    window.dispatchEvent(new window.Event("resize"));
    expect(shell.dataset.nav).toBe("closed");
  });

  it("toggles and persists the theme", () => {
    const { document, window } = load(SHELL, APP_JS);
    const root = document.documentElement;
    click(must(document.querySelector("[data-theme-toggle]")));
    expect(root.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("hanse-theme")).toBe("light");
    expect(must(document.querySelector("[data-theme-label]")).textContent).toBe("Dark");
  });
});

const CONTENT = `<!doctype html>
<html><body>
  <button type="button" data-dialog-open="dialog-one">Open</button>
  <dialog class="dialog" id="dialog-one">
    <button type="button" data-dialog-close>Close</button>
  </dialog>
  <details class="menu"><summary>Menu</summary><a href="#">One</a></details>
  <div class="segmented">
    <button class="segmented__item" type="button">One</button>
    <button class="segmented__item" type="button">Two</button>
  </div>
  <div class="toast" data-autodismiss="1"><button type="button" data-toast-close>Close</button></div>
  <div class="field__control">
    <input type="password" value="secret" />
    <button type="button" data-password-toggle aria-pressed="false" aria-label="Show token">Show</button>
  </div>
  <form><button type="submit">Save</button></form>
  <form data-no-busy><button type="submit">Skip</button></form>
</body></html>`;

describe("app-content.js content behavior", () => {
  it("does not wire content behavior from the shell script", () => {
    const { document } = load(CONTENT, APP_JS);
    click(must(document.querySelector("[data-dialog-open]")));
    expect(must(document.getElementById("dialog-one")).hasAttribute("open")).toBe(false);
  });

  it("opens and closes dialogs", () => {
    const { document } = load(CONTENT, APP_CONTENT_JS);
    const dialog = document.getElementById("dialog-one") as HTMLDialogElement;
    click(must(document.querySelector("[data-dialog-open]")));
    expect(dialog.hasAttribute("open")).toBe(true);
    click(must(document.querySelector("[data-dialog-close]")));
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("closes an open menu on Escape and on an outside click", () => {
    const { document } = load(CONTENT, APP_CONTENT_JS);
    const menu = document.querySelector("details.menu") as HTMLDetailsElement;
    menu.open = true;
    menu.dispatchEvent(new (document.defaultView as Window).Event("toggle", { bubbles: true }));
    keydown(document, "Escape");
    expect(menu.open).toBe(false);

    menu.open = true;
    menu.dispatchEvent(new (document.defaultView as Window).Event("toggle", { bubbles: true }));
    click(document.body);
    expect(menu.open).toBe(false);
  });

  it("moves focus with the segmented control arrow keys", () => {
    const { document } = load(CONTENT, APP_CONTENT_JS);
    const items = document.querySelectorAll(".segmented__item");
    (items[0] as HTMLElement).focus();
    keydown(must(items[0]), "ArrowRight");
    expect(document.activeElement).toBe(items[1]);
    keydown(must(items[1]), "ArrowLeft");
    expect(document.activeElement).toBe(items[0]);
  });

  it("auto-dismisses a toast with data-autodismiss", () => {
    const { document } = load(CONTENT, APP_CONTENT_JS);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("closes a toast with its close button", () => {
    const html = CONTENT.replace(' data-autodismiss="1"', "");
    const { document } = load(html, APP_CONTENT_JS);
    click(must(document.querySelector("[data-toast-close]")));
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("toggles password visibility", () => {
    const { document } = load(CONTENT, APP_CONTENT_JS);
    const input = document.querySelector("input") as HTMLInputElement;
    const toggle = must(document.querySelector("[data-password-toggle]"));
    click(toggle);
    expect(input.type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    click(toggle);
    expect(input.type).toBe("password");
  });

  it("sets submit-busy and honours data-no-busy", () => {
    const { document } = load(CONTENT, APP_CONTENT_JS);
    const form = document.querySelector("form:not([data-no-busy])") as HTMLFormElement;
    const button = form.querySelector("button") as HTMLButtonElement;
    form.dispatchEvent(
      new (document.defaultView as Window).Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(form.dataset.submitting).toBe("true");
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".spinner")).not.toBeNull();

    const optOut = document.querySelector("form[data-no-busy]") as HTMLFormElement;
    optOut.dispatchEvent(
      new (document.defaultView as Window).Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(optOut.dataset.submitting).toBeUndefined();
  });
});
