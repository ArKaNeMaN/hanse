/**
 * Reactive revision for the app theme.
 *
 * The theme store writes `data-theme` on `<html>`; this module observes that single attribute and
 * exposes a counter. Markdown consumers watch it and re-render diagrams with the new tokens.
 */
import { type Ref, ref } from "vue";

const revision = ref(0);
let observer: MutationObserver | null = null;

function ensureObserver(): void {
  if (
    observer !== null ||
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return;
  }
  observer = new MutationObserver(() => {
    revision.value += 1;
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

export function useThemeRevision(): Ref<number> {
  ensureObserver();
  return revision;
}
