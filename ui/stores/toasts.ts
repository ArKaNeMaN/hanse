import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastTone = "success" | "error";

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
}

const SUCCESS_DISMISS_MS = 6000;

/** Client-owned toasts. On SPA documents `assets/app-content.js` is not loaded. */
export const useToastStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  function dismiss(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function push(message: string, tone: ToastTone = "success"): number {
    const id = nextId++;
    toasts.value = [...toasts.value, { id, message, tone }];
    if (tone === "success") {
      timers.set(
        id,
        setTimeout(() => dismiss(id), SUCCESS_DISMISS_MS),
      );
    }
    return id;
  }

  function clear(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    toasts.value = [];
  }

  return { toasts, push, dismiss, clear };
});
