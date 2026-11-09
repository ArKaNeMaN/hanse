import { defineStore } from "pinia";
import { ref } from "vue";
import type { NavActive } from "../boot.js";

function shellElement(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("shell");
}

function navToggle(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector("[data-nav-toggle]");
}

/**
 * Owns the mobile drawer DOM contract. The static document shell provides the toggle, scrim, and
 * close controls; this store is the single writer of `#shell[data-nav]`, the toggle aria state, and
 * `#shell[data-nav-id]`/`data-project-id`.
 */
export const useShellStore = defineStore("shell", () => {
  const open = ref(false);

  function applyNav(next: boolean): void {
    open.value = next;
    const shell = shellElement();
    if (shell !== null) {
      shell.dataset.nav = next ? "open" : "closed";
    }
    const toggle = navToggle();
    if (toggle !== null) {
      toggle.setAttribute("aria-expanded", next ? "true" : "false");
      toggle.setAttribute("aria-label", next ? "Close navigation" : "Open navigation");
    }
    if (next && shell !== null) {
      const first = shell.querySelector(".sidebar .nav-item");
      if (first instanceof HTMLElement) {
        window.setTimeout(() => first.focus(), 0);
      }
    }
  }

  function close(returnFocus = false): void {
    applyNav(false);
    const toggle = navToggle();
    if (returnFocus && toggle instanceof HTMLElement) {
      toggle.focus();
    }
  }

  function openDrawer(): void {
    applyNav(true);
  }

  function toggle(): void {
    applyNav(!open.value);
  }

  function setActive(active: NavActive, activeProjectId?: string): void {
    const shell = shellElement();
    if (shell === null) {
      return;
    }
    shell.dataset.navId = active;
    if (activeProjectId === undefined) {
      delete shell.dataset.projectId;
    } else {
      shell.dataset.projectId = activeProjectId;
    }
  }

  function install(): () => void {
    if (typeof document === "undefined") {
      return () => {};
    }
    const shell = shellElement();
    const toggleControl = navToggle();

    const onToggle = (): void => toggle();
    if (toggleControl !== null) {
      toggleControl.addEventListener("click", onToggle);
    }

    const onShellClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest("[data-nav-close]") !== null) {
        close(true);
        return;
      }
      if (
        target.closest(".sidebar a[href]") !== null &&
        window.matchMedia("(max-width: 1023px)").matches
      ) {
        close(false);
      }
    };
    if (shell !== null) {
      shell.addEventListener("click", onShellClick);
    }

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && open.value) {
        close(true);
      }
    };
    document.addEventListener("keydown", onKeydown);

    const onResize = (): void => {
      if (window.matchMedia("(min-width: 1024px)").matches && open.value) {
        close(false);
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      if (toggleControl !== null) {
        toggleControl.removeEventListener("click", onToggle);
      }
      if (shell !== null) {
        shell.removeEventListener("click", onShellClick);
      }
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("resize", onResize);
    };
  }

  return { open, openDrawer, close, toggle, setActive, install };
});
