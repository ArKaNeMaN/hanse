import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type ThemeName = "dark" | "light";

function currentTheme(): ThemeName {
  if (typeof document === "undefined") {
    return "dark";
  }
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Theme state mirrors the pre-paint inline script and persists the operator's choice. */
export const useThemeStore = defineStore("theme", () => {
  const theme = ref<ThemeName>(currentTheme());
  const nextTheme = computed<ThemeName>(() => (theme.value === "light" ? "dark" : "light"));
  const label = computed(() => (theme.value === "light" ? "Dark" : "Light"));
  const ariaLabel = computed(() =>
    theme.value === "light" ? "Switch to dark theme" : "Switch to light theme",
  );

  function apply(next: ThemeName): void {
    theme.value = next;
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = next;
    }
    try {
      localStorage.setItem("hanse-theme", next);
    } catch {
      // Storage may be unavailable in hardened browser modes; the in-memory theme still applies.
    }
  }

  function toggle(): void {
    apply(nextTheme.value);
  }

  return { theme, nextTheme, label, ariaLabel, apply, toggle };
});
