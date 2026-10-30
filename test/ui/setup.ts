import { ROUTES } from "../../src/shared/routes.js";
import { installSpaRoutes } from "../../ui/spa-routes.js";

// Mirror the resolved default boot route set that `ui/main.ts` installs before mounting. Individual
// tests can replace it (for example the router guard's off-set cases).
installSpaRoutes(ROUTES.filter((route) => route.spa).map((route) => route.id));

/**
 * jsdom gaps used by the incremental SPA migration.
 *
 * The product does not depend on these polyfills; they only keep browser modules testable under
 * jsdom until the Vue components replace them.
 */

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverStub,
    configurable: true,
  });
}

if (typeof HTMLDialogElement !== "undefined") {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
}
