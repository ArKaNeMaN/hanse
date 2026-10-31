<script setup lang="ts">
/**
 * App-scoped SSH approval cards. One owner, one interval, one visibility listener. The interval is
 * skipped while the document is hidden and every timer/listener is cleared on unmount. Approve and
 * reject use the existing `/api/apps/:app/ssh/approvals/:id/decision` route.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { SshApprovalView } from "../../../src/ssh/types.js";
import { apiMutation, apiQuery } from "../../api.js";
import type { ChatSshApprovalsResponse } from "../../chat/types.js";
import AppIcon from "../AppIcon.vue";

const props = withDefaults(
  defineProps<{
    appKey: string;
    project: string;
    intervalMs?: number;
    disabled?: boolean;
  }>(),
  { intervalMs: 5_000, disabled: false },
);

const emit = defineEmits<{ "update:count": [count: number] }>();

const approvals = ref<readonly SshApprovalView[]>([]);
const error = ref<string | null>(null);
const busy = ref<ReadonlySet<string>>(new Set<string>());
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function basePath(): string {
  const params = new URLSearchParams();
  if (props.project.length > 0) params.set("project", props.project);
  const query = params.toString();
  return `/api/apps/${encoded(props.appKey)}/ssh/approvals${query.length === 0 ? "" : `?${query}`}`;
}

async function refresh(): Promise<void> {
  if (inFlight || props.appKey.length === 0) return;
  inFlight = true;
  try {
    const data = await apiQuery<ChatSshApprovalsResponse>(basePath());
    approvals.value = data.approvals ?? [];
    emit("update:count", approvals.value.length);
    error.value = null;
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Could not load SSH approvals.";
  } finally {
    inFlight = false;
  }
}

async function decide(approval: SshApprovalView, decision: "approve" | "reject"): Promise<void> {
  if (props.disabled || busy.value.has(approval.id)) return;
  const next = new Set(busy.value);
  next.add(approval.id);
  busy.value = next;
  try {
    const params = props.project.length === 0 ? "" : `?project=${encoded(props.project)}`;
    await apiMutation<unknown>(
      `/api/apps/${encoded(props.appKey)}/ssh/approvals/${encoded(approval.id)}/decision${params}`,
      { json: { decision } },
    );
    await refresh();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Could not record this decision.";
  } finally {
    const remaining = new Set(busy.value);
    remaining.delete(approval.id);
    busy.value = remaining;
  }
}

function tick(): void {
  if (typeof document !== "undefined" && document.hidden) return;
  void refresh();
}

function onVisibility(): void {
  if (typeof document !== "undefined" && !document.hidden) void refresh();
}

onMounted(() => {
  void refresh();
  timer = setInterval(tick, props.intervalMs);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
});

onBeforeUnmount(() => {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
});
</script>

<template>
  <section
    v-if="approvals.length > 0 || error !== null"
    class="chat-context__section"
    data-chat-ssh-approvals
    aria-labelledby="context-ssh-approvals-title"
  >
    <div class="cluster summary-row">
      <h2 class="overline" id="context-ssh-approvals-title">SSH approvals</h2>
      <span class="caption">{{ approvals.length }} pending</span>
    </div>
    <p v-if="error !== null" class="field-error" role="alert">{{ error }}</p>
    <div class="stack--tight">
      <section
        v-for="approval in approvals"
        :key="approval.id"
        class="card ssh-approval-card"
        :data-approval-id="approval.id"
      >
        <div class="card__body stack--tight">
          <p class="overline">SSH approval required</p>
          <h3 class="card__title">{{ approval.hostName }} · {{ approval.action }}</h3>
          <pre class="ssh-command">{{ approval.commandPreview }}</pre>
          <p class="small">
            Requested {{ approval.requestedAt }}; expires {{ approval.expiresAt }}. Approving grants
            this application arbitrary command execution on this host while the grant is active.
          </p>
          <div class="cluster">
            <button
              class="btn btn-primary btn-sm"
              type="button"
              data-ssh-approve
              :disabled="disabled || busy.has(approval.id)"
              @click="decide(approval, 'approve')"
            >
              <AppIcon name="check" />Approve
            </button>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              data-ssh-reject
              :disabled="disabled || busy.has(approval.id)"
              @click="decide(approval, 'reject')"
            >
              Reject
            </button>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>
