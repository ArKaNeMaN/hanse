import type { SettingsScope, SettingsTarget } from "../settings/types.js";
import {
  listMessagePage,
  listProviders,
  listSessionsBounded,
  OpencodeHttpError,
  type OpencodeMessage,
  type OpencodeModel,
  type OpencodeSession,
  summarizeSession,
} from "./client.js";
import { authorizationFor } from "./endpoint-auth.js";
import { APP_STREAM_MAX_FRAME_BYTES, createEventStream, type HanseEvent } from "./events.js";

export const MAX_CONTEXT_SESSIONS = 500;
export const CONTEXT_SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000;
export const MAX_CONTEXT_MESSAGES_PER_SESSION = 512;
export const MAX_CONTEXT_PARTS_PER_SESSION = 512;
export const MAX_CONTEXT_PENDING_STEPS = 128;
export const COMPACTION_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
export const PROVIDER_LIMIT_FAILURE_BACKOFF_MS = 60 * 1000;
export const CHILD_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export type ContextState = "unknown" | "ready" | "compacting";
export type ContextSessionStatus = "idle" | "busy" | "retry" | "unknown";
export type CompactionErrorCode =
  | "compaction_failed"
  | "compaction_timeout"
  | "compaction_unavailable";
export type ContextUsageSource = "step-finish" | "message";

export interface ContextPolicy {
  enabled: boolean;
  percent: number;
  model: string;
  enabledSource: SettingsScope | "default";
  percentSource: SettingsScope | "default";
}

export interface ContextTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
  /** Flat aliases used by the usage-enabled projector. */
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ContextSnapshot {
  sessionID: string;
  state: ContextState;
  used: number | null;
  limit: number | null;
  percent: number | null;
  model: OpencodeModel | null;
  status: ContextSessionStatus;
  topLevel: boolean;
  activeChildren: boolean;
  pendingTask: boolean;
  updatedAt: string;
  lastCompactedAt: string | null;
  lastError: CompactionErrorCode | null;
  autoCompact: {
    enabled: boolean;
    percent: number;
    source: SettingsScope | "default";
    percentSource: SettingsScope | "default";
  };
}

export interface AutoCompactState {
  state: ContextState;
  status: ContextSessionStatus;
  used: number | null;
  limit: number | null;
  model: OpencodeModel | null;
  compacting: boolean;
  topLevel: boolean;
  armed: boolean;
  armKey: string | null;
  failureCooldownUntil: number | null;
  usageAt: number | null;
  lastCompactedAt: number | null;
  postCompactionPending: boolean;
  ineffective: boolean;
  activeChildren?: boolean;
  pendingTask?: boolean;
}

export interface AutoCompactDecision {
  trigger: boolean;
  armed: boolean;
  armKey: string | null;
  failureCooldownUntil: number | null;
  postCompactionPending: boolean;
  ineffective: boolean;
}

/**
 * A projected event as consumed by the tracker. The index signature keeps this
 * assignable from `HanseEvent` without importing the whole event union.
 */
export type ContextEvent = { type: string; [key: string]: unknown };

export interface ProviderLimitModel {
  limit?: { context?: number; input?: number; output?: number };
}

export interface ProviderLimitsPayload {
  providers: Array<{ id: string; models: Record<string, ProviderLimitModel> }>;
}

export interface ProviderModelLimits {
  context: number | null;
  input: number | null;
  output: number | null;
}

interface UsageRecord {
  tokens: ContextTokens;
  used: number;
  model: OpencodeModel;
  messageID: string;
  source: ContextUsageSource;
  at: number;
}

interface MessageMeta {
  role: "user" | "assistant";
  summary: boolean;
  model: OpencodeModel | null;
  finish: string | null;
  stepTokens: ContextTokens | null;
}

interface PartMeta {
  type: string;
  messageID: string;
}

interface SessionRecord {
  usage: UsageRecord | null;
  model: OpencodeModel | null;
  limit: number | null;
  status: ContextSessionStatus;
  compacting: boolean;
  lastError: CompactionErrorCode | null;
  lastAttemptAt: number | null;
  failureCooldownUntil: number | null;
  armed: boolean;
  armKey: string | null;
  ineffective: boolean;
  postCompactionPending: boolean;
  lastCompactedAt: number | null;
  updatedAt: number;
  lastActivityAt: number;
  messages: Map<string, MessageMeta>;
  parts: Map<string, PartMeta>;
  pendingSteps: Map<string, ContextTokens>;
  pendingTaskParts: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSpawnToolName(value: unknown): boolean {
  return value === "task" || value === "call_omo_agent";
}

function spawnToolFromPart(part: Record<string, unknown> | undefined): boolean {
  return part?.type === "tool" && isSpawnToolName(part.tool);
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isSummary(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.length > 0);
}

function parseTokens(value: unknown): ContextTokens | null {
  const raw = asRecord(value);
  if (raw === undefined) return null;
  const cache = asRecord(raw.cache);
  const input = nonNegative(raw.input);
  const output = nonNegative(raw.output);
  const reasoning = nonNegative(raw.reasoning);
  const read = nonNegative(cache?.read) ?? nonNegative(raw.cacheRead);
  const write = nonNegative(cache?.write) ?? nonNegative(raw.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    read === undefined &&
    write === undefined
  ) {
    return null;
  }
  const tokens: ContextTokens = {};
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (reasoning !== undefined) tokens.reasoning = reasoning;
  if (read !== undefined || write !== undefined) {
    const nested: { read?: number; write?: number } = {};
    if (read !== undefined) nested.read = read;
    if (write !== undefined) nested.write = write;
    tokens.cache = nested;
  }
  return tokens;
}

function parseModel(value: Record<string, unknown>): OpencodeModel | null {
  const nested = asRecord(value.model);
  const providerID = asString(nested?.providerID) ?? asString(value.providerID);
  const modelID = asString(nested?.modelID) ?? asString(value.modelID);
  return providerID === undefined || modelID === undefined ? null : { providerID, modelID };
}

function sameModel(left: OpencodeModel | null, right: OpencodeModel | null): boolean {
  if (left === null || right === null) return left === right;
  return left.providerID === right.providerID && left.modelID === right.modelID;
}

function timestamp(value: unknown): number | null {
  const record = asRecord(value);
  const completed = asFinite(record?.completed);
  if (completed !== undefined) return completed;
  const created = asFinite(record?.created);
  return created ?? null;
}

function compareOrder(
  left: { time: number | null; index: number },
  right: { time: number | null; index: number },
): number {
  if (left.time !== null && right.time !== null && left.time !== right.time) {
    return left.time - right.time;
  }
  return left.index - right.index;
}

function orderNewer(
  candidate: { time: number | null; index: number },
  current: { time: number | null; index: number } | null,
): boolean {
  return current === null || compareOrder(candidate, current) > 0;
}

function orderAfter(
  boundary: { time: number | null; index: number } | null,
  usage: { time: number | null; index: number } | null,
): boolean {
  return boundary !== null && usage !== null && compareOrder(boundary, usage) > 0;
}

function autoArmKey(model: OpencodeModel, percent: number): string {
  return `${model.providerID}/${model.modelID}@${percent}`;
}

/** Prompt occupancy is the raw request size: input plus cache reads/writes. */
export function promptTokens(tokens: ContextTokens | null | undefined): number {
  if (tokens === null || tokens === undefined) return 0;
  const input = nonNegative(tokens.input) ?? 0;
  const read = nonNegative(tokens.cache?.read) ?? nonNegative(tokens.cacheRead) ?? 0;
  const write = nonNegative(tokens.cache?.write) ?? nonNegative(tokens.cacheWrite) ?? 0;
  return input + read + write;
}

export function contextPercent(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null) return null;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const percent = Math.round((used / limit) * 100);
  return Number.isFinite(percent) ? percent : null;
}

export function formatContextError(code: CompactionErrorCode): string {
  switch (code) {
    case "compaction_failed":
      return "Compaction failed. Try again.";
    case "compaction_timeout":
      return "Compaction timed out. Try again.";
    case "compaction_unavailable":
      return "Compaction is unavailable until a model and endpoint are available.";
  }
}

/**
 * Pure D6 policy transition. The caller owns side effects; apply the returned
 * latch fields and call `markAutoAttempt` when `trigger` is true.
 */
export function autoCompactDecision(
  state: AutoCompactState,
  policy: ContextPolicy,
  now: number,
): AutoCompactDecision {
  const unchanged: AutoCompactDecision = {
    trigger: false,
    armed: state.armed,
    armKey: state.armKey,
    failureCooldownUntil: state.failureCooldownUntil,
    postCompactionPending: state.postCompactionPending,
    ineffective: state.ineffective,
  };

  if (!policy.enabled) return unchanged;
  if (!state.topLevel || state.status !== "idle") return unchanged;
  if (state.compacting || state.state === "compacting") return unchanged;
  if (state.model === null) return unchanged;
  if (state.limit === null || !Number.isFinite(state.limit) || state.limit <= 0) return unchanged;
  if (state.used === null || !Number.isFinite(state.used) || state.used < 0) return unchanged;
  if (state.activeChildren === true || state.pendingTask === true) return unchanged;
  if (!Number.isFinite(policy.percent)) return unchanged;

  const rawPercent = (state.used / state.limit) * 100;
  const percent = policy.percent;
  const floor = percent <= 5 ? 1 : percent - 5;
  const key = autoArmKey(state.model, percent);

  let armed = state.armed;
  let armKey = state.armKey;
  let failureCooldownUntil = state.failureCooldownUntil;
  let postCompactionPending = state.postCompactionPending;
  let ineffective = state.ineffective;

  if (failureCooldownUntil !== null) {
    if (now < failureCooldownUntil) {
      return {
        trigger: false,
        armed: false,
        armKey,
        failureCooldownUntil,
        postCompactionPending,
        ineffective,
      };
    }
    const firstUsageAfterCooldown = state.usageAt !== null && state.usageAt > failureCooldownUntil;
    if (!firstUsageAfterCooldown) {
      return {
        trigger: false,
        armed: false,
        armKey,
        failureCooldownUntil,
        postCompactionPending,
        ineffective,
      };
    }
    // One retry opportunity bypasses the hysteresis band.
    armed = true;
    armKey = key;
    failureCooldownUntil = null;
    postCompactionPending = false;
    ineffective = false;
  }

  if (armKey === null) {
    // First observation for this session: arm without discarding a pending compaction result.
    armed = true;
    armKey = key;
  } else if (armKey !== key) {
    // Model or threshold changed: clear both latches and arm for the new policy.
    armed = true;
    armKey = key;
    ineffective = false;
    postCompactionPending = false;
  }

  if (
    postCompactionPending &&
    state.lastCompactedAt !== null &&
    state.usageAt !== null &&
    state.usageAt > state.lastCompactedAt
  ) {
    postCompactionPending = false;
    if (rawPercent >= percent) {
      // Compaction did not get below the threshold: latch until the floor or key changes.
      ineffective = true;
      armed = false;
    }
  }

  if (ineffective) {
    if (rawPercent < floor) {
      ineffective = false;
      armed = true;
      armKey = key;
    } else {
      armed = false;
    }
  } else if (rawPercent < floor) {
    armed = true;
    armKey = key;
  }

  const trigger = armed && rawPercent >= percent;
  return {
    trigger,
    armed: trigger ? false : armed,
    armKey,
    failureCooldownUntil,
    postCompactionPending,
    ineffective,
  };
}

function emptyLimits(): ProviderModelLimits {
  return { context: null, input: null, output: null };
}

/** Lazily reads `GET /config/providers` limits; keeps only the three numbers. */
export class ProviderLimitCache {
  readonly #loadProviders: () => Promise<ProviderLimitsPayload>;
  readonly #clock: () => number;
  readonly #limits = new Map<string, ProviderModelLimits>();
  #loaded = false;
  #failureUntil: number | null = null;
  #pending: Promise<void> | null = null;

  constructor(
    loadProviders: () => Promise<ProviderLimitsPayload>,
    now: (() => number) | number = Date.now,
  ) {
    this.#loadProviders = loadProviders;
    this.#clock = typeof now === "function" ? now : () => now;
  }

  async lookup(providerID: string, modelID: string): Promise<ProviderModelLimits> {
    await this.#ensureLoaded();
    const cached = this.#limits.get(`${providerID}\u0000${modelID}`);
    return cached === undefined ? emptyLimits() : { ...cached };
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    if (this.#failureUntil !== null && this.#clock() < this.#failureUntil) return;
    if (this.#pending !== null) {
      await this.#pending;
      return;
    }
    const pending = this.#load();
    this.#pending = pending;
    try {
      await pending;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }

  async #load(): Promise<void> {
    try {
      const payload: unknown = await this.#loadProviders();
      this.#index(payload);
      this.#loaded = true;
      this.#failureUntil = null;
    } catch {
      this.#failureUntil = this.#clock() + PROVIDER_LIMIT_FAILURE_BACKOFF_MS;
    }
  }

  #index(payload: unknown): void {
    const root = asRecord(payload);
    const providers = root?.providers;
    if (!Array.isArray(providers)) return;
    for (const rawProvider of providers) {
      const provider = asRecord(rawProvider);
      const providerID = asString(provider?.id);
      if (providerID === undefined) continue;
      const models = asRecord(provider?.models);
      if (models === undefined) continue;
      for (const [modelID, rawModel] of Object.entries(models)) {
        const model = asRecord(rawModel);
        const limit = asRecord(model?.limit);
        this.#limits.set(`${providerID}\u0000${modelID}`, {
          context: positive(limit?.context) ?? null,
          input: positive(limit?.input) ?? null,
          output: positive(limit?.output) ?? null,
        });
      }
    }
  }
}

function freshRecord(now: number): SessionRecord {
  return {
    usage: null,
    model: null,
    limit: null,
    status: "unknown",
    compacting: false,
    lastError: null,
    lastAttemptAt: null,
    failureCooldownUntil: null,
    armed: false,
    armKey: null,
    ineffective: false,
    postCompactionPending: false,
    lastCompactedAt: null,
    updatedAt: now,
    lastActivityAt: now,
    messages: new Map(),
    parts: new Map(),
    pendingSteps: new Map(),
    pendingTaskParts: new Set(),
  };
}

function insertBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const first = map.keys().next();
    if (first.done === true) break;
    map.delete(first.value);
  }
}

function insertBoundedSet(set: Set<string>, value: string, max: number): void {
  set.add(value);
  while (set.size > max) {
    const first = set.values().next();
    if (first.done === true) break;
    set.delete(first.value);
  }
}

export class ContextTracker {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #parents = new Map<string, string | null>();
  readonly #children = new Map<string, Set<string>>();
  readonly #sessionUpdated = new Map<string, number>();

  get sessionCount(): number {
    return this.#sessions.size;
  }

  hasSession(sessionID: string): boolean {
    return this.#sessions.has(sessionID);
  }

  setSessionParents(sessions: OpencodeSession[]): void {
    this.#parents.clear();
    this.#children.clear();
    this.#sessionUpdated.clear();
    for (const session of sessions) {
      const sessionID = asString(session.id);
      if (sessionID === undefined) continue;
      const parentID = asString(session.parentID);
      insertBounded(this.#parents, sessionID, parentID ?? null, MAX_CONTEXT_SESSIONS);
      if (parentID !== undefined) {
        const children = this.#children.get(parentID);
        if (children === undefined) {
          this.#children.set(parentID, new Set([sessionID]));
        } else {
          insertBoundedSet(children, sessionID, MAX_CONTEXT_SESSIONS);
        }
      }
      const updated = asFinite(session.time?.updated) ?? asFinite(session.time?.created);
      if (updated !== undefined) {
        insertBounded(this.#sessionUpdated, sessionID, updated, MAX_CONTEXT_SESSIONS);
      }
    }
  }

  isTopLevel(sessionID: string): boolean {
    return this.#parents.get(sessionID) === null;
  }

  parentOf(sessionID: string): string | undefined {
    return this.#parents.get(sessionID) ?? undefined;
  }

  hasActiveChildren(sessionID: string, now: number = Date.now()): boolean {
    const children = this.#children.get(sessionID);
    if (children === undefined) return false;
    for (const childID of children) {
      const record = this.#sessions.get(childID);
      if (
        record !== undefined &&
        (record.status === "busy" || record.status === "retry" || record.compacting)
      ) {
        return true;
      }
      if ((record?.status ?? "unknown") !== "unknown") continue;
      const lastActivity = Math.max(
        record?.lastActivityAt ?? Number.NEGATIVE_INFINITY,
        this.#sessionUpdated.get(childID) ?? Number.NEGATIVE_INFINITY,
      );
      if (Number.isFinite(lastActivity) && now - lastActivity < CHILD_ACTIVITY_WINDOW_MS) {
        return true;
      }
    }
    return false;
  }

  hasPendingTask(sessionID: string): boolean {
    return (this.#sessions.get(sessionID)?.pendingTaskParts.size ?? 0) > 0;
  }

  hasActiveCompactionBlocker(sessionID: string, now: number = Date.now()): boolean {
    return this.hasActiveChildren(sessionID, now) || this.hasPendingTask(sessionID);
  }

  setModelLimit(
    sessionID: string,
    model: OpencodeModel,
    limit: number | null,
    now: number = Date.now(),
  ): void {
    const record = this.#ensure(sessionID, now);
    if (!sameModel(record.model, model)) this.#setModel(record, model, now);
    record.limit = limit !== null && Number.isFinite(limit) && limit > 0 ? limit : null;
    this.#touch(record, now);
  }

  noteUsage(
    sessionID: string,
    tokens: ContextTokens,
    model: OpencodeModel | null,
    now: number = Date.now(),
    options: {
      source?: ContextUsageSource;
      messageID?: string;
      role?: "user" | "assistant";
      summary?: boolean;
    } = {},
  ): void {
    if (model === null) return;
    if (options.summary === true || options.role === "user") return;
    const record = this.#ensure(sessionID, now);
    this.#applyUsage(
      record,
      tokens,
      model,
      now,
      options.source ?? "message",
      options.messageID ?? "",
    );
  }

  applyEvent(event: ContextEvent, now: number = Date.now()): void {
    const sessionID = asString(event.sessionID);
    if (sessionID === undefined) return;
    switch (event.type) {
      case "message.updated":
        this.#messageUpdated(sessionID, event, now);
        return;
      case "message.part.updated":
        this.#partUpdated(sessionID, event, now);
        return;
      case "session.status":
        this.#sessionStatus(sessionID, event, now);
        return;
      case "session.idle":
        this.#sessionIdle(sessionID, now);
        return;
      case "session.error":
        this.#touch(this.#ensure(sessionID, now), now);
        return;
      case "session.compacted":
        this.#sessionCompacted(sessionID, now);
        return;
      default:
        return;
    }
  }

  snapshot(sessionID: string, policy: ContextPolicy, now: number = Date.now()): ContextSnapshot {
    const record = this.#ensure(sessionID, now);
    const used = record.usage?.used ?? null;
    const state: ContextState = record.compacting
      ? "compacting"
      : used === null
        ? "unknown"
        : "ready";
    return {
      sessionID,
      state,
      used,
      limit: record.limit,
      percent: contextPercent(used, record.limit),
      model: record.model === null ? null : { ...record.model },
      status: record.status,
      topLevel: this.isTopLevel(sessionID),
      activeChildren: this.hasActiveChildren(sessionID, now),
      pendingTask: this.hasPendingTask(sessionID),
      updatedAt: new Date(record.updatedAt).toISOString(),
      lastCompactedAt:
        record.lastCompactedAt === null ? null : new Date(record.lastCompactedAt).toISOString(),
      lastError: record.lastError,
      autoCompact: {
        enabled: policy.enabled,
        percent: policy.percent,
        source: policy.enabledSource,
        percentSource: policy.percentSource,
      },
    };
  }

  evaluateAutoCompact(
    sessionID: string,
    policy: ContextPolicy,
    now: number = Date.now(),
  ): AutoCompactDecision {
    const record = this.#ensure(sessionID, now);
    const usage = record.usage;
    const decision = autoCompactDecision(
      {
        state: record.compacting ? "compacting" : usage === null ? "unknown" : "ready",
        status: record.status,
        used: usage?.used ?? null,
        limit: record.limit,
        model: record.model,
        compacting: record.compacting,
        topLevel: this.isTopLevel(sessionID),
        armed: record.armed,
        armKey: record.armKey,
        failureCooldownUntil: record.failureCooldownUntil,
        usageAt: usage?.at ?? null,
        lastCompactedAt: record.lastCompactedAt,
        postCompactionPending: record.postCompactionPending,
        ineffective: record.ineffective,
        activeChildren: this.hasActiveChildren(sessionID, now),
        pendingTask: this.hasPendingTask(sessionID),
      },
      policy,
      now,
    );
    record.armed = decision.armed;
    record.armKey = decision.armKey;
    record.failureCooldownUntil = decision.failureCooldownUntil;
    record.postCompactionPending = decision.postCompactionPending;
    record.ineffective = decision.ineffective;
    return decision;
  }

  markCompacting(sessionID: string, now: number = Date.now()): void {
    const record = this.#ensure(sessionID, now);
    if (!record.compacting) record.lastAttemptAt = now;
    record.compacting = true;
    record.lastError = null;
    record.ineffective = false;
    record.postCompactionPending = false;
    this.#touch(record, now);
  }

  clearCompacting(sessionID: string, now: number = Date.now()): void {
    const record = this.#ensure(sessionID, now);
    record.compacting = false;
    this.#touch(record, now);
  }

  markAutoAttempt(sessionID: string, now: number = Date.now()): void {
    const record = this.#ensure(sessionID, now);
    record.armed = false;
    record.lastAttemptAt = now;
    record.lastError = null;
    record.compacting = true;
    record.ineffective = false;
    record.postCompactionPending = false;
    this.#touch(record, now);
  }

  markCompactionSuccess(sessionID: string, now: number = Date.now()): void {
    const record = this.#ensure(sessionID, now);
    record.usage = null;
    record.compacting = false;
    record.lastError = null;
    record.failureCooldownUntil = null;
    record.lastCompactedAt = now;
    record.armed = false;
    record.ineffective = false;
    record.postCompactionPending = true;
    record.pendingSteps.clear();
    record.pendingTaskParts.clear();
    this.#touch(record, now);
  }

  markCompactionFailure(
    sessionID: string,
    code: CompactionErrorCode,
    now: number = Date.now(),
  ): void {
    const record = this.#ensure(sessionID, now);
    record.compacting = false;
    record.lastError = code;
    record.failureCooldownUntil = now + COMPACTION_FAILURE_COOLDOWN_MS;
    record.armed = false;
    record.ineffective = false;
    record.postCompactionPending = false;
    this.#touch(record, now);
  }

  markCompactionUnavailable(sessionID: string, now: number = Date.now()): void {
    const record = this.#ensure(sessionID, now);
    record.compacting = false;
    record.lastError = "compaction_unavailable";
    record.armed = false;
    record.ineffective = false;
    record.postCompactionPending = false;
    this.#touch(record, now);
  }

  hydrate(
    sessionID: string,
    messages: OpencodeMessage[],
    sessions: OpencodeSession[],
    now: number = Date.now(),
  ): void {
    this.setSessionParents(sessions);
    const record = this.#ensure(sessionID, now);
    let usage: {
      tokens: ContextTokens;
      model: OpencodeModel;
      messageID: string;
      time: number | null;
      index: number;
    } | null = null;
    let model: { model: OpencodeModel; time: number | null; index: number } | null = null;
    let boundary: { time: number | null; index: number } | null = null;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message === undefined) continue;
      const info = asRecord(message.info);
      const infoTime = info === undefined ? null : timestamp(info.time);
      if (info !== undefined && info.role === "assistant") {
        const summary = isSummary(info.summary);
        const messageModel = parseModel(info);
        if (!summary && messageModel !== null) {
          if (
            orderNewer(
              { time: infoTime, index },
              model === null ? null : { time: model.time, index: model.index },
            )
          ) {
            model = { model: messageModel, time: infoTime, index };
          }
          const tokens = parseTokens(info.tokens);
          if (tokens !== null) {
            if (
              orderNewer(
                { time: infoTime, index },
                usage === null ? null : { time: usage.time, index: usage.index },
              )
            ) {
              usage = {
                tokens,
                model: messageModel,
                messageID: asString(info.id) ?? "",
                time: infoTime,
                index,
              };
            }
          }
        }
        if (summary && orderNewer({ time: infoTime, index }, boundary)) {
          boundary = { time: infoTime, index };
        }
      }

      for (const rawPart of message.parts) {
        const part = asRecord(rawPart);
        if (part === undefined) continue;
        if (spawnToolFromPart(part)) {
          const partID = asString(part.id);
          const status = asString(asRecord(part.state)?.status);
          if (partID !== undefined) {
            if (status === "pending" || status === "running") {
              insertBoundedSet(record.pendingTaskParts, partID, MAX_CONTEXT_PARTS_PER_SESSION);
            } else if (status === "completed" || status === "error") {
              record.pendingTaskParts.delete(partID);
            }
          }
        }
        if (asString(part.type) !== "compaction") continue;
        const partTime = timestamp(part.time) ?? infoTime;
        if (orderNewer({ time: partTime, index }, boundary)) {
          boundary = { time: partTime, index };
        }
      }
    }

    const usageAfterBoundary =
      usage !== null && !orderAfter(boundary, { time: usage.time, index: usage.index });
    const boundaryTime = boundary?.time ?? null;
    if (boundaryTime !== null) {
      record.lastCompactedAt =
        record.lastCompactedAt === null
          ? boundaryTime
          : Math.max(record.lastCompactedAt, boundaryTime);
      if (record.usage !== null && boundaryTime > record.usage.at) record.usage = null;
    }
    if (record.usage === null && usageAfterBoundary && usage !== null) {
      record.usage = {
        tokens: usage.tokens,
        used: promptTokens(usage.tokens),
        model: usage.model,
        messageID: usage.messageID,
        source: "message",
        at: usage.time ?? now,
      };
    }
    if (record.model === null && model !== null) {
      record.model = { ...model.model };
    }
    this.#touch(record, now);
  }

  #sessionsBounded(now: number): void {
    for (const [sessionID, record] of this.#sessions) {
      if (now - record.lastActivityAt >= CONTEXT_SESSION_INACTIVITY_MS) {
        this.#sessions.delete(sessionID);
      }
    }
    while (this.#sessions.size >= MAX_CONTEXT_SESSIONS) {
      let oldestID: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [sessionID, record] of this.#sessions) {
        if (record.lastActivityAt < oldestAt) {
          oldestAt = record.lastActivityAt;
          oldestID = sessionID;
        }
      }
      if (oldestID === null) break;
      this.#sessions.delete(oldestID);
    }
  }

  #ensure(sessionID: string, now: number): SessionRecord {
    const existing = this.#sessions.get(sessionID);
    if (existing !== undefined) return existing;
    this.#sessionsBounded(now);
    const record = freshRecord(now);
    this.#sessions.set(sessionID, record);
    return record;
  }

  #touch(record: SessionRecord, now: number): void {
    record.updatedAt = now;
    record.lastActivityAt = now;
  }

  #setModel(record: SessionRecord, model: OpencodeModel, now: number): void {
    const changed = !sameModel(record.model, model);
    record.model = { ...model };
    if (changed) {
      record.armed = true;
      record.armKey = null;
      record.ineffective = false;
      record.postCompactionPending = false;
    }
    this.#touch(record, now);
  }

  #applyUsage(
    record: SessionRecord,
    tokens: ContextTokens,
    model: OpencodeModel,
    now: number,
    source: ContextUsageSource,
    messageID: string,
  ): void {
    this.#setModel(record, model, now);
    record.usage = {
      tokens: { ...tokens },
      used: promptTokens(tokens),
      model: { ...model },
      messageID,
      source,
      at: now,
    };
    this.#touch(record, now);
  }

  #messageMeta(record: SessionRecord, messageID: string, role: "user" | "assistant"): MessageMeta {
    const existing = record.messages.get(messageID);
    if (existing !== undefined) return existing;
    const meta: MessageMeta = {
      role,
      summary: false,
      model: null,
      finish: null,
      stepTokens: null,
    };
    insertBounded(record.messages, messageID, meta, MAX_CONTEXT_MESSAGES_PER_SESSION);
    return meta;
  }

  #messageUpdated(sessionID: string, event: ContextEvent, now: number): void {
    const info = asRecord(event.info);
    const data = info ?? event;
    const messageID = asString(data.messageID) ?? asString(data.id) ?? asString(event.messageID);
    const rawRole = data.role;
    const role = rawRole === "user" || rawRole === "assistant" ? rawRole : undefined;
    if (messageID === undefined || role === undefined) return;
    const record = this.#ensure(sessionID, now);
    const meta = this.#messageMeta(record, messageID, role);
    meta.role = role;

    const summaryValue = data.summary ?? event.summary;
    if (summaryValue !== undefined) meta.summary = isSummary(summaryValue);
    const model = parseModel(data) ?? parseModel(event);
    if (model !== null) meta.model = model;
    const finish = asString(data.finish) ?? asString(event.finish);
    if (finish !== undefined) meta.finish = finish;

    if (role === "user" || meta.summary) record.pendingSteps.delete(messageID);
    if (role === "assistant" && !meta.summary && model !== null) {
      const pending = record.pendingSteps.get(messageID);
      if (pending !== undefined) {
        record.pendingSteps.delete(messageID);
        meta.stepTokens = pending;
        this.#applyUsage(record, pending, model, now, "step-finish", messageID);
      }
    }

    const tokens = parseTokens(data.usage) ?? parseTokens(data.tokens) ?? parseTokens(event.usage);
    if (role === "assistant" && !meta.summary && tokens !== null && model !== null) {
      const stepAuthoritative =
        meta.stepTokens !== null ||
        (record.usage?.messageID === messageID && record.usage.source === "step-finish");
      if (!stepAuthoritative) {
        this.#applyUsage(record, tokens, model, now, "message", messageID);
      }
    }
    this.#touch(record, now);
  }

  #partUpdated(sessionID: string, event: ContextEvent, now: number): void {
    const part = asRecord(event.part);
    if (part === undefined) return;
    const messageID = asString(event.messageID) ?? asString(part.messageID);
    const partID = asString(event.partID) ?? asString(part.id);
    const partType = asString(event.partType) ?? asString(part.type);
    if (messageID === undefined || partID === undefined || partType === undefined) return;
    const record = this.#ensure(sessionID, now);
    insertBounded(
      record.parts,
      partID,
      { type: partType, messageID },
      MAX_CONTEXT_PARTS_PER_SESSION,
    );
    this.#touch(record, now);

    if (partType === "compaction") {
      if (!record.compacting) record.lastAttemptAt = now;
      record.compacting = true;
      record.lastError = null;
      return;
    }
    if (partType === "tool") {
      if (isSpawnToolName(part.tool)) {
        const status = asString(asRecord(part.state)?.status);
        if (status === "pending" || status === "running") {
          insertBoundedSet(record.pendingTaskParts, partID, MAX_CONTEXT_PARTS_PER_SESSION);
        } else if (status === "completed" || status === "error") {
          record.pendingTaskParts.delete(partID);
        }
      }
      return;
    }
    if (partType !== "step-finish") return;

    const tokens = parseTokens(part.tokens) ?? parseTokens(part.usage) ?? parseTokens(event.usage);
    if (tokens === null) return;
    const meta = record.messages.get(messageID);
    if (meta !== undefined && (meta.role === "user" || meta.summary)) return;
    const model = meta?.model ?? null;
    if (model === null) {
      insertBounded(record.pendingSteps, messageID, tokens, MAX_CONTEXT_PENDING_STEPS);
      return;
    }
    if (meta !== undefined) meta.stepTokens = tokens;
    this.#applyUsage(record, tokens, model, now, "step-finish", messageID);
  }

  #sessionStatus(sessionID: string, event: ContextEvent, now: number): void {
    const status = asRecord(event.status);
    const type = status?.type;
    const record = this.#ensure(sessionID, now);
    record.status = type === "idle" || type === "busy" || type === "retry" ? type : "unknown";
    if (type === "idle") record.pendingTaskParts.clear();
    this.#touch(record, now);
  }

  #sessionIdle(sessionID: string, now: number): void {
    const record = this.#ensure(sessionID, now);
    record.status = "idle";
    record.pendingTaskParts.clear();
    this.#touch(record, now);
  }

  #sessionCompacted(sessionID: string, now: number): void {
    const record = this.#ensure(sessionID, now);
    record.usage = null;
    record.compacting = false;
    record.lastCompactedAt = now;
    record.lastError = null;
    record.failureCooldownUntil = null;
    record.armed = false;
    record.ineffective = false;
    record.postCompactionPending = true;
    record.pendingSteps.clear();
    record.pendingTaskParts.clear();
    this.#touch(record, now);
  }
}

const PARENT_REFRESH_MS = 30_000;
const HYDRATION_MESSAGE_LIMIT = 30;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_COMPACT_TIMEOUT_MS = 10 * 60 * 1_000;

/** Narrow live settings source used by the monitor; no snapshot/auth work. */
export interface ContextPolicySource {
  contextPolicy(target: SettingsTarget): ContextPolicy;
}

/** Injected upstream client hooks, used by tests to avoid a second network layer. */
export interface ContextMonitorClientHooks {
  listMessagePage?: typeof listMessagePage;
  listSessions?: typeof listSessionsBounded;
  listProviders?: typeof listProviders;
  summarize?: typeof summarizeSession;
}

export interface ContextMonitorOptions {
  endpoint: string;
  appId: string;
  projectId: string;
  appKey: string;
  isCurrent: () => boolean;
  settings?: ContextPolicySource;
  now?: () => number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  compactTimeoutMs?: number;
  client?: ContextMonitorClientHooks;
  /** Sanitized diagnostics only; never pass upstream bodies or provider payloads. */
  log?: (message: string) => void;
  onEvent?: (event: HanseEvent) => void;
}

export interface ContextMonitorLike {
  start(): void;
  stop(): void;
  snapshot(sessionId: string): Promise<ContextSnapshot>;
  compact(sessionId: string): Promise<{ accepted: true }>;
  /** Event-stream connection state; used to decide whether a pending send needs a fallback. */
  state?(): "connecting" | "connected";
}

export class AgentNotRunningError extends Error {
  readonly code = "agent_not_running";

  constructor() {
    super("agent is not running");
    this.name = "AgentNotRunningError";
  }
}

export class SessionBusyError extends Error {
  readonly code = "session_busy";

  constructor() {
    super("session is busy");
    this.name = "SessionBusyError";
  }
}

export class NotTopLevelError extends Error {
  readonly code = "not_top_level";

  constructor() {
    super("compaction is only available for top-level sessions");
    this.name = "NotTopLevelError";
  }
}

export class CompactInProgressError extends Error {
  readonly code = "compact_in_progress";

  constructor() {
    super("a compaction is already in progress");
    this.name = "CompactInProgressError";
  }
}

export class ModelUnavailableError extends Error {
  readonly code = "model_unavailable";

  constructor() {
    super("no model is available for compaction");
    this.name = "ModelUnavailableError";
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "session_not_found";

  constructor() {
    super("session not found");
    this.name = "SessionNotFoundError";
  }
}

/** Split `provider/model` at the first slash; both parts must be non-empty. */
export function parseModelString(model: string): OpencodeModel | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function defaultPolicy(): ContextPolicy {
  return {
    enabled: false,
    percent: 80,
    model: "",
    enabledSource: "default",
    percentSource: "default",
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof SessionNotFoundError ||
    (error instanceof OpencodeHttpError && error.status === 404)
  );
}

function isTimeoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  return /timed out after/i.test(error.message);
}

function triggersAutoEvaluation(event: HanseEvent): boolean {
  if (event.type === "session.compacted" || event.type === "session.status") return true;
  if (event.type === "message.updated") return event.usage !== undefined;
  return event.type === "message.part.updated" && event.partType === "step-finish";
}

function eventSessionId(event: HanseEvent): string | undefined {
  if (!("sessionID" in event)) return undefined;
  const value = event.sessionID;
  return typeof value === "string" ? value : undefined;
}

function isIdleStatusEvent(event: HanseEvent): boolean {
  return event.type === "session.status" && asRecord(event.status)?.type === "idle";
}

interface CompactionAttempt {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  compactedAfterStart: boolean;
  timedOut: boolean;
}

/**
 * One background context stream and tracker per running application instance.
 *
 * The monitor never persists provider options, prompt text, message content, or
 * upstream error bodies: it retains token counts, model identifiers, limits,
 * session status, and fixed error codes only.
 */
export class ContextMonitor implements ContextMonitorLike {
  readonly #endpoint: string;
  readonly #projectId: string;
  readonly #appKey: string;
  readonly #isCurrent: () => boolean;
  readonly #settings: ContextPolicySource | undefined;
  readonly #now: () => number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #compactTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #onEvent: ((event: HanseEvent) => void) | undefined;
  readonly #listMessagePage: typeof listMessagePage;
  readonly #listSessions: typeof listSessionsBounded;
  readonly #summarize: typeof summarizeSession;
  readonly #tracker = new ContextTracker();
  readonly #limits: ProviderLimitCache;
  readonly #hydrated = new Set<string>();
  readonly #hydrations = new Map<string, Promise<void>>();
  readonly #attempts = new Map<string, CompactionAttempt>();
  #parentRefreshAt: number | null = null;
  #parentRefreshOk = false;
  #parentsPending: Promise<boolean> | null = null;
  #sse: AbortController | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #backoffResolve: (() => void) | null = null;
  #backoffMs: number;
  #started = false;
  #stopped = false;
  #connected = false;

  constructor(options: ContextMonitorOptions) {
    this.#endpoint = options.endpoint;
    this.#projectId = options.projectId;
    this.#appKey = options.appKey;
    this.#isCurrent = options.isCurrent;
    this.#settings = options.settings;
    this.#now = options.now ?? Date.now;
    this.#backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.#backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.#compactTimeoutMs = options.compactTimeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;
    this.#backoffMs = this.#backoffBaseMs;
    this.#log = options.log ?? (() => undefined);
    this.#onEvent = options.onEvent;
    this.#listMessagePage = options.client?.listMessagePage ?? listMessagePage;
    this.#listSessions = options.client?.listSessions ?? listSessionsBounded;
    this.#summarize = options.client?.summarize ?? summarizeSession;
    const loadProviders = options.client?.listProviders ?? listProviders;
    this.#limits = new ProviderLimitCache(() => loadProviders(this.#endpoint), this.#now);
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    void this.#run();
  }

  state(): "connecting" | "connected" {
    return this.#connected && !this.#stopped ? "connected" : "connecting";
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#sse?.abort();
    this.#sse = null;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const resume = this.#backoffResolve;
    this.#backoffResolve = null;
    resume?.();
    for (const attempt of this.#attempts.values()) {
      if (attempt.timer !== null) clearTimeout(attempt.timer);
      attempt.controller.abort();
    }
    this.#attempts.clear();
  }

  async snapshot(sessionId: string): Promise<ContextSnapshot> {
    const policy = this.#policy();
    await this.#hydrate(sessionId);
    const provisional = this.#tracker.snapshot(sessionId, policy, this.#now());
    if (provisional.model !== null) {
      await this.#ensureLimit(sessionId, provisional.model);
    }
    return this.#tracker.snapshot(sessionId, policy, this.#now());
  }

  async compact(sessionId: string): Promise<{ accepted: true }> {
    if (this.#stopped) throw new AgentNotRunningError();
    const policy = this.#policy();
    const now = this.#now();
    if (this.#attempts.has(sessionId)) throw new CompactInProgressError();
    const before = this.#tracker.snapshot(sessionId, policy, now);
    if (before.state === "compacting") throw new CompactInProgressError();
    if (before.status === "busy" || before.status === "retry") throw new SessionBusyError();
    // The claim is synchronous and precedes every await so concurrent requests cannot both start.
    this.#tracker.markCompacting(sessionId, now);
    try {
      await this.#hydrate(sessionId);
    } catch (error) {
      this.#tracker.markCompactionUnavailable(sessionId, this.#now());
      throw error;
    }
    if (this.#stopped) throw new AgentNotRunningError();
    const hydratedAt = this.#now();
    if (!this.#tracker.isTopLevel(sessionId)) {
      this.#tracker.clearCompacting(sessionId, hydratedAt);
      throw new NotTopLevelError();
    }
    const hydrated = this.#tracker.snapshot(sessionId, policy, hydratedAt);
    if (
      hydrated.status === "busy" ||
      hydrated.status === "retry" ||
      this.#tracker.hasActiveCompactionBlocker(sessionId, hydratedAt)
    ) {
      this.#tracker.clearCompacting(sessionId, hydratedAt);
      throw new SessionBusyError();
    }
    const model = hydrated.model ?? parseModelString(policy.model);
    if (model === null) {
      this.#tracker.markCompactionUnavailable(sessionId, this.#now());
      throw new ModelUnavailableError();
    }
    this.#startSummarize(sessionId, model);
    return { accepted: true };
  }

  async #run(): Promise<void> {
    while (!this.#stopped && this.#isCurrent()) {
      try {
        await this.#connect();
      } catch {
        this.#log("context monitor: event stream failed");
      }
      if (this.#stopped || !this.#isCurrent()) break;
      await this.#waitBackoff(this.#backoffMs);
      this.#backoffMs = Math.min(this.#backoffMs * 2, this.#backoffMaxMs);
    }
  }

  async #connect(): Promise<void> {
    const controller = new AbortController();
    this.#sse = controller;
    try {
      const authorization = authorizationFor(this.#endpoint);
      const response = await fetch(`${this.#endpoint}/event`, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          ...(authorization === undefined ? {} : { authorization }),
        },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      this.#connected = true;
      const stream = createEventStream(response.body, {
        includeUsage: true,
        maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES,
        signal: controller.signal,
      });
      for await (const event of stream.events) {
        if (this.#stopped || !this.#isCurrent()) {
          stream.close();
          break;
        }
        this.#observe(event);
      }
    } finally {
      this.#connected = false;
      if (this.#sse === controller) this.#sse = null;
    }
  }

  #waitBackoff(ms: number): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#backoffResolve = resolve;
      const timer = setTimeout(() => {
        this.#reconnectTimer = null;
        this.#backoffResolve = null;
        resolve();
      }, ms);
      timer.unref();
      this.#reconnectTimer = timer;
    });
  }

  #observe(event: HanseEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // An observer failure must never stop the context monitor or its stream.
    }
    const now = this.#now();
    this.#tracker.applyEvent(event as unknown as ContextEvent, now);
    if (event.type === "message.part.updated" && spawnToolFromPart(asRecord(event.part))) {
      this.#parentRefreshAt = null;
    }
    if (event.type === "session.compacted") {
      const attempt = this.#attempts.get(event.sessionID);
      if (attempt !== undefined) attempt.compactedAfterStart = true;
    }
    if (!triggersAutoEvaluation(event)) return;
    const sessionId = eventSessionId(event);
    if (sessionId === undefined) return;
    void this.#maybeAuto(sessionId).catch(() => {
      this.#log("context monitor: auto-compaction evaluation failed");
    });
    if (event.type === "session.compacted" || isIdleStatusEvent(event)) {
      void this.#maybeAutoParent(sessionId).catch(() => {
        this.#log("context monitor: parent auto-compaction evaluation failed");
      });
    }
  }

  #policy(): ContextPolicy {
    const settings = this.#settings;
    if (settings !== undefined) {
      try {
        return settings.contextPolicy({ projectId: this.#projectId, appKey: this.#appKey });
      } catch {
        return defaultPolicy();
      }
    }
    return defaultPolicy();
  }

  async #hydrate(sessionId: string): Promise<void> {
    if (this.#hydrated.has(sessionId)) return;
    const pending = this.#hydrations.get(sessionId);
    if (pending !== undefined) return pending;
    const hydration = this.#loadHydration(sessionId).finally(() => {
      if (this.#hydrations.get(sessionId) === hydration) this.#hydrations.delete(sessionId);
    });
    this.#hydrations.set(sessionId, hydration);
    return hydration;
  }

  async #loadHydration(sessionId: string): Promise<void> {
    let page: Awaited<ReturnType<typeof listMessagePage>>;
    let sessions: OpencodeSession[];
    try {
      [page, sessions] = await Promise.all([
        this.#listMessagePage(this.#endpoint, sessionId, { limit: HYDRATION_MESSAGE_LIMIT }),
        this.#listSessions(this.#endpoint),
      ]);
    } catch (error) {
      if (isNotFound(error)) throw new SessionNotFoundError();
      throw error;
    }
    this.#tracker.hydrate(sessionId, page.messages, sessions, this.#now());
    this.#rememberSessions(sessions);
    this.#markHydrated(sessionId);
  }

  #markHydrated(sessionId: string): void {
    if (this.#hydrated.has(sessionId)) return;
    this.#hydrated.add(sessionId);
    while (this.#hydrated.size > MAX_CONTEXT_SESSIONS) {
      const oldest = this.#hydrated.values().next();
      if (oldest.done === true) break;
      this.#hydrated.delete(oldest.value);
    }
  }

  #rememberSessions(sessions: OpencodeSession[]): void {
    this.#tracker.setSessionParents(sessions);
    this.#parentRefreshAt = this.#now();
    this.#parentRefreshOk = true;
  }

  async #ensureLimit(sessionId: string, model: OpencodeModel): Promise<void> {
    const limits = await this.#limits.lookup(model.providerID, model.modelID);
    this.#tracker.setModelLimit(sessionId, model, limits.context, this.#now());
  }

  async #maybeAuto(sessionId: string): Promise<void> {
    if (this.#stopped) return;
    const policy = this.#policy();
    if (!policy.enabled) return;
    const parentsOk = await this.#refreshParents();
    if (!parentsOk || this.#stopped) return;
    if (!this.#tracker.isTopLevel(sessionId)) return;
    const now = this.#now();
    const snapshot = this.#tracker.snapshot(sessionId, policy, now);
    if (snapshot.state === "compacting" || snapshot.status !== "idle") return;
    if (this.#tracker.hasActiveCompactionBlocker(sessionId, now)) return;
    if (snapshot.model !== null) await this.#ensureLimit(sessionId, snapshot.model);
    if (this.#stopped) return;
    const decision = this.#tracker.evaluateAutoCompact(sessionId, policy, this.#now());
    if (!decision.trigger) return;
    this.#claimAuto(sessionId, policy);
  }

  async #maybeAutoParent(sessionId: string): Promise<void> {
    if (this.#stopped) return;
    const policy = this.#policy();
    if (!policy.enabled) return;
    const parentsOk = await this.#refreshParents();
    if (!parentsOk || this.#stopped) return;
    if (this.#tracker.isTopLevel(sessionId)) return;
    const parentID = this.#tracker.parentOf(sessionId);
    if (parentID === undefined) return;
    await this.#maybeAuto(parentID);
  }

  #claimAuto(sessionId: string, policy: ContextPolicy): void {
    if (this.#attempts.has(sessionId)) return;
    if (this.#tracker.hasActiveCompactionBlocker(sessionId, this.#now())) return;
    const now = this.#now();
    const snapshot = this.#tracker.snapshot(sessionId, policy, now);
    if (snapshot.state === "compacting") return;
    if (snapshot.status === "busy" || snapshot.status === "retry") return;
    const model = snapshot.model ?? parseModelString(policy.model);
    if (model === null) {
      this.#tracker.markCompactionUnavailable(sessionId, now);
      return;
    }
    this.#tracker.markAutoAttempt(sessionId, now);
    this.#startSummarize(sessionId, model);
  }

  #refreshParents(): Promise<boolean> {
    const now = this.#now();
    if (this.#parentRefreshAt !== null && now - this.#parentRefreshAt < PARENT_REFRESH_MS) {
      return Promise.resolve(this.#parentRefreshOk);
    }
    if (this.#parentsPending !== null) return this.#parentsPending;
    const pending = this.#loadParents();
    this.#parentsPending = pending;
    void pending.finally(() => {
      if (this.#parentsPending === pending) this.#parentsPending = null;
    });
    return pending;
  }

  async #loadParents(): Promise<boolean> {
    try {
      const sessions = await this.#listSessions(this.#endpoint);
      this.#rememberSessions(sessions);
      return true;
    } catch {
      this.#parentRefreshAt = this.#now();
      this.#parentRefreshOk = false;
      return false;
    }
  }

  #startSummarize(sessionId: string, model: OpencodeModel): void {
    const controller = new AbortController();
    const attempt: CompactionAttempt = {
      controller,
      timer: null,
      compactedAfterStart: false,
      timedOut: false,
    };
    const timer = setTimeout(() => {
      attempt.timedOut = true;
      controller.abort();
    }, this.#compactTimeoutMs);
    timer.unref();
    attempt.timer = timer;
    this.#attempts.set(sessionId, attempt);

    void this.#summarize(this.#endpoint, sessionId, model, {
      signal: controller.signal,
      timeoutMs: this.#compactTimeoutMs,
    })
      .then(
        () => {
          if (this.#stopped || attempt.compactedAfterStart) return;
          this.#tracker.markCompactionSuccess(sessionId, this.#now());
        },
        (error: unknown) => {
          if (this.#stopped || attempt.compactedAfterStart) return;
          const code =
            attempt.timedOut || isTimeoutFailure(error)
              ? "compaction_timeout"
              : "compaction_failed";
          this.#tracker.markCompactionFailure(sessionId, code, this.#now());
        },
      )
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        if (this.#attempts.get(sessionId) === attempt) this.#attempts.delete(sessionId);
      });
  }
}
