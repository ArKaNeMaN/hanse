import { defineStore } from "pinia";
import { ref } from "vue";
import { announce } from "../announce.js";
import type { BootOperator, BootPayload, ChromeData } from "../boot.js";

export interface PrimaryRefresh {
  readonly token: symbol;
  readonly isFetching: () => boolean;
  readonly refresh: () => Promise<unknown>;
}

/**
 * Route chrome state.
 *
 * `setRouteKey` tracks the URL identity for the current navigation; `setChrome` applies the data
 * for that identity and announces when the title changed or the incoming routeKey has not been
 * announced yet. The boot chrome is retained so a page can re-apply it when returning to the boot
 * route before a cached query carries chrome.
 */
export const useChromeStore = defineStore("chrome", () => {
  const current = ref<ChromeData | undefined>(undefined);
  const bootChrome = ref<ChromeData | undefined>(undefined);
  const bootRouteKey = ref<string | undefined>(undefined);
  const operator = ref<BootOperator | undefined>(undefined);
  const currentRouteKey = ref<string>("");
  const lastAnnouncedRouteKey = ref<string>("");
  const visibilityRefreshing = ref(false);
  const primaryRefresh = ref<PrimaryRefresh | undefined>(undefined);

  function applyTitle(title: string): void {
    if (typeof document !== "undefined") {
      document.title = `${title} - hanse`;
    }
  }

  function initialize(boot: BootPayload): void {
    bootChrome.value = boot.chrome;
    bootRouteKey.value = boot.routeKey;
    operator.value = boot.operator;
    current.value = boot.chrome;
    currentRouteKey.value = boot.routeKey;
    lastAnnouncedRouteKey.value = boot.routeKey;
    applyTitle(boot.chrome.title);
  }

  function setRouteKey(routeKey: string): void {
    currentRouteKey.value = routeKey;
  }

  function setChrome(chrome: ChromeData, routeKey: string): void {
    const titleChanged = current.value?.title !== chrome.title;
    const routeChanged = routeKey !== lastAnnouncedRouteKey.value;
    current.value = chrome;
    currentRouteKey.value = routeKey;
    applyTitle(chrome.title);
    if (titleChanged || routeChanged) {
      announce(chrome.title);
    }
    lastAnnouncedRouteKey.value = routeKey;
  }

  function setProvisionalTitle(title: string): void {
    applyTitle(title);
  }

  function registerPrimaryRefresh(entry: PrimaryRefresh): void {
    primaryRefresh.value = entry;
  }

  function unregisterPrimaryRefresh(token: symbol): void {
    if (primaryRefresh.value?.token === token) {
      primaryRefresh.value = undefined;
    }
  }

  return {
    current,
    bootChrome,
    bootRouteKey,
    operator,
    currentRouteKey,
    lastAnnouncedRouteKey,
    visibilityRefreshing,
    primaryRefresh,
    initialize,
    setRouteKey,
    setChrome,
    setProvisionalTitle,
    registerPrimaryRefresh,
    unregisterPrimaryRefresh,
  };
});
