import { onBeforeUnmount, onMounted, type Ref, ref } from "vue";

export interface UseSectionNavOptions {
  /** Scroll container; defaults to the shell's `#main` landmark. */
  readonly root?: () => HTMLElement | null;
  /** Sticky section nav whose height is the offset for anchored sections. */
  readonly nav?: () => HTMLElement | null;
}

const GAP = 8;
const EDGE_TOLERANCE = 1;

function defaultRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("main");
}

function defaultNav(): HTMLElement | null {
  return typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-section-nav]");
}

function sectionElement(id: string): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById(id);
}

/**
 * Tracks the current section of a same-page section nav.
 *
 * The shell scrolls `#main`, so the spy listens there (passive) plus window resize. There is no
 * timer and no polling; `onBeforeUnmount` removes every listener, so a route remount cannot leave
 * a duplicate behind.
 */
export function useSectionNav(
  sectionIds: readonly string[],
  options: UseSectionNavOptions = {},
): {
  readonly activeId: Ref<string>;
  readonly activate: (id: string) => void;
  readonly sync: () => void;
} {
  const activeId = ref(sectionIds[0] ?? "");
  const resolveRoot = options.root ?? defaultRoot;
  const resolveNav = options.nav ?? defaultNav;
  let root: HTMLElement | null = null;

  function scrollOffset(): number {
    return (resolveNav()?.offsetHeight ?? 0) + GAP;
  }

  function sync(): void {
    if (root === null || sectionIds.length === 0) {
      return;
    }
    const reachable = root.scrollHeight - root.clientHeight;
    if (reachable <= 0) {
      activeId.value = sectionIds[0] ?? "";
      return;
    }
    if (root.scrollTop >= reachable - EDGE_TOLERANCE) {
      activeId.value = sectionIds[sectionIds.length - 1] ?? activeId.value;
      return;
    }
    const threshold = root.getBoundingClientRect().top + scrollOffset() + EDGE_TOLERANCE;
    let next = sectionIds[0] ?? "";
    for (const id of sectionIds) {
      const section = sectionElement(id);
      if (section !== null && section.getBoundingClientRect().top <= threshold) {
        next = id;
      }
    }
    activeId.value = next;
  }

  function activate(id: string): void {
    if (!sectionIds.includes(id)) {
      return;
    }
    activeId.value = id;
    const section = sectionElement(id);
    if (root === null || section === null) {
      return;
    }
    const top =
      section.getBoundingClientRect().top -
      root.getBoundingClientRect().top +
      root.scrollTop -
      scrollOffset();
    root.scrollTop = Math.max(0, top);
  }

  function onScroll(): void {
    sync();
  }

  onMounted(() => {
    root = resolveRoot();
    root?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    sync();
  });

  onBeforeUnmount(() => {
    root?.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    root = null;
  });

  return { activeId, activate, sync };
}
