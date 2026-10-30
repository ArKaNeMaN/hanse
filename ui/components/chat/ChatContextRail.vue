<script setup lang="ts">
/**
 * Context rail: application, previews, context/compact, plan/todo, saved permissions, handoffs,
 * SSH approvals, restart pending, and policy warnings. It owns no network reads except the SSH
 * cards' polling; every other action is emitted to `ChatPage`, which already owns those stores.
 */
import { computed, ref } from "vue";
import {
  autoCompactText,
  contextChipLabel,
  contextDetail,
  contextErrorText,
  contextMeterPercent,
  contextStateClass,
  contextSummary,
} from "../../../assets/chat-core.js";
import type { ContextSnapshot } from "../../../src/opencode/context.js";
import type { NormalizedSavedPermission, NormalizedTodo } from "../../../src/opencode/prompts.js";
import type { PreviewView } from "../../../src/preview/types.js";
import type { ChatResponse } from "../../chat/types.js";
import AppIcon from "../AppIcon.vue";
import ChatSshApprovals from "./ChatSshApprovals.vue";

const props = defineProps<{
  view: ChatResponse;
  sessionId: string | null;
  snapshot: ContextSnapshot | null;
  todos: readonly NormalizedTodo[];
  todosTruncated?: boolean;
  previews: readonly PreviewView[];
  savedPermissions: readonly NormalizedSavedPermission[];
  policyWarnings: readonly string[];
  compactBusy: boolean;
  compactError: string | null;
  deletionPending: boolean;
}>();

const emit = defineEmits<{
  close: [];
  compact: [];
  restart: [];
  "close-preview": [key: string];
  "revoke-saved": [id: string];
  "dismiss-policy": [warning: string];
}>();

const confirmCompact = ref(false);
const revokeConfirm = ref<string | null>(null);

const percent = computed(() => contextMeterPercent(props.snapshot));
const contextState = computed(() => contextStateClass(props.snapshot));
const summary = computed(() => contextSummary(props.snapshot));
const detail = computed(() => contextDetail(props.snapshot));
const chipLabel = computed(() => contextChipLabel(props.snapshot));
const autoText = computed(() => autoCompactText(props.snapshot));
const contextError = computed(() =>
  props.snapshot?.lastError === null || props.snapshot?.lastError === undefined
    ? null
    : contextErrorText(props.snapshot.lastError),
);

const todoCounts = computed(() => {
  const counts = { completed: 0, total: 0, active: 0 };
  for (const todo of props.todos) {
    if (todo.status === "cancelled") continue;
    counts.total += 1;
    if (todo.status === "completed") counts.completed += 1;
    else if (todo.status === "in_progress") counts.active += 1;
  }
  return counts;
});

const compactReason = computed<string | null>(() => {
  if (props.sessionId === null) return "Start a session to compact.";
  if (props.compactBusy) return "Compaction starting…";
  if (props.snapshot === null) return "Loading context…";
  if (props.snapshot.state === "compacting") return "Compaction in progress.";
  if (props.snapshot.topLevel === false)
    return "Compaction is only available for top-level sessions.";
  if (props.snapshot.status === "busy") return "Wait for the agent to finish.";
  if (props.snapshot.status === "retry") return "Wait for the agent to retry.";
  if (props.snapshot.activeChildren === true) return "Wait for child sessions to finish.";
  if (props.snapshot.pendingTask === true) return "Wait for the active task to finish.";
  if (props.snapshot.model === null) return "No model is known for this session.";
  if (props.deletionPending) return "This application is pending deletion.";
  return null;
});

const compactDisabled = computed(() => compactReason.value !== null);

function todoStatus(status: string): { icon: string; label: string } {
  switch (status) {
    case "completed":
      return { icon: "check", label: "Done" };
    case "in_progress":
      return { icon: "activity", label: "Now" };
    case "cancelled":
      return { icon: "slash", label: "Dropped" };
    default:
      return { icon: "clock", label: "Pending" };
  }
}

function startCompact(): void {
  if (compactDisabled.value) return;
  confirmCompact.value = true;
}

function applyCompact(): void {
  confirmCompact.value = false;
  emit("compact");
}

function requestRevoke(id: string): void {
  if (props.deletionPending) return;
  if (revokeConfirm.value === id) {
    revokeConfirm.value = null;
    emit("revoke-saved", id);
    return;
  }
  revokeConfirm.value = id;
}
</script>

<template>
  <aside class="chat-context" id="chat-context" data-chat-context-rail aria-label="Context">
    <div class="chat-pane-head">
      <span class="overline">Context</span>
      <button
        class="btn btn-ghost btn-icon btn-sm chat-context-close"
        type="button"
        data-chat-context-close
        aria-label="Close context"
        @click="emit('close')"
      >
        <AppIcon name="x" />
      </button>
    </div>

    <div class="chat-context__body">
      <section class="chat-context__section" aria-labelledby="context-app-title">
        <p class="overline">Application</p>
        <div class="summary-row">
          <h2 class="h3" id="context-app-title">{{ view.app.appKey }}</h2>
          <span class="status" :data-state="view.runtime.state">
            {{ view.runtime.state }}
          </span>
        </div>
        <a class="small" :href="`/projects/${encodeURIComponent(view.app.projectId)}`">
          {{ view.app.projectName }}
        </a>
        <p class="mono">{{ view.app.folder }}</p>
        <div class="cluster">
          <a
            class="btn btn-secondary btn-sm"
            :href="view.links.ide"
            target="_blank"
            rel="noreferrer"
          >
            <AppIcon name="external" />Open IDE
          </a>
          <a class="btn btn-ghost btn-sm" :href="view.links.app">Application</a>
          <a class="btn btn-ghost btn-sm" :href="view.links.settings">
            <AppIcon name="settings" />Settings
          </a>
        </div>

        <div v-if="view.pendingRestart" class="stack--tight" data-chat-restart-pending>
          <div class="cluster">
            <span class="badge badge-warning">Restart required</span>
            <span class="small">Settings changed</span>
          </div>
          <p class="hint">
            Restart the agent to apply the new model, auth, or web tools. An active turn will be
            interrupted.
          </p>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            data-chat-restart
            :disabled="deletionPending"
            @click="emit('restart')"
          >
            <AppIcon name="refresh" />Restart agent
          </button>
        </div>
      </section>

      <section
        v-if="policyWarnings.length > 0"
        class="chat-context__section policy-warning"
        id="chat-policy-warning"
        role="status"
        data-chat-policy-warning
      >
        <div class="policy-warning__lead">
          <span class="policy-warning__mark"><AppIcon name="alert-triangle" /></span>
          <span class="policy-warning__label">Policy warning</span>
        </div>
        <ul class="policy-warning__list">
          <li v-for="warning in policyWarnings" :key="warning">
            <span>{{ warning }}</span>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              data-policy-dismiss
              aria-label="Dismiss policy warning"
              @click="emit('dismiss-policy', warning)"
            >
              Dismiss
            </button>
          </li>
        </ul>
      </section>

      <div v-if="previews.length > 0" class="chat-context__group" id="chat-previews">
        <hr class="rule">
        <section class="chat-context__section" aria-labelledby="context-previews-title">
          <div class="cluster summary-row">
            <h2 class="overline" id="context-previews-title">Previews</h2>
            <span class="caption">{{ previews.length }} active</span>
          </div>
          <p class="hint">Demo only. Preview pages share the coordinator's origin and session.</p>
          <ul class="chat-previews">
            <li
              v-for="preview in previews"
              :key="preview.key"
              class="chat-preview"
              :data-preview-key="preview.key"
            >
              <a
                class="chat-preview__link"
                :href="preview.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="preview.name"
              >
                <span class="chat-preview__name">{{ preview.name }}</span>
                <span class="chat-preview__key mono" :title="preview.key">{{ preview.key }}</span>
                <AppIcon name="external" />
                <span class="sr-only">(opens in a new tab)</span>
              </a>
              <button
                class="btn btn-ghost btn-icon btn-sm chat-preview__close"
                type="button"
                :aria-label="`Close preview ${preview.name}`"
                :disabled="deletionPending"
                @click="emit('close-preview', preview.key)"
              >
                <AppIcon name="x" />
              </button>
            </li>
          </ul>
        </section>
      </div>

      <section
        class="chat-context__section chat-context-usage"
        id="chat-context-usage"
        :data-state="contextState"
        aria-labelledby="context-usage-title"
      >
        <div class="cluster summary-row">
          <h2 class="overline" id="context-usage-title" tabindex="-1">Context</h2>
          <span class="caption" data-chat-context-summary>{{ summary }}</span>
        </div>
        <!-- biome-ignore lint/a11y/useSemanticElements: keep the legacy meter markup and classes -->
        <div
          class="chat-context-usage__meter"
          role="meter"
          aria-label="Context usage"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent"
          :aria-valuetext="chipLabel"
        >
          <span
            class="chat-context-usage__fill"
            :style="{ width: `${percent}%` }"
            aria-hidden="true"
          />
        </div>
        <p class="caption" data-chat-context-detail>{{ detail }}</p>
        <div class="cluster summary-row">
          <p class="hint">{{ autoText }}</p>
          <a class="btn btn-ghost btn-sm" :href="view.links.settings">
            <AppIcon name="settings" />Settings
          </a>
        </div>
        <div class="cluster">
          <button
            class="btn btn-secondary btn-sm"
            type="button"
            data-chat-compact
            :disabled="compactDisabled"
            :aria-busy="compactBusy"
            @click="startCompact"
          >
            Compact now
          </button>
        </div>
        <p v-if="compactReason !== null" class="hint" data-chat-compact-reason>
          {{ compactReason }}
        </p>
        <div v-if="confirmCompact" class="chat-context-usage__confirm" data-chat-compact-confirm>
          <p class="caption">Summarization replaces the session history and can lose detail.</p>
          <div class="cluster">
            <button
              class="btn btn-danger btn-sm"
              type="button"
              data-chat-compact-apply
              @click="applyCompact"
            >
              Compact now
            </button>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              data-chat-compact-cancel
              @click="confirmCompact = false"
            >
              Cancel
            </button>
          </div>
        </div>
        <p v-if="compactError !== null" class="field-error" role="alert" data-chat-compact-error>
          {{ compactError }}
        </p>
        <p v-if="contextError !== null" class="field-error" role="alert">
          {{ contextError }}
        </p>
      </section>

      <div v-if="todos.length > 0" class="chat-context__group">
        <hr class="rule">
        <section
          class="chat-context__section chat-plan-section"
          id="chat-plan-section"
          data-chat-plan-section
          aria-labelledby="context-plan-title"
        >
          <div class="cluster summary-row">
            <h2 class="overline" id="context-plan-title" tabindex="-1">Plan</h2>
            <span class="caption" data-chat-plan-summary>
              {{ todoCounts.completed }}/{{ todoCounts.total }}
              done
            </span>
          </div>
          <ul class="chat-plan__list">
            <li
              v-for="(todo, index) in todos"
              :key="`${index}-${todo.content}`"
              class="chat-plan__item"
              :data-status="todo.status"
            >
              <span class="chat-plan__status">
                <AppIcon :name="todoStatus(todo.status).icon" />
                {{ todoStatus(todo.status).label }}
              </span>
              <span class="chat-plan__content">{{ todo.content }}</span>
            </li>
          </ul>
          <p v-if="todosTruncated" class="hint">Plan truncated.</p>
        </section>
      </div>

      <div v-if="savedPermissions.length > 0" class="chat-context__group">
        <hr class="rule">
        <section
          class="chat-context__section"
          id="chat-saved-section"
          data-chat-saved-section
          aria-labelledby="context-saved-title"
        >
          <div class="cluster summary-row">
            <h2 class="overline" id="context-saved-title">Saved permissions</h2>
            <span class="badge">{{ savedPermissions.length }}</span>
          </div>
          <p class="caption">Durable project grants. Revoke to restore the policy.</p>
          <div class="chat-saved">
            <div
              v-for="permission in savedPermissions"
              :key="permission.id"
              class="chat-saved__row"
              :data-saved-permission="permission.id"
            >
              <div class="chat-saved__meta">
                <span class="chat-saved__action mono">{{ permission.action || "permission" }}</span>
                <span class="chat-saved__resource mono">{{ permission.resource || "*" }}</span>
                <span class="chat-saved__project mono">
                  {{
                    permission.projectID.length > 0
                      ? `project ${permission.projectID}`
                      : "project unknown"
                  }}
                </span>
              </div>
              <div class="chat-saved__actions">
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  data-saved-revoke
                  :aria-label="`Revoke ${permission.action || 'saved permission'}`"
                  :disabled="deletionPending"
                  @click="requestRevoke(permission.id)"
                >
                  {{ revokeConfirm === permission.id ? "Confirm revoke" : "Revoke" }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      <hr class="rule">
      <section class="chat-context__section" aria-labelledby="context-handoffs-title">
        <div class="cluster summary-row">
          <h2 class="overline" id="context-handoffs-title">Handoffs</h2>
          <a class="btn btn-ghost btn-sm" :href="view.links.handoffs">Open inbox</a>
        </div>
        <div v-if="view.handoffs.length === 0" class="empty-state" data-chat-handoffs-empty>
          <p class="empty-state__title">No handoffs</p>
          <p class="empty-state__body">No handoff routes involve {{ view.app.appKey }} yet.</p>
        </div>
        <div v-else class="stack--tight" data-chat-handoffs>
          <a
            v-for="handoff in view.handoffs"
            :key="handoff.id"
            class="context-handoff"
            :href="handoff.href"
          >
            <span class="context-handoff__head">
              <span class="mono table__nowrap">{{ handoff.shortId }}</span>
              <span class="status" :data-state="handoff.state">{{ handoff.state }}</span>
            </span>
            <span class="context-handoff__summary">{{ handoff.summary }}</span>
          </a>
        </div>
      </section>

      <ChatSshApprovals
        :app-key="view.app.appKey"
        :project="view.app.projectId"
        :disabled="deletionPending"
      />

      <hr class="rule">
      <section class="chat-context__section" aria-labelledby="context-shortcuts-title">
        <p class="overline" id="context-shortcuts-title">Shortcuts</p>
        <div class="cluster">
          <a class="btn btn-ghost btn-sm" :href="view.links.handoffs">Handoff inbox</a>
          <a
            class="btn btn-ghost btn-sm"
            :href="`/projects/${encodeURIComponent(view.app.projectId)}`"
          >
            Project
          </a>
          <a class="btn btn-ghost btn-sm" :href="view.links.ide" target="_blank" rel="noreferrer">
            IDE
          </a>
        </div>
      </section>
    </div>
  </aside>
</template>
