<script setup lang="ts">
import { computed, ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import { absoluteTime, timeAgo } from "../format.js";
import type { ProjectHandoff } from "../project-types.js";
import { replyPill, statusPill } from "../status.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

interface DecisionResponse {
  readonly ok: true;
  readonly decision: "approved" | "rejected";
}

const props = defineProps<{ handoff: ProjectHandoff }>();
const emit = defineEmits<{ changed: [] }>();

const toasts = useToastStore();
const reasonInput = ref("");
const noteInput = ref("");
const busy = ref(false);
const dialog = ref<HTMLDialogElement | null>(null);

const dialogId = computed(() => `h-${props.handoff.id}`);
const statePill = computed(() => statusPill(props.handoff.displayState));
const reply = computed(() => replyPill(props.handoff.replyState));
const title = computed(() =>
  props.handoff.approvalKind === "reply"
    ? "Review reply"
    : props.handoff.approvalKind === "dispatch"
      ? "Review handoff"
      : "Handoff detail",
);

function shortSession(id: string | null, empty: string): string {
  return id === null ? empty : id.slice(0, 8);
}

function open(): void {
  reasonInput.value = "";
  noteInput.value = "";
  if (dialog.value !== null && !dialog.value.open) {
    dialog.value.showModal();
  }
}

function close(): void {
  if (!busy.value) {
    dialog.value?.close();
  }
}

function done(message: string): void {
  toasts.push(message, "success");
  emit("changed");
  dialog.value?.close();
}

function failed(error: unknown, fallback: string): void {
  const message = error instanceof ApiError || error instanceof Error ? error.message : fallback;
  toasts.push(message, "error");
}

async function decide(decision: "approved" | "rejected"): Promise<void> {
  const kind = props.handoff.approvalKind;
  if (kind === null || busy.value) {
    return;
  }
  busy.value = true;
  try {
    await apiMutation<DecisionResponse>(
      `/api/handoffs/${encodeURIComponent(props.handoff.id)}/decision`,
      {
        form: {
          decision,
          approval_kind: kind,
          reason: reasonInput.value,
          return_to: props.handoff.returnTo,
        },
      },
    );
    done(
      kind === "reply"
        ? decision === "approved"
          ? "Reply approved."
          : "Reply rejected."
        : decision === "approved"
          ? "Handoff approved."
          : "Handoff rejected.",
    );
  } catch (error) {
    failed(error, "Could not record the decision.");
  } finally {
    busy.value = false;
  }
}

async function act(
  path: string,
  message: string,
  extra: Record<string, string> = {},
): Promise<void> {
  if (busy.value) {
    return;
  }
  busy.value = true;
  try {
    await apiMutation<{ ok: true }>(path, {
      form: { return_to: props.handoff.returnTo, ...extra },
    });
    done(message);
  } catch (error) {
    failed(error, "Could not complete the action.");
  } finally {
    busy.value = false;
  }
}

function relaunch(): void {
  void act(
    `/api/handoffs/${encodeURIComponent(props.handoff.id)}/reply/relaunch`,
    "Reply started in a new session.",
    noteInput.value.trim().length === 0 ? {} : { note: noteInput.value.trim() },
  );
}

function retryReply(): void {
  void act(
    `/api/handoffs/${encodeURIComponent(props.handoff.id)}/reply/deliver`,
    "Reply delivery queued.",
  );
}

function cancelReply(): void {
  void act(
    `/api/handoffs/${encodeURIComponent(props.handoff.id)}/reply/cancel`,
    "Reply delivery cancelled.",
  );
}

function cancelHandoff(): void {
  void act(`/api/handoffs/${encodeURIComponent(props.handoff.id)}/cancel`, "Handoff cancelled.");
}

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog dialog--wide handoff-dialog"
    :id="dialogId"
    :aria-labelledby="`${dialogId}-title`"
  >
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" :id="`${dialogId}-title`">{{ title }}</h2>
        <p class="dialog__meta">
          {{ handoff.id }} / {{ handoff.fromAppKey }} to {{ handoff.toAppKey }}
        </p>
      </header>

      <form
        v-if="handoff.approvalKind !== null"
        class="dialog__form"
        method="post"
        :action="`/api/handoffs/${encodeURIComponent(handoff.id)}/decision`"
        @submit.prevent
      >
        <div class="dialog__body">
          <div class="route-card" :data-state="handoff.displayState">
            <div class="route-card__head">
              <span class="mono table__nowrap">{{ handoff.id.slice(0, 8) }}</span>
              <StatusPill :pill="statePill" />
            </div>
            <p class="route-card__summary">{{ handoff.summary }}</p>
            <div class="route-card__foot">
              <span class="mono table__nowrap">{{ timeAgo(handoff.updatedAt) }}</span>
            </div>
          </div>

          <div class="stack--tight">
            <p class="overline">Specification</p>
            <div class="prose prose--pre">{{ handoff.spec }}</div>
          </div>

          <div class="field">
            <label class="label" :for="`${dialogId}-reason`">Reason, optional</label>
            <textarea
              :id="`${dialogId}-reason`"
              v-model="reasonInput"
              class="textarea"
              name="reason"
              placeholder="Record why this is approved or rejected"
              :aria-describedby="`${dialogId}-reason-hint`"
              :disabled="busy"
            ></textarea>
            <p class="hint" :id="`${dialogId}-reason-hint`">
              The reason is written to the handoff audit trail.
            </p>
          </div>
          <input type="hidden" name="approval_kind" :value="handoff.approvalKind">
          <input type="hidden" name="return_to" :value="handoff.returnTo">
        </div>
        <footer class="dialog__foot">
          <button
            class="btn btn-ghost"
            type="button"
            data-dialog-close
            :disabled="busy"
            @click="close"
          >
            Cancel
          </button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="busy"
            @click="decide('approved')"
          >
            <AppIcon name="check" />
            {{ handoff.approvalKind === "reply" ? "Approve reply" : "Approve handoff" }}
          </button>
          <button class="btn btn-danger" type="button" :disabled="busy" @click="decide('rejected')">
            <AppIcon name="x" />
            {{ handoff.approvalKind === "reply" ? "Reject reply" : "Reject handoff" }}
          </button>
        </footer>
      </form>

      <template v-else>
        <div class="dialog__body">
          <div class="route-card" :data-state="handoff.displayState">
            <div class="route-card__head">
              <span class="mono table__nowrap">{{ handoff.id.slice(0, 8) }}</span>
              <StatusPill :pill="statePill" />
            </div>
            <p class="route-card__summary">{{ handoff.summary }}</p>
            <div class="route-card__foot">
              <span class="mono table__nowrap">{{ timeAgo(handoff.updatedAt) }}</span>
            </div>
          </div>

          <div class="stack--tight">
            <p class="overline">Policy</p>
            <p class="small">
              Dispatch: <span class="mono">{{ handoff.policyDispatchMode }}</span> · Reply:
              <span class="mono">{{ handoff.policyReplyMode }}</span>
              · Origin:
              <span class="mono">{{ handoff.origin }}</span>
            </p>
          </div>

          <div class="stack--tight">
            <p class="overline">Sessions</p>
            <p class="small">
              Source:
              <a
                v-if="handoff.sourceSessionHref !== null"
                class="mono"
                :href="handoff.sourceSessionHref"
              >
                {{ shortSession(handoff.sourceSessionId, "none") }}
              </a>
              <span v-else-if="handoff.sourceSessionId !== null" class="mono">
                {{ shortSession(handoff.sourceSessionId, "none") }}
              </span>
              <span v-else class="small">
                {{
                  handoff.origin === "operator"
                    ? "Operator-created (no source session)"
                    : "Not bound to a session yet"
                }}
              </span>
            </p>
            <p class="small">
              Target:
              <a
                v-if="handoff.targetSessionHref !== null"
                class="mono"
                :href="handoff.targetSessionHref"
              >
                {{ shortSession(handoff.targetSessionId, "none") }}
              </a>
              <span v-else-if="handoff.targetSessionId !== null" class="mono">
                {{ shortSession(handoff.targetSessionId, "none") }}
              </span>
              <span v-else class="small">Not dispatched yet</span>
            </p>
            <p v-if="handoff.sourceSessionDeleted" class="field-error">
              <AppIcon name="alert-circle" />The source session was deleted; any reply will wait for
              an operator decision.
            </p>
          </div>

          <div class="stack--tight">
            <p class="overline">Specification</p>
            <div class="prose prose--pre">{{ handoff.spec }}</div>
          </div>

          <div class="stack--tight">
            <p class="overline">Attempts</p>
            <p class="mono">{{ handoff.attempts }}</p>
            <p class="mono">created {{ absoluteTime(handoff.createdAt) }}</p>
            <p class="mono">updated {{ absoluteTime(handoff.updatedAt) }}</p>
          </div>

          <div
            v-if="handoff.error !== null && handoff.error.length > 0"
            class="error-state"
            role="alert"
          >
            <span class="error-state__mark"><AppIcon name="alert-triangle" /></span>
            <div>
              <h3 class="error-state__title">Request failed</h3>
              <p class="error-state__body">{{ handoff.error }}</p>
            </div>
          </div>

          <div v-if="handoff.result !== null && handoff.result.length > 0" class="stack--tight">
            <p class="overline">
              Result{{ handoff.outcome === null ? "" : ` (${handoff.outcome})` }}
            </p>
            <div class="prose prose--pre">{{ handoff.result }}</div>
          </div>

          <div v-if="handoff.replyState !== 'none'" class="stack--tight">
            <p class="overline">Reply</p>
            <div class="cluster">
              <StatusPill v-if="reply !== undefined" :pill="reply" />
              <span v-if="handoff.deliveredVia !== null" class="mono">
                via {{ handoff.deliveredVia }}
              </span>
            </div>
            <p
              v-if="handoff.replyError !== null && handoff.replyError.length > 0"
              class="field-error"
            >
              <AppIcon name="alert-circle" />{{ handoff.replyError }}
            </p>
            <p v-if="handoff.replyDeliveredAt !== null" class="small">
              Delivered {{ absoluteTime(handoff.replyDeliveredAt) }} to
              <a
                v-if="handoff.replyDeliveredHref !== null"
                class="mono"
                :href="handoff.replyDeliveredHref"
              >
                {{ shortSession(handoff.replyDeliveredSessionId, "session") }}
              </a>
              <span v-else class="mono">
                {{ shortSession(handoff.replyDeliveredSessionId, "session") }}
              </span>
            </p>
            <div
              v-if="handoff.operatorNote !== null && handoff.operatorNote.length > 0"
              class="stack--tight"
            >
              <p class="overline">Operator note</p>
              <div class="prose prose--pre">{{ handoff.operatorNote }}</div>
            </div>
          </div>

          <div v-if="handoff.canRelaunch" class="stack--tight">
            <div class="field">
              <label class="label" :for="`${dialogId}-note`">Operator note, optional</label>
              <textarea
                :id="`${dialogId}-note`"
                v-model="noteInput"
                class="textarea"
                name="note"
                placeholder="Context for the new session"
                :disabled="busy"
              ></textarea>
              <p class="hint">
                The original request, the sibling reply, and this note are sent to a new
                {{ handoff.fromAppKey }} session.
              </p>
            </div>
            <div class="cluster">
              <button class="btn btn-primary" type="button" :disabled="busy" @click="relaunch">
                Start in a new session
              </button>
            </div>
          </div>

          <div
            v-if="handoff.canRetryReply || handoff.canCancelReply || handoff.canCancel"
            class="cluster"
          >
            <button
              v-if="handoff.canRetryReply"
              class="btn btn-secondary btn-sm"
              type="button"
              :disabled="busy"
              @click="retryReply"
            >
              Retry reply delivery
            </button>
            <button
              v-if="handoff.canCancelReply"
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="busy"
              @click="cancelReply"
            >
              Cancel reply
            </button>
            <button
              v-if="handoff.canCancel"
              class="btn btn-danger btn-sm"
              type="button"
              :disabled="busy"
              @click="cancelHandoff"
            >
              Cancel handoff
            </button>
          </div>
        </div>
        <footer class="dialog__foot">
          <button
            class="btn btn-ghost"
            type="button"
            data-dialog-close
            :disabled="busy"
            @click="close"
          >
            Close
          </button>
        </footer>
      </template>
    </div>
  </dialog>
</template>
