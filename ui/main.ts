import { VueQueryPlugin } from "@tanstack/vue-query";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { alreadyReloaded, clearReloadGuard, markReloaded } from "./api.js";
import { readBoot } from "./boot.js";
import { installChrome } from "./composables/useChrome.js";
import { router } from "./router.js";
import { useChromeStore } from "./stores/chrome.js";

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
  link.href = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  link.textContent = "Reload the page";

  box.append(overline, title, body, link);
  main.append(box);
  main.focus({ preventScroll: true });
}

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  if (!alreadyReloaded()) {
    markReloaded();
    window.location.reload();
    return;
  }
  renderFallback("The page code could not be loaded.");
});

const boot = readBoot();
if (boot === undefined) {
  renderFallback("The page data could not be read.");
} else {
  const main = document.getElementById("main");
  if (main === null) {
    renderFallback("The page shell is missing.");
  } else {
    const app = createApp(App, { boot });
    app.use(createPinia());
    app.use(VueQueryPlugin);
    useChromeStore().initialize(boot);
    installChrome(router);
    app.use(router);
    app.mount(main);
    clearReloadGuard();
  }
}
