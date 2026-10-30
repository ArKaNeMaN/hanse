import type { RouteId } from "../src/shared/routes.js";

/**
 * The resolved boot route set. `ui/boot.ts` validates the server payload and `ui/main.ts` installs
 * it before the router mounts; `SmartLink` and the router guard are the only consumers.
 */
let installed: ReadonlySet<RouteId> = new Set();

export function installSpaRoutes(ids: readonly RouteId[]): void {
  installed = new Set(ids);
}

export function installedSpaRoutes(): ReadonlySet<RouteId> {
  return installed;
}
