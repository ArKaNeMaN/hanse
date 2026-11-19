/**
 * Pure mapping between a shared `Target` and the Skills routes.
 *
 * The selector component emits a `Target`; consumers decide how to route or submit it. This helper
 * is client-only and imports no router, DOM, or SFC code so it stays unit-testable in isolation.
 */

import type { Target } from "./target-types.js";

/**
 * Skills has no app-only (`all`) route, so `all` falls back to the global inventory.
 */
export function targetToSkillsHref(target: Target): string {
  switch (target.kind) {
    case "global":
      return "/skills";
    case "all":
      return "/skills";
    case "project":
      return `/projects/${encodeURIComponent(target.projectId)}/skills`;
    case "app":
      return `/projects/${encodeURIComponent(target.projectId)}/apps/${encodeURIComponent(
        target.appKey,
      )}/skills`;
  }
}

/**
 * Two targets are the same when their kind and identity fields match. The `master` flag is a
 * label, not identity: the reserved app is still identified by its project and app key.
 */
export function sameTarget(left: Target, right: Target): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "global":
    case "all":
      return true;
    case "project":
      return right.kind === "project" && left.projectId === right.projectId;
    case "app":
      return (
        right.kind === "app" && left.projectId === right.projectId && left.appKey === right.appKey
      );
  }
}

/** Stable key for list rendering and selection bookkeeping. */
export function targetKey(target: Target): string {
  switch (target.kind) {
    case "global":
      return "global";
    case "all":
      return "all";
    case "project":
      return `project:${target.projectId}`;
    case "app":
      return `app:${target.projectId}/${target.appKey}`;
  }
}
