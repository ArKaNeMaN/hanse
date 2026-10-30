import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTerminalAssets,
  resetTerminalAssetsForTests,
  TERMINAL_SCRIPTS,
  TERMINAL_STYLESHEET,
} from "../../ui/terminal/loader.js";

interface XtermWindow {
  Terminal?: unknown;
  FitAddon?: unknown;
  Unicode11Addon?: unknown;
  UnicodeGraphemesAddon?: unknown;
}

function installGlobals(): void {
  const view = window as unknown as XtermWindow;
  view.Terminal = class Terminal {};
  view.FitAddon = { FitAddon: class FitAddon {} };
  view.Unicode11Addon = { Unicode11Addon: class Unicode11Addon {} };
  view.UnicodeGraphemesAddon = {
    UnicodeGraphemesAddon: class UnicodeGraphemesAddon {},
  };
}

function scriptSources(): string[] {
  return [...document.querySelectorAll<HTMLScriptElement>("script[data-hanse-xterm]")].map(
    (script) => script.getAttribute("src") ?? "",
  );
}

function styleLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[href$="xterm-6.0.0.css"]')];
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  resetTerminalAssetsForTests(document);
  installGlobals();
});

afterEach(() => {
  resetTerminalAssetsForTests(document);
  const view = window as unknown as XtermWindow;
  delete view.Terminal;
  delete view.FitAddon;
  delete view.Unicode11Addon;
  delete view.UnicodeGraphemesAddon;
});

describe("terminal asset loader", () => {
  it("loads the four vendor scripts in order and exactly one stylesheet", async () => {
    const order: string[] = [];
    const globals = await loadTerminalAssets({
      loadScript: async (script) => {
        order.push(script.getAttribute("src") ?? "");
      },
      loadStyle: async (link) => {
        order.push(link.getAttribute("href") ?? "");
      },
    });

    expect(order.filter((entry) => entry.endsWith(".js"))).toEqual([...TERMINAL_SCRIPTS]);
    expect(order).toContain(TERMINAL_STYLESHEET);
    expect(scriptSources()).toEqual([...TERMINAL_SCRIPTS]);
    expect(styleLinks()).toHaveLength(1);
    expect(typeof globals.Terminal).toBe("function");
    expect(typeof globals.FitAddon).toBe("function");
  });

  it("is idempotent and promise-cached across a first load and a client navigation", async () => {
    const loadScript = vi.fn(async () => undefined);
    const loadStyle = vi.fn(async () => undefined);
    const first = loadTerminalAssets({ loadScript, loadStyle });
    const second = loadTerminalAssets({ loadScript, loadStyle });
    await first;
    await second;

    expect(loadScript).toHaveBeenCalledTimes(TERMINAL_SCRIPTS.length);
    expect(loadStyle).toHaveBeenCalledTimes(1);
    expect(scriptSources()).toEqual([...TERMINAL_SCRIPTS]);
    expect(styleLinks()).toHaveLength(1);

    // A remount on client navigation calls the loader again in the same document.
    await loadTerminalAssets({ loadScript, loadStyle });
    expect(loadScript).toHaveBeenCalledTimes(TERMINAL_SCRIPTS.length);
    expect(loadStyle).toHaveBeenCalledTimes(1);
    expect(styleLinks()).toHaveLength(1);
  });

  it("does not duplicate a stylesheet that the document already has", async () => {
    const existing = document.createElement("link");
    existing.rel = "stylesheet";
    existing.href = TERMINAL_STYLESHEET;
    document.head.appendChild(existing);

    await loadTerminalAssets({
      loadScript: async () => undefined,
      loadStyle: async () => undefined,
    });

    expect(styleLinks()).toHaveLength(1);
    expect(styleLinks()[0]).toBe(existing);
  });

  it("surfaces a failure, removes the failed script, and reloads only the missing assets on retry", async () => {
    let failOn = TERMINAL_SCRIPTS[1];
    const loaded: string[] = [];
    const loadScript = async (script: HTMLScriptElement): Promise<void> => {
      const src = script.getAttribute("src") ?? "";
      if (src === failOn) {
        failOn = "";
        throw new Error(`network error for ${src}`);
      }
      loaded.push(src);
    };
    const loadStyle = async (): Promise<void> => undefined;

    await expect(loadTerminalAssets({ loadScript, loadStyle })).rejects.toThrow(/network error/);
    expect(scriptSources()).toEqual([TERMINAL_SCRIPTS[0]]);

    const globals = await loadTerminalAssets({ loadScript, loadStyle });
    expect(loaded).toEqual([...TERMINAL_SCRIPTS]);
    expect(scriptSources()).toEqual([...TERMINAL_SCRIPTS]);
    expect(styleLinks()).toHaveLength(1);
    expect(typeof globals.Terminal).toBe("function");
  });
});
