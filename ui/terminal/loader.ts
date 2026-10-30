/**
 * Sole on-demand loader for the vendored xterm assets.
 *
 * The SPA server never emits the xterm stylesheet through `renderSpaDocument.styles`; `TerminalView`
 * is the only owner. The loader is idempotent per document and caches one promise, so a first
 * terminal document and a client-side navigation into `/terminal` share the same script tags and
 * exactly one `<link>`.
 */

export const TERMINAL_SCRIPTS = [
  "/assets/vendor/xterm/xterm-6.0.0.js",
  "/assets/vendor/xterm/addon-fit-0.11.0.js",
  "/assets/vendor/xterm/addon-unicode11-0.9.0.js",
  "/assets/vendor/xterm/addon-unicode-graphemes-0.4.0.js",
] as const;

export const TERMINAL_STYLESHEET = "/assets/vendor/xterm/xterm-6.0.0.css";

const SCRIPT_SELECTOR = "script[data-hanse-xterm]";
const STYLE_SELECTOR = 'link[data-hanse-xterm], link[href$="xterm-6.0.0.css"]';

export interface XtermTerminal {
  open(element: HTMLElement): void;
  dispose(): void;
  write(data: Uint8Array | string): void;
  reset(): void;
  focus(): void;
  hasSelection(): boolean;
  getSelection(): string;
  paste(text: string): void;
  onData(listener: (data: string) => void): void;
  onBinary(listener: (data: string) => void): void;
  onSelectionChange(listener: () => void): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  loadAddon(addon: unknown): void;
  readonly cols: number;
  readonly rows: number;
  readonly options: {
    disableStdin?: boolean;
    cursorBlink?: boolean;
    theme?: Record<string, string>;
  };
  readonly unicode: { activeVersion: string };
}

export interface XtermFitAddon {
  fit(): void;
}

interface XtermConstructor {
  new (options: Record<string, unknown>): XtermTerminal;
}

interface FitAddonConstructor {
  new (): XtermFitAddon;
}

export interface XtermGlobals {
  readonly Terminal: XtermConstructor;
  readonly FitAddon: FitAddonConstructor;
  readonly Unicode11Addon?: unknown;
  readonly UnicodeGraphemesAddon?: unknown;
}

export interface TerminalAssetLoaderDeps {
  readonly document?: Document;
  /** Test seam; the default waits for the browser `load` event. */
  readonly loadScript?: (script: HTMLScriptElement) => Promise<void>;
  readonly loadStyle?: (link: HTMLLinkElement) => Promise<void>;
}

function defaultWait(element: HTMLScriptElement | HTMLLinkElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener(
      "error",
      () =>
        reject(
          new Error(
            `failed to load ${element.getAttribute("src") ?? element.getAttribute("href")}`,
          ),
        ),
      { once: true },
    );
  });
}

function existingScripts(doc: Document): Set<string> {
  const loaded = new Set<string>();
  for (const script of doc.querySelectorAll<HTMLScriptElement>(SCRIPT_SELECTOR)) {
    const src = script.getAttribute("src");
    if (src !== null && src.length > 0) {
      loaded.add(src);
    }
  }
  return loaded;
}

function ensureStylesheet(
  doc: Document,
  loadStyle: (link: HTMLLinkElement) => Promise<void>,
): Promise<void> | undefined {
  if (doc.querySelector(STYLE_SELECTOR) !== null) {
    return undefined;
  }
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = TERMINAL_STYLESHEET;
  link.dataset.hanseXterm = "style";
  link.dataset.hanseXtermOrder = String(TERMINAL_SCRIPTS.length);
  doc.head.appendChild(link);
  return loadStyle(link).catch((error: unknown) => {
    link.remove();
    throw error;
  });
}

function readGlobals(doc: Document): XtermGlobals {
  const view = doc.defaultView as (Window & Partial<XtermGlobals>) | null;
  const Terminal = view?.Terminal;
  const fit = view?.FitAddon;
  const FitAddon =
    fit !== undefined && typeof fit === "object" && "FitAddon" in fit
      ? (fit as { FitAddon: unknown }).FitAddon
      : fit;
  if (typeof Terminal !== "function" || typeof FitAddon !== "function") {
    throw new Error("terminal engine is unavailable");
  }
  return {
    Terminal: Terminal as unknown as XtermConstructor,
    FitAddon: FitAddon as unknown as FitAddonConstructor,
    Unicode11Addon: view?.Unicode11Addon,
    UnicodeGraphemesAddon: view?.UnicodeGraphemesAddon,
  };
}

let cached: Promise<XtermGlobals> | undefined;
let cachedDocument: Document | undefined;

/**
 * Load the four vendor scripts in order and the single stylesheet. Concurrent calls share one
 * promise; a failure clears the cache (and the failed tag) so the Retry control can run again.
 */
export function loadTerminalAssets(deps: TerminalAssetLoaderDeps = {}): Promise<XtermGlobals> {
  const doc = deps.document ?? document;
  if (cached !== undefined && cachedDocument === doc) {
    return cached;
  }
  const loadScript = deps.loadScript ?? defaultWait;
  const loadStyle = deps.loadStyle ?? defaultWait;
  const promise = (async () => {
    const stylePromise = ensureStylesheet(doc, loadStyle);
    const alreadyLoaded = existingScripts(doc);
    for (const src of TERMINAL_SCRIPTS) {
      if (alreadyLoaded.has(src)) {
        continue;
      }
      const script = doc.createElement("script");
      script.src = src;
      script.async = false;
      script.dataset.hanseXterm = "script";
      script.dataset.hanseXtermOrder = String(TERMINAL_SCRIPTS.indexOf(src));
      doc.head.appendChild(script);
      try {
        await loadScript(script);
      } catch (error) {
        script.remove();
        throw error;
      }
      alreadyLoaded.add(src);
    }
    if (stylePromise !== undefined) {
      await stylePromise;
    }
    return readGlobals(doc);
  })();
  cached = promise;
  cachedDocument = doc;
  promise.catch(() => {
    if (cached === promise) {
      cached = undefined;
      cachedDocument = undefined;
    }
  });
  return promise;
}

/** Test-only reset; also removes the nodes the loader created in the current document. */
export function resetTerminalAssetsForTests(doc: Document = document): void {
  cached = undefined;
  cachedDocument = undefined;
  for (const node of doc.querySelectorAll(SCRIPT_SELECTOR)) {
    node.remove();
  }
  for (const node of doc.querySelectorAll('link[data-hanse-xterm="style"]')) {
    node.remove();
  }
}
