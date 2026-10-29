import { type ComputedRef, computed, onUnmounted, ref, watch } from "vue";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { AppImageLive, AppImageProps } from "../app-types.js";
import { useToastStore } from "../stores/toasts.js";

export type AppImageAction = "build" | "rollback" | "check";

const POLL_MS = 3_000;

interface ImageCheckResult {
  readonly notice?: string;
  readonly tone?: "success" | "error";
}

interface ImageRollbackResult {
  readonly restarted?: boolean;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error
    ? error.message.length > 0
      ? error.message
      : fallback
    : fallback;
}

/**
 * Port of `assets/images.js` for the SPA image rail.
 *
 * Status/live image reads, build/rollback/check writes, and the 3 s poll while a build is active
 * all use the existing `/api/apps/:app/*` handlers. Logs are fetched only when the disclosure is
 * open, matching the legacy script.
 */
export function useAppImage(
  image: ComputedRef<AppImageProps | undefined>,
  options: { readonly onChanged: () => void | Promise<void> },
) {
  const toasts = useToastStore();
  const live = ref<AppImageLive | null>(null);
  const liveError = ref<string | null>(null);
  const logs = ref("");
  const logsError = ref<string | null>(null);
  const logsOpen = ref(false);
  const busy = ref<AppImageAction | null>(null);

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let statusBusy = false;
  let logsBusy = false;

  const building = computed(() => {
    const current = live.value;
    if (current !== null) {
      return current.state === "building" || current.status === "building";
    }
    return image.value?.building === true;
  });

  function imageHref(): string {
    return image.value?.hrefs.image ?? "";
  }

  function stopPoll(): void {
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  }

  function schedulePoll(): void {
    if (pollTimer !== undefined) return;
    pollTimer = setTimeout(async () => {
      pollTimer = undefined;
      await refreshStatus();
      if (building.value) {
        if (logsOpen.value) await refreshLogs();
        schedulePoll();
      }
    }, POLL_MS);
  }

  async function refreshStatus(): Promise<void> {
    const href = imageHref();
    if (href.length === 0 || statusBusy) return;
    statusBusy = true;
    const wasBuilding = building.value;
    try {
      live.value = await apiQuery<AppImageLive>(href);
      liveError.value = null;
      if (building.value) {
        schedulePoll();
      } else {
        stopPoll();
        if (wasBuilding) {
          await options.onChanged();
          if (logsOpen.value) await refreshLogs();
        }
      }
    } catch (error) {
      liveError.value = errorMessage(error, "Could not refresh image status.");
      if (building.value) {
        schedulePoll();
      } else {
        stopPoll();
      }
    } finally {
      statusBusy = false;
    }
  }

  async function refreshLogs(): Promise<void> {
    const href = image.value?.hrefs.logs ?? "";
    if (href.length === 0 || logsBusy) return;
    logsBusy = true;
    try {
      const data = await apiQuery<{ logs?: string }>(href);
      logs.value = typeof data.logs === "string" ? data.logs : "";
      logsError.value = null;
    } catch (error) {
      logsError.value = errorMessage(error, "Could not refresh build logs.");
    } finally {
      logsBusy = false;
    }
  }

  async function runAction(action: AppImageAction): Promise<void> {
    const current = image.value;
    if (current === undefined || busy.value !== null) return;
    busy.value = action;
    try {
      if (action === "build") {
        await apiMutation(current.hrefs.build, { json: {} });
        toasts.push("Image build started.", "success");
      } else if (action === "rollback") {
        const result = await apiMutation<ImageRollbackResult>(current.hrefs.rollback, { json: {} });
        toasts.push(
          result.restarted === true
            ? "Image rolled back; the agent restarted."
            : "Image rolled back.",
          "success",
        );
      } else {
        const result = await apiMutation<ImageCheckResult>(current.hrefs.check, { json: {} });
        toasts.push(result.notice ?? "Image check complete.", result.tone ?? "success");
      }
      await options.onChanged();
      await refreshStatus();
    } catch (error) {
      const fallback =
        action === "build"
          ? "Could not start the image build."
          : action === "rollback"
            ? "Could not roll back the image."
            : "Could not check the image.";
      toasts.push(errorMessage(error, fallback), "error");
    } finally {
      busy.value = null;
    }
  }

  function setLogsOpen(open: boolean): void {
    logsOpen.value = open;
    if (open) void refreshLogs();
  }

  watch(
    () => image.value?.hrefs.image,
    (href) => {
      if (href !== undefined && href.length > 0) void refreshStatus();
    },
    { immediate: true },
  );

  watch(building, (value) => {
    if (value) {
      logsOpen.value = true;
      void refreshLogs();
    }
  });

  onUnmounted(stopPoll);

  return {
    live,
    liveError,
    logs,
    logsError,
    logsOpen,
    busy,
    building,
    refreshStatus,
    refreshLogs,
    setLogsOpen,
    build: () => runAction("build"),
    rollback: () => runAction("rollback"),
    check: () => runAction("check"),
  };
}
