/**
 * Pending questions, permission requests, saved permissions, per-request draft/busy/error state,
 * and local tombstones/outcomes.
 *
 * The app-scoped `/prompts` read is the hydration source; live `question.*`/`permission.*` events
 * upsert the same entries. A resolved request is tombstoned locally so a stale hydration cannot
 * resurrect it, and the outcome survives long enough for inline question cards to render
 * "Answered"/"Dismissed"/"Expired". No URL or network access lives here.
 */

import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import type {
  NormalizedPermissionRequest,
  NormalizedQuestion,
  NormalizedQuestionRequest,
  NormalizedSavedPermission,
} from "../../src/opencode/prompts.js";
import type { ChatPromptKind, QuestionOutcome, QuestionOutcomeKind } from "../chat/types.js";

export type PromptEntry =
  | { readonly kind: "question"; readonly request: NormalizedQuestionRequest }
  | { readonly kind: "permission"; readonly request: NormalizedPermissionRequest };

const OUTCOME_TTL_MS = 10 * 60 * 1000;

export function promptCorrelationKey(
  request: NormalizedQuestionRequest | NormalizedPermissionRequest,
): string | null {
  const tool = request.tool;
  if (
    tool === undefined ||
    typeof tool.messageID !== "string" ||
    tool.messageID.length === 0 ||
    typeof tool.callID !== "string" ||
    tool.callID.length === 0
  ) {
    return null;
  }
  return `${request.source}:${request.sessionID}:${tool.messageID}:${tool.callID}`;
}

export const useChatPromptsStore = defineStore("chat-prompts", () => {
  const questions = shallowRef<readonly NormalizedQuestionRequest[]>(markRaw([]));
  const permissions = shallowRef<readonly NormalizedPermissionRequest[]>(markRaw([]));
  const savedPermissions = shallowRef<readonly NormalizedSavedPermission[]>(markRaw([]));
  const busy = shallowRef<ReadonlySet<string>>(markRaw(new Set<string>()));
  const errors = shallowRef<ReadonlyMap<string, string>>(markRaw(new Map<string, string>()));
  const outcomes = shallowRef<ReadonlyMap<string, QuestionOutcome>>(
    markRaw(new Map<string, QuestionOutcome>()),
  );
  const tombstones = shallowRef<ReadonlyMap<string, number>>(markRaw(new Map<string, number>()));
  const correlationKeys = shallowRef<ReadonlyMap<string, string>>(
    markRaw(new Map<string, string>()),
  );
  const correlationOutcomes = shallowRef<ReadonlyMap<string, QuestionOutcome>>(
    markRaw(new Map<string, QuestionOutcome>()),
  );
  const toolOutcomes = shallowRef<ReadonlyMap<string, QuestionOutcome>>(
    markRaw(new Map<string, QuestionOutcome>()),
  );
  const hydrated = ref(false);
  const revision = ref(0);

  const entries = computed<readonly PromptEntry[]>(() => [
    ...questions.value.map((request) => ({ kind: "question" as const, request })),
    ...permissions.value.map((request) => ({ kind: "permission" as const, request })),
  ]);

  function bump(): void {
    revision.value += 1;
  }

  function prune(now = Date.now()): void {
    const cutoff = now - OUTCOME_TTL_MS;
    const nextTombstones = new Map(tombstones.value);
    for (const [key, at] of nextTombstones) {
      if (at < cutoff) nextTombstones.delete(key);
    }
    if (nextTombstones.size !== tombstones.value.size) {
      tombstones.value = markRaw(nextTombstones);
    }
    const nextOutcomes = new Map(outcomes.value);
    for (const [key, outcome] of nextOutcomes) {
      if (outcome.at < cutoff) nextOutcomes.delete(key);
    }
    if (nextOutcomes.size !== outcomes.value.size) {
      outcomes.value = markRaw(nextOutcomes);
    }
    const nextCorrelation = new Map(correlationOutcomes.value);
    for (const [key, outcome] of nextCorrelation) {
      if (outcome.at < cutoff) nextCorrelation.delete(key);
    }
    if (nextCorrelation.size !== correlationOutcomes.value.size) {
      correlationOutcomes.value = markRaw(nextCorrelation);
    }
    const nextTool = new Map(toolOutcomes.value);
    for (const [key, outcome] of nextTool) {
      if (outcome.at < cutoff) nextTool.delete(key);
    }
    if (nextTool.size !== toolOutcomes.value.size) {
      toolOutcomes.value = markRaw(nextTool);
    }
  }

  function rememberCorrelation(request: NormalizedQuestionRequest): string | null {
    const correlation = promptCorrelationKey(request);
    if (correlation === null) {
      return null;
    }
    if (correlationKeys.value.get(correlation) !== request.key) {
      const next = new Map(correlationKeys.value);
      next.set(correlation, request.key);
      correlationKeys.value = markRaw(next);
    }
    return correlation;
  }

  function upsert(kind: "question", request: NormalizedQuestionRequest): void;
  function upsert(kind: "permission", request: NormalizedPermissionRequest): void;
  function upsert(
    kind: ChatPromptKind,
    request: NormalizedQuestionRequest | NormalizedPermissionRequest,
  ): void {
    if (tombstones.value.has(request.key)) {
      return;
    }
    if (kind === "question") {
      const question = request as NormalizedQuestionRequest;
      rememberCorrelation(question);
      const nextOutcomes = new Map(outcomes.value);
      nextOutcomes.delete(request.key);
      outcomes.value = markRaw(nextOutcomes);
      if (!questions.value.some((entry) => entry.key === request.key)) {
        questions.value = markRaw([...questions.value, question]);
      }
    } else if (!permissions.value.some((entry) => entry.key === request.key)) {
      permissions.value = markRaw([...permissions.value, request as NormalizedPermissionRequest]);
    }
    bump();
  }

  function removeQuestion(key: string): void {
    if (questions.value.some((entry) => entry.key === key)) {
      questions.value = markRaw(questions.value.filter((entry) => entry.key !== key));
    }
  }

  function removePermission(key: string): void {
    if (permissions.value.some((entry) => entry.key === key)) {
      permissions.value = markRaw(permissions.value.filter((entry) => entry.key !== key));
    }
  }

  function recordOutcome(
    key: string,
    outcome: QuestionOutcome,
    correlation?: string | null,
    tool?: NormalizedQuestionRequest["tool"],
  ): void {
    const nextOutcomes = new Map(outcomes.value);
    nextOutcomes.set(key, outcome);
    outcomes.value = markRaw(nextOutcomes);
    const nextTombstones = new Map(tombstones.value);
    nextTombstones.set(key, Date.now());
    tombstones.value = markRaw(nextTombstones);
    if (correlation !== undefined && correlation !== null) {
      const nextCorrelation = new Map(correlationOutcomes.value);
      nextCorrelation.set(correlation, outcome);
      correlationOutcomes.value = markRaw(nextCorrelation);
    }
    if (
      tool !== undefined &&
      typeof tool.messageID === "string" &&
      typeof tool.callID === "string"
    ) {
      const nextTool = new Map(toolOutcomes.value);
      nextTool.set(`${tool.messageID}:${tool.callID}`, outcome);
      toolOutcomes.value = markRaw(nextTool);
    }
    const nextBusy = new Set(busy.value);
    nextBusy.delete(key);
    busy.value = markRaw(nextBusy);
    const nextErrors = new Map(errors.value);
    nextErrors.delete(key);
    errors.value = markRaw(nextErrors);
  }

  function resolveQuestion(
    requestID: string,
    source: "v1" | "v2",
    kind: QuestionOutcomeKind,
    options: {
      answers?: readonly (readonly string[])[] | null;
      questions?: readonly NormalizedQuestion[];
      reason?: string;
      elsewhere?: boolean;
    } = {},
  ): QuestionOutcome {
    const key = `${source}:${requestID}`;
    const entry = questions.value.find((candidate) => candidate.key === key);
    const questionsForOutcome = options.questions ?? entry?.questions ?? [];
    const outcome: QuestionOutcome = {
      kind,
      at: Date.now(),
      answers: options.answers ?? null,
      questions: questionsForOutcome,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.elsewhere === true ? { elsewhere: true } : {}),
    };
    const correlation = entry === undefined ? null : rememberCorrelation(entry);
    recordOutcome(key, outcome, correlation, entry?.tool);
    removeQuestion(key);
    bump();
    return outcome;
  }

  function resolvePermission(
    requestID: string,
    source: "v1" | "v2",
    outcome: "replied" = "replied",
  ): void {
    const key = `${source}:${requestID}`;
    recordOutcome(key, { kind: "answered", at: Date.now(), elsewhere: outcome === "replied" });
    removePermission(key);
    bump();
  }

  function markBusy(key: string, value: boolean): void {
    const next = new Set(busy.value);
    if (value) next.add(key);
    else next.delete(key);
    busy.value = markRaw(next);
    bump();
  }

  function setError(key: string, message: string | null): void {
    const next = new Map(errors.value);
    if (message === null || message.length === 0) next.delete(key);
    else next.set(key, message);
    errors.value = markRaw(next);
    bump();
  }

  function setSavedPermissions(list: readonly NormalizedSavedPermission[]): void {
    const next = list.filter((permission) => typeof permission.id === "string");
    savedPermissions.value = markRaw([...next]);
    bump();
  }

  function removeSavedPermission(id: string): void {
    savedPermissions.value = markRaw(
      savedPermissions.value.filter((permission) => permission.id !== id),
    );
    bump();
  }

  function hydrate(
    nextQuestions: readonly NormalizedQuestionRequest[],
    nextPermissions: readonly NormalizedPermissionRequest[],
  ): void {
    prune();
    const seenQuestions = questions.value.filter((entry) => tombstones.value.has(entry.key));
    const seenPermissions = permissions.value.filter((entry) => tombstones.value.has(entry.key));
    const mergedQuestions = [...nextQuestions].filter((entry) => !tombstones.value.has(entry.key));
    const mergedPermissions = [...nextPermissions].filter(
      (entry) => !tombstones.value.has(entry.key),
    );
    for (const entry of seenQuestions) {
      if (!mergedQuestions.some((candidate) => candidate.key === entry.key)) {
        mergedQuestions.push(entry);
      }
    }
    for (const entry of seenPermissions) {
      if (!mergedPermissions.some((candidate) => candidate.key === entry.key)) {
        mergedPermissions.push(entry);
      }
    }
    questions.value = markRaw(mergedQuestions);
    permissions.value = markRaw(mergedPermissions);
    for (const question of mergedQuestions) {
      rememberCorrelation(question);
    }
    hydrated.value = true;
    bump();
  }

  function entriesForSession(sessionID: string | null): readonly PromptEntry[] {
    if (sessionID === null) return [];
    return entries.value.filter((entry) => entry.request.sessionID === sessionID);
  }

  function dockEntriesForSession(sessionID: string | null): readonly PromptEntry[] {
    return entriesForSession(sessionID).filter(
      (entry) =>
        entry.kind === "permission" ||
        promptCorrelationKey(entry.request as NormalizedQuestionRequest) === null,
    );
  }

  function needsInputCount(activeSessionID: string | null): number {
    return entries.value.filter((entry) => entry.request.sessionID !== activeSessionID).length;
  }

  function countForSession(sessionID: string): number {
    return entries.value.filter((entry) => entry.request.sessionID === sessionID).length;
  }

  function questionByCorrelation(correlation: string): NormalizedQuestionRequest | undefined {
    const key = correlationKeys.value.get(correlation);
    if (key === undefined) return undefined;
    return questions.value.find((entry) => entry.key === key);
  }

  function questionByToolRef(
    messageID: string,
    callID: string,
  ): NormalizedQuestionRequest | undefined {
    return questions.value.find(
      (entry) =>
        entry.tool !== undefined &&
        entry.tool.messageID === messageID &&
        entry.tool.callID === callID,
    );
  }

  function questionKeyForCorrelation(correlation: string): string | undefined {
    return correlationKeys.value.get(correlation);
  }

  function outcomeFor(key: string): QuestionOutcome | undefined {
    return outcomes.value.get(key);
  }

  function outcomeForCorrelation(correlation: string): QuestionOutcome | undefined {
    return correlationOutcomes.value.get(correlation);
  }

  function outcomeForToolRef(messageID: string, callID: string): QuestionOutcome | undefined {
    return toolOutcomes.value.get(`${messageID}:${callID}`);
  }

  function isBusy(key: string): boolean {
    return busy.value.has(key);
  }

  function errorFor(key: string): string | undefined {
    return errors.value.get(key);
  }

  function clear(): void {
    questions.value = markRaw([]);
    permissions.value = markRaw([]);
    savedPermissions.value = markRaw([]);
    busy.value = markRaw(new Set<string>());
    errors.value = markRaw(new Map<string, string>());
    outcomes.value = markRaw(new Map<string, QuestionOutcome>());
    tombstones.value = markRaw(new Map<string, number>());
    correlationKeys.value = markRaw(new Map<string, string>());
    correlationOutcomes.value = markRaw(new Map<string, QuestionOutcome>());
    toolOutcomes.value = markRaw(new Map<string, QuestionOutcome>());
    hydrated.value = false;
    bump();
  }

  return {
    questions,
    permissions,
    savedPermissions,
    entries,
    hydrated,
    revision,
    promptCorrelationKey,
    prune,
    upsert,
    resolveQuestion,
    resolvePermission,
    markBusy,
    setError,
    setSavedPermissions,
    removeSavedPermission,
    hydrate,
    entriesForSession,
    dockEntriesForSession,
    needsInputCount,
    countForSession,
    questionByCorrelation,
    questionByToolRef,
    questionKeyForCorrelation,
    outcomeFor,
    outcomeForCorrelation,
    outcomeForToolRef,
    isBusy,
    errorFor,
    clear,
  };
});
