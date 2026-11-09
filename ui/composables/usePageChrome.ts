import { type ComputedRef, computed, onBeforeUnmount, watch } from "vue";
import type { BootPayload, ChromeData } from "../boot.js";
import { useChromeStore } from "../stores/chrome.js";

interface PageQuery<T> {
  readonly data: { readonly value: T | undefined };
  readonly isFetching: { readonly value: boolean };
  readonly enabled?: { readonly value: boolean };
  readonly refetch: () => Promise<unknown>;
}

export interface PageChrome {
  readonly refreshing: ComputedRef<boolean>;
}

/**
 * Apply page chrome with the approved precedence:
 *
 * 1. a response carrying chrome applies it immediately, with no extra request;
 * 2. a route that matches the boot route re-applies the boot chrome when the cached data has none;
 * 3. a different route with data but no chrome forces one refetch;
 * 4. undefined data leaves the query's normal initial fetch alone.
 *
 * The primary refresh is registered with a unique token so an old page unmount cannot clear a newer
 * page's registration.
 */
export function usePageChrome<T extends { readonly chrome?: ChromeData }>(
  query: PageQuery<T>,
  boot: BootPayload,
): PageChrome {
  const store = useChromeStore();
  const token = Symbol("page-chrome");
  let forcedRouteKey: string | undefined;

  function apply(): void {
    // A page mounted before the store is initialized (tests, or an unusual embed) falls back to
    // the boot identity rather than forcing a request against an empty route key.
    const currentRouteKey =
      store.currentRouteKey.length > 0 ? store.currentRouteKey : boot.routeKey;
    const data = query.data.value;
    if (data?.chrome !== undefined) {
      store.setChrome(data.chrome, currentRouteKey);
      return;
    }
    if (currentRouteKey === boot.routeKey) {
      store.setChrome(boot.chrome, currentRouteKey);
      return;
    }
    if (
      data !== undefined &&
      query.enabled?.value !== false &&
      !query.isFetching.value &&
      forcedRouteKey !== currentRouteKey
    ) {
      forcedRouteKey = currentRouteKey;
      void query.refetch();
    }
  }

  watch([() => query.data.value, () => store.currentRouteKey], apply, { immediate: true });

  store.registerPrimaryRefresh({
    token,
    isFetching: () => query.isFetching.value || query.enabled?.value === false,
    refresh: () => query.refetch(),
  });
  onBeforeUnmount(() => store.unregisterPrimaryRefresh(token));

  return { refreshing: computed(() => store.visibilityRefreshing) };
}
