import { VueQueryPlugin } from "@tanstack/vue-query";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { readBoot } from "./boot.js";
import { installChrome } from "./composables/useChrome.js";
import { router } from "./router.js";
import { installSpaRoutes } from "./spa-routes.js";
import { clearTopbarActions } from "./topbar.js";

const PRELOAD_RELOAD_KEY = "hanse-ui-preload-reloaded";
let preloadReloadAttempted = false;

/**
 * Safe runtime fallback. Every value is written with `textContent`; no boot or error string is
 * ever interpolated as HTML.
 */
function renderFallback(message: string): void {
  const main = document.getElementById("main");
  if (main === null) {
    return;
  }

  main.replaceChildren();
  const box = document.createElement("div");
  box.className = "ui-fallback ui-fallback--instant";
  box.id = "ui-fallback";

  const overline = document.createElement("p");
  overline.className = "overline";
  overline.textContent = "Interface";

  const title = document.createElement("h2");
  title.className = "h3";
  title.textContent = "The new interface did not load.";

  const body = document.createElement("p");
  body.className = "body";
  body.textContent = message;

  const link = document.createElement("a");
  link.className = "btn btn-secondary btn-sm";
  link.href = "?legacy=1";
  link.textContent = "Use the classic interface";

  box.append(overline, title, body, link);
  main.append(box);
  main.focus({ preventScroll: true });
}

function alreadyReloaded(): boolean {
  if (preloadReloadAttempted) {
    return true;
  }
  try {
    return sessionStorage.getItem(PRELOAD_RELOAD_KEY) === "1";
  } catch {
    return false;
  }
}

function markReloaded(): void {
  preloadReloadAttempted = true;
  try {
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, "1");
  } catch {
    // Session storage may be unavailable in hardened browser modes; the in-memory flag still
    // prevents a reload loop for this document.
  }
}

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  if (!alreadyReloaded()) {
    markReloaded();
    window.location.reload();
    return;
  }
  renderFallback(
    "The page code could not be loaded. Reload the page or switch to the classic interface.",
  );
});

const boot = readBoot();
if (boot === undefined) {
  renderFallback(
    "The page data could not be read. Reload the page or switch to the classic interface.",
  );
} else {
  const main = document.getElementById("main");
  if (main === null) {
    renderFallback(
      "The page shell is missing. Reload the page or switch to the classic interface.",
    );
  } else {
    const app = createApp(App, { boot });
    app.use(createPinia());
    app.use(VueQueryPlugin);
    installSpaRoutes(boot.spaRoutes);
    installChrome(router);
    // The server fallback is pre-JS only; the App-level TopbarActions owns the container after mount.
    clearTopbarActions();
    app.use(router);
    app.mount(main);
  }
}
