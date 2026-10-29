/**
 * Application git workbench state, ported from `assets/git.js`.
 *
 * The legacy island fetched `/git/status` on load, ran one mutation at a time, consumed the
 * returned status instead of an extra read, and refreshed the caption without polling the server.
 * This composable keeps that contract: one status read on route entry, on demand, and after an
 * action only when the action response carries no status.
 */

import { computed, onUnmounted, type Ref, ref, watch } from "vue";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { AppGitProps, AppGitSummaryProps } from "../app-types.js";
import {
  actionsHint,
  fallbackGitMessage,
  type GitActionResult,
  type GitControlRules,
  type GitMutation,
  type GitStatus,
  type GitStatusResponse,
  gitActionPath,
  gitControlRules,
  gitErrorDetail,
  summaryFromStatus,
} from "../git-types.js";
import { useToastStore } from "../stores/toasts.js";

export type GitNoticeTone = "success" | "warning" | "error";

export interface GitNotice {
  readonly tone: GitNoticeTone;
  readonly title: string | null;
  readonly message: string;
}

export interface GitLoadFailure {
  readonly title: string;
  readonly message: string;
  readonly outside: boolean;
  readonly locked: boolean;
}

export interface GitCommitError {
  readonly title: string;
  readonly message: string;
}

export interface UseAppGitOptions {
  /** Called after a successful action so the page can refresh props, chrome, and counts. */
  readonly onChanged?: () => void;
}

const BUSY_LABEL: Record<GitMutation, string> = {
  fetch: "Fetching",
  update: "Updating",
  push: "Pushing",
  commit: "Committing",
  switch: "Switching",
};

const EMPTY_SUMMARY: AppGitSummaryProps = {
  loaded: false,
  state: "unavailable",
  message: null,
  branch: null,
  detached: false,
  dirty: false,
  clean: false,
  conflicted: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  lastCommit: null,
};

function hasCommitControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

function loadFailure(error: unknown): GitLoadFailure {
  const outside = error instanceof ApiError && error.code === "outside_workspace";
  const locked = error instanceof ApiError && error.code === "git_locked";
  const title = outside
    ? "Repository path outside the workspace"
    : locked
      ? "Repository is locked"
      : "Repository status unavailable";
  const message = outside
    ? "Git actions are blocked because the registered path is outside the coordinator workspace."
    : locked
      ? "Another git process is using this repository. Wait for it to finish or remove a stale lock."
      : error instanceof Error && error.message.length > 0
        ? error.message
        : "The repository status could not be loaded.";
  return { title, message, outside, locked };
}

export function useAppGit(git: Ref<AppGitProps | undefined>, options: UseAppGitOptions = {}) {
  const toasts = useToastStore();
  const gitStatus = ref<GitStatus | null>(null);
  const loading = ref(false);
  const failure = ref<GitLoadFailure | null>(null);
  const busyAction = ref<GitMutation | null>(null);
  const notice = ref<GitNotice | null>(null);
  const commitDraft = ref("");
  const commitError = ref<GitCommitError | null>(null);
  const needsRefresh = ref(false);
  const liveMessage = ref("");
  const refreshedAt = ref(0);
  const nowTick = ref(Date.now());

  const apiBase = computed(() => git.value?.apiBase ?? "");
  const summary = computed<AppGitSummaryProps>(() => {
    if (gitStatus.value !== null) {
      return summaryFromStatus(gitStatus.value);
    }
    return git.value?.summary ?? EMPTY_SUMMARY;
  });
  const rules = computed<GitControlRules>(() => gitControlRules(gitStatus.value));
  const hint = computed(() =>
    gitStatus.value?.state === "ok" ? actionsHint(gitStatus.value, rules.value) : "",
  );
  const busy = computed(() => busyAction.value !== null);

  const refreshedLabel = computed(() => {
    if (failure.value !== null && gitStatus.value === null) return "Status unavailable";
    if (gitStatus.value === null || refreshedAt.value === 0) return "Loading status";
    const minutes = Math.floor((nowTick.value - refreshedAt.value) / 60_000);
    return minutes < 1 ? "Refreshed just now" : `Refreshed ${minutes}m ago`;
  });

  function applyStatus(next: GitStatus): void {
    gitStatus.value = next;
    refreshedAt.value = Date.now();
    nowTick.value = Date.now();
  }

  function warn(title: string | null, message: string): void {
    notice.value = { tone: "warning", title, message };
    liveMessage.value = message;
  }

  async function readStatusQuiet(): Promise<GitStatus | null> {
    const href = git.value?.statusHref ?? "";
    if (href.length === 0) return null;
    try {
      const data = await apiQuery<GitStatusResponse>(href);
      return data.status ?? null;
    } catch (error) {
      void error;
      return null;
    }
  }

  async function loadStatus(): Promise<void> {
    const href = git.value?.statusHref ?? "";
    if (href.length === 0 || loading.value || busyAction.value !== null) return;
    loading.value = true;
    failure.value = null;
    try {
      const data = await apiQuery<GitStatusResponse>(href);
      if (data.status === undefined || typeof data.status.state !== "string") {
        throw new ApiError("The server returned an unexpected status.", 200, "git_failed");
      }
      applyStatus(data.status);
      liveMessage.value = "Repository status loaded.";
    } catch (error) {
      failure.value = loadFailure(error);
      liveMessage.value = "Repository status could not be loaded.";
    } finally {
      loading.value = false;
    }
  }

  async function runAction(
    action: GitMutation,
    body: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    const base = apiBase.value;
    if (base.length === 0 || busyAction.value !== null || loading.value) return;
    const previous = gitStatus.value;
    busyAction.value = action;
    notice.value = null;
    if (action === "commit") {
      commitError.value = null;
    }
    liveMessage.value = `${BUSY_LABEL[action]}...`;
    try {
      const data = await apiMutation<GitActionResult>(`${base}/${gitActionPath(action)}`, {
        json: body,
      });
      let fresh = data.status;
      if (fresh === null) {
        fresh = await readStatusQuiet();
      }
      if (fresh !== null) {
        applyStatus(fresh);
      }
      if (action === "commit") {
        commitDraft.value = "";
        commitError.value = null;
      }

      const warning =
        typeof data.warning === "string" && data.warning.length > 0
          ? data.warning
          : fresh === null && data.status === null
            ? "Action completed; refresh status."
            : null;
      if (warning !== null) {
        warn("Action completed", warning);
        liveMessage.value = warning;
      } else {
        const message =
          typeof data.message === "string" && data.message.trim().length > 0
            ? data.message
            : fallbackGitMessage(action, data, body, previous);
        notice.value = { tone: "success", title: null, message };
        liveMessage.value = message;
        toasts.push(message, "success");
      }
      options.onChanged?.();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === "unauthenticated" || code === "session_expired") {
        return;
      }
      if (
        (action === "commit" || action === "push") &&
        (code === "network" || code === "timeout")
      ) {
        const refetched = await readStatusQuiet();
        if (refetched !== null) {
          applyStatus(refetched);
        } else {
          needsRefresh.value = true;
        }
      }
      const detail = gitErrorDetail(code, error instanceof Error ? error.message : "", action);
      if (action === "commit") {
        commitError.value = { title: detail.title, message: detail.message };
      } else {
        notice.value = { tone: "error", title: detail.title, message: detail.message };
      }
      liveMessage.value = `${detail.title}. ${detail.message}`;
      toasts.push(detail.message, "error");
    } finally {
      busyAction.value = null;
    }
  }

  function submitCommit(): void {
    if (busyAction.value !== null) return;
    const raw = commitDraft.value;
    const message = raw.trim();
    if (message.length === 0) {
      commitError.value = {
        title: "Enter a commit message.",
        message: "A message is required before committing.",
      };
      return;
    }
    if (hasCommitControl(raw)) {
      commitError.value = {
        title: "Check the commit message.",
        message: "Remove control characters before committing.",
      };
      return;
    }
    commitDraft.value = message;
    void runAction("commit", { message });
  }

  function requestSwitch(branch: string): void {
    if (busyAction.value !== null) return;
    if (branch.length === 0) {
      warn("Choose a branch", "Select a local branch to switch to.");
      return;
    }
    const current = gitStatus.value;
    if (
      current !== null &&
      current.state === "ok" &&
      current.branch?.detached !== true &&
      current.branch?.name === branch
    ) {
      warn("Already on this branch", `You are already on ${branch}.`);
      return;
    }
    void runAction("switch", { branch });
  }

  const tick = setInterval(() => {
    nowTick.value = Date.now();
  }, 30_000);
  onUnmounted(() => {
    clearInterval(tick);
  });

  watch(
    apiBase,
    (base, previous) => {
      if (base === previous) return;
      gitStatus.value = null;
      failure.value = null;
      notice.value = null;
      commitError.value = null;
      needsRefresh.value = false;
      commitDraft.value = "";
      refreshedAt.value = 0;
      liveMessage.value = "";
      if (base.length > 0) {
        void loadStatus();
      }
    },
    { immediate: true },
  );

  return {
    gitStatus,
    summary,
    rules,
    hint,
    loading,
    busy,
    busyAction,
    failure,
    notice,
    commitDraft,
    commitError,
    needsRefresh,
    liveMessage,
    refreshedLabel,
    loadStatus,
    runAction,
    submitCommit,
    requestSwitch,
  };
}

export type AppGitState = ReturnType<typeof useAppGit>;
