/**
 * Composer lifecycle: draft persistence, optimistic send/delivery, pending recovery, and abort.
 *
 * Exactly one instance exists per ChatPage mount. It is the only owner of the draft timers,
 * keepalive flushes, send/abort generations, intentional-abort window, and queue-promotion
 * suppression writes through `ui/chat/session-storage.ts`.
 */

import { type ComputedRef, computed, nextTick, onBeforeUnmount, watch } from "vue";
import {
  canSendDraft,
  composerAction,
  draftAutoDeleteEligible,
  draftIsEmpty,
  draftTextForSave,
  isSlashCommandOnly,
  normalizePendingSends,
  type PendingSendView,
} from "../../assets/chat-core.js";
import { type ApiRequestOptions, apiMutation, apiQuery } from "../api.js";
import {
  abortUrl,
  classifySendError,
  deleteIfEmptyUrl,
  draftUrl,
  isAsyncUnavailable,
  isIntentionalAbortEvent,
  isSessionGone,
  localMessageID,
  messagesUrl,
  parseAcceptedMessageID,
  pendingRetryUrl,
  pendingUrl,
  postPrompt,
  sendFailureMessage,
  sessionsUrl,
} from "../chat/send.js";
import {
  blockQueuePromotion,
  queuePromotionAllowed,
  unblockQueuePromotion,
} from "../chat/session-storage.js";
import { useChatComposerStore } from "../stores/chat-composer.js";
import { useChatFeedStore } from "../stores/chat-feed.js";

const DRAFT_SAVE_DEBOUNCE_MS = 500;
const UNKNOWN_GRACE_MS = 1_500;
const DELETE_IF_EMPTY_DEBOUNCE_MS = 1_000;
const ABORT_SETTLE_INTERVAL_MS = 400;
const ABORT_SETTLE_MAX_TICKS = 12;
const ABORT_SUPPRESS_MS = 5_000;
const SESSION_WAIT_MS = 300;

interface DraftResponse {
  readonly text?: unknown;
  readonly pendingSends?: unknown;
  readonly updatedAt?: unknown;
}

export interface UseChatComposerOptions {
  readonly app: ComputedRef<string> | { readonly value: string };
  readonly project: ComputedRef<string> | { readonly value: string };
  readonly sessionID: ComputedRef<string | null> | { readonly value: string | null };
  readonly stopped: ComputedRef<boolean> | { readonly value: boolean };
  readonly deletionPending: ComputedRef<boolean> | { readonly value: boolean };
  readonly selectSession: (sessionID: string) => void;
  readonly hasHistory: () => boolean;
  readonly refreshMessages: (sessionID: string) => Promise<void> | void;
  readonly onSessionGone: (sessionID: string) => void;
  readonly onSessionDeleted: (sessionID: string) => void;
  readonly onToast?: (message: string, tone: "success" | "error") => void;
  readonly onSent?: (sessionID: string) => void;
  readonly onUnauthorized?: (nextPath: string) => void;
}

type Timer = ReturnType<typeof setTimeout>;

export function useChatComposer(options: UseChatComposerOptions) {
  const store = useChatComposerStore();
  const feed = useChatFeedStore();
  const draft = computed(() => store.draft);
  const error = computed(() => store.error);
  const delivery = computed(() => store.delivery);
  const pendingSends = computed(() => store.pendingSends);
  const abortPending = computed(() => store.abortPending);
  const acceptance = computed(() => store.acceptance);

  store.bindWorkspace(`${options.app.value}:${options.project.value}`);
  let activeSession = options.sessionID.value;
  store.setSession(activeSession);
  let actionSeq = 0;
  let editSeq = 0;
  let draftTimer: Timer | undefined;
  let unknownGraceTimer: Timer | undefined;
  let deleteEmptyTimer: Timer | undefined;
  let pendingPollTimer: Timer | undefined;
  let pendingPollAttempts = 0;
  let abortSettleTimer: ReturnType<typeof setInterval> | undefined;
  let abortSettleTicks = 0;
  let loadSeq = 0;
  let saveChain: Promise<void> = Promise.resolve();
  let disposed = false;
  const suppressAbortUntil = new Map<string, number>();
  const cleanup: Array<() => void> = [];

  function scope(): { app: string; project: string } {
    return { app: options.app.value, project: options.project.value };
  }

  function authOptions(): ApiRequestOptions {
    return options.onUnauthorized === undefined ? {} : { onUnauthorized: options.onUnauthorized };
  }

  function currentStatusType(): string | undefined {
    const status = feed.thread.agentStatus;
    return status !== null && typeof status.type === "string" ? status.type : undefined;
  }

  function promotionAllowed(statusType = currentStatusType()): boolean {
    const id = options.sessionID.value;
    return id === null ? true : queuePromotionAllowed(scope(), id, statusType);
  }

  const turnActive = computed(() => {
    feed.revision;
    const type = currentStatusType();
    return type === "busy" || type === "retry";
  });

  const hasDraft = computed(() => canSendDraft({ text: store.draft }));
  const action = computed(() =>
    composerAction({
      turnActive: turnActive.value,
      hasDraft: hasDraft.value,
      sessionId: options.sessionID.value,
      acceptanceBusy: store.delivery === "sending" || store.delivery === "unknown",
      abortPending: store.abortPending,
    }),
  );
  const mode = computed<"send" | "stop">(() => action.value.mode);
  const composedDisabled = computed(() => options.stopped.value || options.deletionPending.value);
  const sendDisabled = computed(
    () =>
      composedDisabled.value ||
      store.delivery === "sending" ||
      store.delivery === "unknown" ||
      !hasDraft.value,
  );
  const stopDisabled = computed(() => composedDisabled.value || store.abortPending);
  const showRecovery = computed(
    () =>
      store.delivery === "unknown" && store.acceptance !== null && store.acceptance.exposeRecovery,
  );

  function cancelDraftTimer(): void {
    if (draftTimer !== undefined) {
      clearTimeout(draftTimer);
      draftTimer = undefined;
    }
  }

  function cancelUnknownGrace(): void {
    if (unknownGraceTimer !== undefined) {
      clearTimeout(unknownGraceTimer);
      unknownGraceTimer = undefined;
    }
  }

  function cancelDeleteEmpty(): void {
    if (deleteEmptyTimer !== undefined) {
      clearTimeout(deleteEmptyTimer);
      deleteEmptyTimer = undefined;
    }
  }

  function cancelPendingPoll(): void {
    if (pendingPollTimer !== undefined) {
      clearTimeout(pendingPollTimer);
      pendingPollTimer = undefined;
    }
  }

  function stopAbortSettle(): void {
    if (abortSettleTimer !== undefined) {
      clearInterval(abortSettleTimer);
      abortSettleTimer = undefined;
    }
    abortSettleTicks = 0;
  }

  async function saveNow(
    session: string,
    text: string,
    settings: { readonly keepalive?: boolean; readonly force?: boolean } = {},
  ): Promise<void> {
    const body = draftTextForSave(text);
    const last = store.lastSavedFor(session);
    if (settings.force !== true && last === body) {
      return;
    }
    if (settings.force !== true && body.length === 0 && last === undefined) {
      return;
    }
    if (settings.keepalive === true) {
      if (typeof fetch !== "function") {
        return;
      }
      try {
        await fetch(draftUrl(scope(), session), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: body }),
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
        });
        store.setLastSaved(session, body);
      } catch {
        // Keepalive is best effort during hide/unload.
      }
      return;
    }
    try {
      await apiMutation<{ text?: unknown }>(
        draftUrl(scope(), session),
        { json: { text: body } },
        { method: "PUT", ...authOptions() },
      );
      store.setLastSaved(session, body);
    } catch (caught) {
      if (isSessionGone(caught)) {
        options.onSessionGone(session);
      }
    }
  }

  function queueSave(
    session: string,
    text: string,
    settings: { readonly keepalive?: boolean; readonly force?: boolean } = {},
  ): Promise<void> {
    const run = (): Promise<void> => saveNow(session, text, settings);
    saveChain = saveChain.then(run, run);
    return saveChain;
  }

  function scheduleDraftSave(session: string, text: string): void {
    cancelDraftTimer();
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      if (disposed) {
        return;
      }
      void queueSave(session, text);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }

  async function maybeDeleteEmpty(session: string): Promise<void> {
    if (
      !draftAutoDeleteEligible({
        text: store.draft,
        attachmentCount: 0,
        hasPending: store.pendingSends.length > 0,
        acceptanceBusy: store.delivery === "sending" || store.delivery === "unknown",
        draftLoaded: true,
        hasHistory: options.hasHistory(),
      })
    ) {
      cancelDeleteEmpty();
      return;
    }
    cancelDeleteEmpty();
    deleteEmptyTimer = setTimeout(() => {
      deleteEmptyTimer = undefined;
      void (async () => {
        try {
          const result = await apiMutation<{ deleted?: unknown }>(
            deleteIfEmptyUrl(scope(), session),
            { json: {} },
            authOptions(),
          );
          if (result !== null && typeof result === "object" && result.deleted === true) {
            store.setLastSaved(session, "");
            options.onSessionDeleted(session);
          }
        } catch (caught) {
          if (isSessionGone(caught)) {
            options.onSessionGone(session);
          }
        }
      })();
    }, DELETE_IF_EMPTY_DEBOUNCE_MS);
  }

  function handleInput(text: string): void {
    if (disposed) {
      return;
    }
    store.setDraft(text);
    store.setError(null);
    editSeq += 1;
    const session = options.sessionID.value;
    if (session === null) {
      cancelDraftTimer();
      return;
    }
    if (isSlashCommandOnly(text)) {
      cancelDraftTimer();
      return;
    }
    if (draftIsEmpty({ text })) {
      cancelDraftTimer();
      cancelDeleteEmpty();
      void queueSave(session, "").then(() => maybeDeleteEmpty(session));
      return;
    }
    cancelDeleteEmpty();
    scheduleDraftSave(session, text);
  }

  function flushForSwitch(session = store.sessionID ?? options.sessionID.value): void {
    if (session === null) {
      return;
    }
    cancelDraftTimer();
    const text = store.draft;
    void queueSave(session, text);
  }

  async function loadDraft(
    session: string,
    settings: { readonly applyText?: boolean } = {},
  ): Promise<DraftResponse | null> {
    if (session.length === 0 || options.stopped.value) {
      return null;
    }
    const seq = ++loadSeq;
    store.setSession(session);
    const expectedEdit = editSeq;
    try {
      const data = await apiQuery<DraftResponse>(draftUrl(scope(), session), authOptions());
      if (disposed || seq !== loadSeq || options.sessionID.value !== session) {
        return null;
      }
      const pending = normalizePendingSends(data.pendingSends);
      store.setPending(pending);
      const text = typeof data.text === "string" ? data.text : "";
      store.setLastSaved(session, draftTextForSave(text));
      if (settings.applyText !== false && expectedEdit === editSeq) {
        store.setDraft(text);
      }
      schedulePendingPoll(session);
      return data;
    } catch (caught) {
      if (isSessionGone(caught)) {
        options.onSessionGone(session);
      }
      return null;
    }
  }

  function schedulePendingPoll(session: string): void {
    const unresolved = store.pendingSends.some(
      (entry) => entry.state === "sending" || entry.state === "unknown",
    );
    if (!unresolved) {
      cancelPendingPoll();
      pendingPollAttempts = 0;
      return;
    }
    if (pendingPollTimer !== undefined || pendingPollAttempts >= 8) {
      return;
    }
    pendingPollTimer = setTimeout(() => {
      pendingPollTimer = undefined;
      pendingPollAttempts += 1;
      if (options.sessionID.value === session) {
        void loadDraft(session, { applyText: false });
      }
    }, 2_000);
  }

  function resetTransientState(): void {
    store.setError(null);
    store.clearAcceptance();
    store.setPending([]);
    store.setAbortPending(false);
  }

  async function handleSessionChange(previous: string | null, next: string | null): Promise<void> {
    actionSeq += 1;
    cancelDraftTimer();
    cancelUnknownGrace();
    cancelDeleteEmpty();
    cancelPendingPoll();
    stopAbortSettle();
    pendingPollAttempts = 0;
    if (previous !== null && previous !== next) {
      flushForSwitch(previous);
    }
    store.setSession(next);
    resetTransientState();
    editSeq += 1;
    store.setDraft("");
    if (next === null) {
      return;
    }
    await loadDraft(next);
  }

  function scheduleUnknownGrace(session: string): void {
    cancelUnknownGrace();
    unknownGraceTimer = setTimeout(() => {
      unknownGraceTimer = undefined;
      if (
        !disposed &&
        options.sessionID.value === session &&
        store.delivery === "unknown" &&
        store.acceptance !== null
      ) {
        store.exposeRecovery(true);
      }
    }, UNKNOWN_GRACE_MS);
  }

  async function waitForSession(sessionID: string): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if (options.sessionID.value === sessionID && feed.thread.sessionID === sessionID) {
        return true;
      }
      if (Date.now() - started > SESSION_WAIT_MS) {
        return options.sessionID.value === sessionID;
      }
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function createSession(): Promise<string | null> {
    try {
      const created = await apiMutation<{ id?: unknown }>(
        sessionsUrl(scope()),
        { json: {} },
        authOptions(),
      );
      const id = typeof created.id === "string" && created.id.length > 0 ? created.id : null;
      if (id === null) {
        return null;
      }
      options.selectSession(id);
      await waitForSession(id);
      return id;
    } catch (caught) {
      store.setError(sendFailureMessage(caught));
      return null;
    }
  }

  async function send(): Promise<boolean> {
    if (disposed || options.stopped.value || options.deletionPending.value) {
      return false;
    }
    if (store.inFlight) {
      return false;
    }
    const text = store.draft;
    if (!canSendDraft({ text })) {
      return false;
    }
    const seq = ++actionSeq;
    cancelUnknownGrace();
    cancelDraftTimer();
    cancelDeleteEmpty();
    store.setAbortPending(false);
    stopAbortSettle();
    store.setDelivery("sending");
    store.setError(null);
    const restore = text;
    let session = options.sessionID.value;
    let tempID: string | null = null;
    try {
      if (session === null) {
        session = await createSession();
        if (session === null || seq !== actionSeq) {
          store.clearAcceptance();
          store.setDraft(restore);
          return false;
        }
      }
      await queueSave(session, text);
      if (seq !== actionSeq || options.sessionID.value !== session) {
        store.clearAcceptance();
        return false;
      }
      const ready = await waitForSession(session);
      if (!ready || seq !== actionSeq) {
        store.clearAcceptance();
        return false;
      }
      tempID = localMessageID();
      feed.insertOptimisticMessage({ id: tempID, text });
      store.beginAcceptance({ tempID, text, sessionID: session });
      store.setDraft("");
      store.setLastSaved(session, "");
      let response: unknown;
      try {
        response = await postPrompt(messagesUrl(scope(), session, true), text, authOptions());
      } catch (caught) {
        if (isAsyncUnavailable(caught)) {
          response = await postPrompt(messagesUrl(scope(), session, false), text, authOptions());
        } else {
          throw caught;
        }
      }
      if (seq !== actionSeq || options.sessionID.value !== session) {
        return false;
      }
      const serverID = parseAcceptedMessageID(response);
      if (serverID === null) {
        const unknown = new TypeError("Delivery unknown; checking…");
        throw unknown;
      }
      store.setServerID(serverID);
      feed.rekeyOptimistic({
        tempID,
        serverID,
        sessionStatusType: currentStatusType(),
        allowPromotion: promotionAllowed(),
      });
      const queued = feed.recomputeQueue().queuedIDs.includes(serverID);
      store.setAcceptanceState(queued ? "queued" : "accepted");
      if (!queued) {
        feed.clearOptimisticState(serverID);
      }
      unblockQueuePromotion(scope(), session);
      store.setLastSaved(session, "");
      forwardSent(session);
      return true;
    } catch (caught) {
      if (seq !== actionSeq) {
        return false;
      }
      const failure = classifySendError(caught);
      if (failure.kind === "auth") {
        return false;
      }
      if (failure.kind === "session_gone") {
        if (tempID !== null) {
          feed.removeMessage(tempID);
        }
        store.clearAcceptance();
        options.onSessionGone(session ?? "");
        return false;
      }
      if (failure.kind === "unknown") {
        if (tempID !== null && failure.messageID !== null) {
          feed.rekeyOptimistic({
            tempID,
            serverID: failure.messageID,
            sessionStatusType: currentStatusType(),
            allowPromotion: promotionAllowed(),
          });
          feed.setOptimisticState(failure.messageID, "unknown");
        } else if (tempID !== null) {
          feed.setOptimisticState(tempID, "unknown");
        }
        store.markUnknown(failure.messageID);
        if (session !== null) {
          scheduleUnknownGrace(session);
          void loadDraft(session, { applyText: false });
          void options.refreshMessages(session);
        }
        return true;
      }
      if (tempID !== null) {
        feed.removeMessage(tempID);
      }
      store.clearAcceptance();
      store.setDelivery("failed");
      store.setError(failure.message);
      store.setDraft(restore);
      if (session !== null) {
        store.setLastSaved(session, draftTextForSave(restore));
        scheduleDraftSave(session, restore);
      }
      return false;
    }
  }

  function forwardSent(session: string): void {
    options.onSent?.(session);
  }

  async function checkAgain(): Promise<void> {
    const session = options.sessionID.value;
    const current = store.acceptance;
    if (session === null || current === null || current.state !== "unknown") {
      return;
    }
    cancelUnknownGrace();
    store.exposeRecovery(false);
    await options.refreshMessages(session);
    await loadDraft(session, { applyText: false });
    if (disposed || options.sessionID.value !== session) {
      return;
    }
    const target = current.serverID ?? current.tempID;
    const record = target === null ? undefined : feed.thread.messages.get(target);
    if (target !== null && record !== undefined && record.optimistic === undefined) {
      store.setServerID(target);
      store.setAcceptanceState("accepted");
      store.setError(null);
      return;
    }
    if (target !== null && record !== undefined && record.optimistic === "accepted") {
      feed.clearOptimisticState(target);
      store.setServerID(target);
      store.setAcceptanceState("accepted");
      store.setError(null);
      return;
    }
    store.exposeRecovery(true);
    store.setError("Delivery is still unknown. Retry after the agent reconnects.");
  }

  function removeUnknown(): void {
    const current = store.acceptance;
    if (current === null) {
      return;
    }
    const target = current.serverID ?? current.tempID;
    if (target !== null) {
      feed.removeMessage(target);
    }
    const pending = store.pendingSends.find(
      (entry) => entry.messageID !== null && entry.messageID === current.serverID,
    );
    if (pending !== undefined) {
      void dismissPending(pending, { silent: true });
    }
    cancelUnknownGrace();
    store.clearAcceptance();
    store.setError(null);
  }

  async function retryPending(entry: PendingSendView): Promise<void> {
    const session = options.sessionID.value;
    if (session === null || store.inFlight) {
      return;
    }
    store.setError(null);
    try {
      const result = await apiMutation<{
        rechecking?: unknown;
        confirmed?: unknown;
        retried?: unknown;
      }>(
        pendingRetryUrl(scope(), session, entry.id),
        { json: entry.state === "unknown" ? { force: true } : {} },
        authOptions(),
      );
      if (result !== null && typeof result === "object" && result.rechecking === true) {
        schedulePendingPoll(session);
        options.onToast?.("Checking delivery again.", "success");
        return;
      }
      options.onToast?.(
        result !== null && typeof result === "object" && result.confirmed === true
          ? "The original message was delivered."
          : "Message retried.",
        "success",
      );
      await options.refreshMessages(session);
      await loadDraft(session, { applyText: false });
    } catch (caught) {
      store.setError(sendFailureMessage(caught));
      options.onToast?.(sendFailureMessage(caught), "error");
    }
  }

  async function dismissPending(
    entry: PendingSendView,
    settings: { readonly silent?: boolean } = {},
  ): Promise<void> {
    const session = options.sessionID.value;
    if (session === null) {
      return;
    }
    try {
      await apiMutation(
        pendingUrl(scope(), session, entry.id),
        { json: entry.state === "unknown" ? { force: true } : {} },
        { method: "DELETE", ...authOptions() },
      );
      store.removePending(entry.id);
      if (settings.silent !== true) {
        options.onToast?.("Pending message dismissed.", "success");
      }
      await loadDraft(session, { applyText: false });
    } catch (caught) {
      store.setError(sendFailureMessage(caught));
      if (settings.silent !== true) {
        options.onToast?.(sendFailureMessage(caught), "error");
      }
    }
  }

  async function restorePending(entry: PendingSendView): Promise<void> {
    handleInput(entry.text);
    await dismissPending(entry, { silent: true });
    options.onToast?.("Failed message restored to the composer.", "success");
  }

  function settleAbort(session: string): void {
    stopAbortSettle();
    if (options.sessionID.value === session) {
      store.setAbortPending(false);
      feed.setAgentStatus({ type: "idle" });
      feed.settleIdle();
    }
  }

  function startAbortSettle(session: string, seq: number): void {
    stopAbortSettle();
    abortSettleTimer = setInterval(() => {
      if (disposed || seq !== actionSeq || options.sessionID.value !== session) {
        stopAbortSettle();
        return;
      }
      abortSettleTicks += 1;
      const type = currentStatusType();
      if (type !== "busy" && type !== "retry") {
        settleAbort(session);
        return;
      }
      if (abortSettleTicks >= ABORT_SETTLE_MAX_TICKS) {
        settleAbort(session);
        store.setError("Stopped; status is reconciling.");
      }
    }, ABORT_SETTLE_INTERVAL_MS);
  }

  async function stop(): Promise<void> {
    const session = options.sessionID.value;
    if (disposed || session === null || store.abortPending) {
      return;
    }
    const seq = ++actionSeq;
    cancelUnknownGrace();
    const sending = store.acceptance;
    store.setAbortPending(true);
    store.setError(null);
    suppressAbortUntil.set(session, Date.now() + ABORT_SUPPRESS_MS);
    try {
      const result = await apiMutation<{ aborted?: unknown }>(
        abortUrl(scope(), session),
        { json: {} },
        authOptions(),
      );
      if (seq !== actionSeq) {
        return;
      }
      if (result !== null && typeof result === "object" && result.aborted === true) {
        blockQueuePromotion(scope(), session);
        if (sending !== null && sending.state === "sending" && sending.sessionID === session) {
          const target = sending.serverID ?? sending.tempID;
          if (target !== null) {
            feed.removeMessage(target);
          }
          store.setDraft(sending.text);
          scheduleDraftSave(session, sending.text);
        }
        store.clearAcceptance();
        startAbortSettle(session, seq);
        return;
      }
      store.setAbortPending(false);
      unblockQueuePromotion(scope(), session);
      suppressAbortUntil.delete(session);
      store.setError("The turn was already idle.");
    } catch (caught) {
      if (seq !== actionSeq) {
        return;
      }
      store.setAbortPending(false);
      unblockQueuePromotion(scope(), session);
      suppressAbortUntil.delete(session);
      store.setError(
        caught instanceof Error && caught.message.trim().length > 0
          ? caught.message
          : "Could not stop the turn.",
      );
    }
  }

  function shouldSuppressAbort(event: {
    name?: unknown;
    message?: unknown;
    sessionID?: unknown;
  }): boolean {
    if (typeof event.sessionID !== "string") {
      return false;
    }
    const until = suppressAbortUntil.get(event.sessionID);
    if (until !== undefined && Date.now() <= until) {
      return true;
    }
    return isIntentionalAbortEvent(event);
  }

  function noteAgentStatus(sessionID: string, type: string | undefined): void {
    if (sessionID !== options.sessionID.value) {
      return;
    }
    if (type === "idle") {
      store.setAbortPending(false);
      stopAbortSettle();
      return;
    }
    if ((type === "busy" || type === "retry") && !store.abortPending) {
      unblockQueuePromotion(scope(), sessionID);
      suppressAbortUntil.delete(sessionID);
      stopAbortSettle();
    }
  }

  function keepaliveFlush(deleteEmpty: boolean): void {
    const session = options.sessionID.value;
    if (session === null) {
      return;
    }
    cancelDraftTimer();
    void saveNow(session, store.draft, { keepalive: true });
    if (
      deleteEmpty &&
      draftAutoDeleteEligible({
        text: store.draft,
        hasPending: store.pendingSends.length > 0,
        acceptanceBusy: store.delivery === "sending" || store.delivery === "unknown",
        draftLoaded: true,
        hasHistory: options.hasHistory(),
      })
    ) {
      try {
        void fetch(deleteIfEmptyUrl(scope(), session), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
        });
      } catch {
        // Best effort during unload.
      }
    }
  }

  function onPageHide(): void {
    keepaliveFlush(true);
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      keepaliveFlush(false);
    }
  }

  function addListener(target: Window | Document, event: string, listener: EventListener): void {
    if (typeof target.addEventListener !== "function") {
      return;
    }
    target.addEventListener(event, listener);
    cleanup.push(() => target.removeEventListener(event, listener));
  }

  feed.setQueuePromotionGuard((statusType) => promotionAllowed(statusType));
  if (typeof window !== "undefined") {
    addListener(window, "pagehide", onPageHide);
    addListener(document, "visibilitychange", onVisibilityChange);
  }

  watch(
    () => options.sessionID.value,
    (next) => {
      if (next === activeSession) {
        return;
      }
      const previous = activeSession;
      activeSession = next;
      void handleSessionChange(previous, next);
    },
  );
  if (activeSession !== null) {
    void loadDraft(activeSession);
  }

  onBeforeUnmount(() => {
    disposed = true;
    flushForSwitch();
    cancelDraftTimer();
    cancelUnknownGrace();
    cancelDeleteEmpty();
    cancelPendingPoll();
    stopAbortSettle();
    for (const remove of cleanup.splice(0)) {
      remove();
    }
    feed.setQueuePromotionGuard(null);
    store.reset();
  });

  return {
    draft,
    error,
    delivery,
    pendingSends,
    abortPending,
    acceptance,
    turnActive,
    mode,
    sendDisabled,
    stopDisabled,
    showRecovery,
    handleInput,
    flushForSwitch,
    send,
    stop,
    checkAgain,
    removeUnknown,
    retryPending,
    dismissPending,
    restorePending,
    shouldSuppressAbort,
    noteAgentStatus,
    promotionAllowed,
    reloadDraft: loadDraft,
  };
}
