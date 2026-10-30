import { onBeforeUnmount, onMounted } from "vue";

export const DEFAULT_VIEWPORT = "width=device-width, initial-scale=1";

function main(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("main");
}

function viewportMeta(): HTMLMetaElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  return document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
}

/** Apply the workspace route's page class and viewport to the shared shell. */
export function applyWorkspaceShell(pageClass: string, viewport?: string): void {
  const element = main();
  if (element !== null) {
    element.classList.add(...pageClass.split(/\s+/).filter((entry) => entry.length > 0));
  }
  if (viewport !== undefined) {
    viewportMeta()?.setAttribute("content", viewport);
  }
}

/** Restore the default page class/viewport when the workspace route unmounts. */
export function restoreWorkspaceShell(pageClass: string, viewport?: string): void {
  const element = main();
  if (element !== null) {
    element.classList.remove(...pageClass.split(/\s+/).filter((entry) => entry.length > 0));
  }
  if (viewport !== undefined) {
    viewportMeta()?.setAttribute("content", DEFAULT_VIEWPORT);
  }
}

/**
 * Applied by a chat/terminal route component on mount and restored on leave. The route component
 * still owns its runtime `.page__body--chat/--terminal` root; this composable mirrors only `#main`
 * and the viewport meta.
 */
export function useWorkspaceShell(pageClass: string, viewport?: string): void {
  onMounted(() => applyWorkspaceShell(pageClass, viewport));
  onBeforeUnmount(() => restoreWorkspaceShell(pageClass, viewport));
}
