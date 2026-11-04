/**
 * Per-application accordion state for the application page.
 *
 * Open group ids are stored as a JSON array under one key per project+app, so each application
 * remembers its own collapsed/expanded groups. Missing or malformed storage means every group is
 * closed; a read failure must never break the page, so storage errors fall back to in-memory state.
 */

import { computed, type Ref, ref, watch } from "vue";

function readOpenIds(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

export function useAppGroups(projectId: Ref<string>, appKey: Ref<string>) {
  const storageKey = computed(
    () =>
      `hanse:ui:app-groups:${encodeURIComponent(projectId.value)}:${encodeURIComponent(appKey.value)}`,
  );
  const openIds = ref<Set<string>>(new Set());

  watch(
    storageKey,
    (key) => {
      openIds.value = readOpenIds(key);
    },
    { immediate: true },
  );

  function persist(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey.value, JSON.stringify([...openIds.value]));
    } catch {
      // Quota or security errors leave the in-memory state as the source of truth.
    }
  }

  function isOpen(id: string): boolean {
    return openIds.value.has(id);
  }

  function setOpen(id: string, open: boolean): void {
    const next = new Set(openIds.value);
    if (open) {
      next.add(id);
    } else {
      next.delete(id);
    }
    openIds.value = next;
    persist();
  }

  function toggle(id: string): void {
    setOpen(id, !isOpen(id));
  }

  return { storageKey, isOpen, setOpen, toggle };
}
