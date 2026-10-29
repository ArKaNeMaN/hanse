<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type {
  AppSshAllowlistResponse,
  AppSshApprovalProps,
  AppSshApprovalStatus,
  AppSshAuditProps,
  AppSshAuditResponse,
  AppSshGrantProps,
  AppSshGrantState,
  AppSshHostProps,
  AppSshProps,
} from "../app-types.js";
import { absoluteTime, timeAgo } from "../format.js";
import type { PillSpec } from "../status.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  ssh: AppSshProps;
  projectId: string;
  appKey: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();
const toasts = useToastStore();

const GRANT_PILLS: Record<AppSshGrantState, PillSpec> = {
  active: { variant: "status", dataState: "delivered", icon: "check", label: "Active" },
  expired: { variant: "status", dataState: "expired", icon: "hourglass", label: "Expired" },
  revoked: { variant: "status", dataState: "cancelled", icon: "slash", label: "Revoked" },
};

const APPROVAL_PILLS: Record<AppSshApprovalStatus, PillSpec> = {
  pending: {
    variant: "status",
    dataState: "awaiting_approval",
    icon: "stamp",
    label: "Pending",
  },
  approved: { variant: "status", dataState: "delivered", icon: "check", label: "Approved" },
  rejected: { variant: "status", dataState: "rejected", icon: "x", label: "Rejected" },
  expired: { variant: "status", dataState: "expired", icon: "hourglass", label: "Expired" },
  superseded: { variant: "status", dataState: "cancelled", icon: "slash", label: "Superseded" },
};

const OUTCOME_PILLS: Record<string, PillSpec> = {
  running: { variant: "status", dataState: "in_progress", icon: "loader", label: "Running" },
  error: { variant: "status", dataState: "failed", icon: "alert-triangle", label: "Error" },
  ok: { variant: "status", dataState: "delivered", icon: "check", label: "OK" },
  exit: { variant: "status", dataState: "rejected", icon: "x", label: "Exit" },
  recorded: { variant: "status", dataState: "queued", icon: "clock", label: "Recorded" },
};

const hosts = ref<readonly AppSshHostProps[]>([]);
const allowed = ref<string[]>([]);
const hostsLoaded = ref(false);
const hostsLoading = ref(false);
const hostsError = ref<string | null>(null);
const auditRows = ref<readonly AppSshAuditProps[]>(props.ssh.audit);
const busy = ref<string | null>(null);

watch(
  () => props.ssh.audit,
  (rows) => {
    auditRows.value = rows;
  },
);

const allowedUrl = computed(
  () =>
    `/api/projects/${encodeURIComponent(props.projectId)}/apps/${encodeURIComponent(props.appKey)}/ssh`,
);
const auditUrl = computed(
  () =>
    `/api/apps/${encodeURIComponent(props.appKey)}/ssh/audit?project=${encodeURIComponent(props.projectId)}&limit=30`,
);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error
    ? error.message.length > 0
      ? error.message
      : fallback
    : fallback;
}

function grantPill(grant: AppSshGrantProps): PillSpec {
  return GRANT_PILLS[grant.state];
}

function approvalPill(approval: AppSshApprovalProps): PillSpec {
  return APPROVAL_PILLS[approval.status];
}

function auditPill(entry: AppSshAuditProps): PillSpec {
  return OUTCOME_PILLS[entry.outcome] ?? OUTCOME_PILLS.recorded ?? APPROVAL_PILLS.pending;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function isAllowed(hostId: string): boolean {
  return allowed.value.includes(hostId);
}

function toggleHost(hostId: string): void {
  allowed.value = isAllowed(hostId)
    ? allowed.value.filter((id) => id !== hostId)
    : [...allowed.value, hostId];
}

async function loadHosts(): Promise<void> {
  if (hostsLoaded.value || hostsLoading.value) return;
  hostsLoading.value = true;
  hostsError.value = null;
  try {
    const [all, scoped] = await Promise.all([
      apiQuery<{ hosts: readonly AppSshHostProps[] }>("/api/ssh/hosts"),
      apiQuery<AppSshAllowlistResponse>(allowedUrl.value),
    ]);
    const allowedIds = new Set(scoped.hosts.map((host) => host.id));
    hosts.value = all.hosts.map((host) => ({ ...host, allowed: allowedIds.has(host.id) }));
    allowed.value = scoped.hosts.map((host) => host.id);
    hostsLoaded.value = true;
  } catch (error) {
    hostsError.value = errorMessage(error, "Could not load the SSH allowlist.");
  } finally {
    hostsLoading.value = false;
  }
}

async function saveAllowlist(): Promise<void> {
  if (busy.value !== null || props.disabled === true) return;
  busy.value = "allowlist";
  try {
    await apiMutation<AppSshAllowlistResponse>(allowedUrl.value, {
      json: { hostIds: allowed.value },
    });
    hostsLoaded.value = false;
    await loadHosts();
    toasts.push("Allowlist saved", "success");
    emit("changed");
  } catch (error) {
    toasts.push(errorMessage(error, "Could not save the SSH allowlist."), "error");
  } finally {
    busy.value = null;
  }
}

async function revokeGrant(grant: AppSshGrantProps): Promise<void> {
  if (busy.value !== null || props.disabled === true) return;
  busy.value = `revoke:${grant.id}`;
  try {
    await apiMutation(`${allowedUrl.value}/grants/${encodeURIComponent(grant.id)}/revoke`, {
      json: {},
    });
    toasts.push("Grant revoked", "success");
    emit("changed");
  } catch (error) {
    toasts.push(errorMessage(error, "Could not revoke the grant."), "error");
  } finally {
    busy.value = null;
  }
}

async function decide(
  approval: AppSshApprovalProps,
  decision: "approve" | "reject",
): Promise<void> {
  if (busy.value !== null || props.disabled === true) return;
  busy.value = `decision:${approval.id}:${decision}`;
  try {
    await apiMutation(
      `/api/apps/${encodeURIComponent(props.appKey)}/ssh/approvals/${encodeURIComponent(approval.id)}/decision?project=${encodeURIComponent(props.projectId)}`,
      { json: { decision } },
    );
    toasts.push("Approval recorded", "success");
    emit("changed");
  } catch (error) {
    toasts.push(errorMessage(error, "Could not record the approval."), "error");
  } finally {
    busy.value = null;
  }
}

async function refreshAudit(): Promise<void> {
  if (busy.value !== null) return;
  busy.value = "audit";
  try {
    const data = await apiQuery<AppSshAuditResponse>(auditUrl.value);
    auditRows.value = data.audit;
    toasts.push("Audit refreshed.", "success");
  } catch (error) {
    toasts.push(errorMessage(error, "Could not refresh the SSH audit."), "error");
  } finally {
    busy.value = null;
  }
}

function onManageToggle(event: Event): void {
  const target = event.currentTarget;
  if (target instanceof HTMLDetailsElement && target.open) void loadHosts();
}
</script>

<template>
  <section class="card section" id="ssh-panel" aria-labelledby="ssh-panel-title">
    <div class="card__head">
      <h2 class="card__title" id="ssh-panel-title">SSH access</h2>
      <a class="btn btn-ghost btn-sm" id="ssh-manage" :href="ssh.href">
        <AppIcon name="terminal" />Manage
      </a>
    </div>
    <div class="card__body stack--tight">
      <p class="small">{{ plural(ssh.hosts, "allowed host") }}</p>
      <p v-if="ssh.pendingApprovals > 0" class="cluster">
        <span class="status" data-state="awaiting_approval">
          <AppIcon name="stamp" />{{ plural(ssh.pendingApprovals, "pending approval") }}
        </span>
      </p>
      <p v-else-if="ssh.available" class="small">No pending approvals.</p>
      <p v-if="!ssh.available" class="hint" id="ssh-unavailable">
        SSH access is unavailable. Open the SSH console to configure hosts.
      </p>
    </div>

    <template v-if="ssh.available">
      <details class="disclosure" id="ssh-access-manage" @toggle="onManageToggle">
        <summary>
          Manage allowed hosts<AppIcon name="chevron-down" class-name="disclosure__chevron" />
        </summary>
        <div class="card__body stack--tight">
          <p class="hint">
            Only checked hosts are available to this application. Unchecking a host revokes its
            active grant.
          </p>
          <p v-if="hostsLoading" class="hint" role="status">Loading hosts…</p>
          <p v-if="hostsError !== null" class="field-error" role="alert">{{ hostsError }}</p>
          <ul v-if="hostsLoaded" class="stack--tight" id="ssh-allowlist">
            <li v-for="host in hosts" :key="host.id" class="cluster">
              <label class="check">
                <input
                  class="checkbox"
                  type="checkbox"
                  :value="host.id"
                  :checked="isAllowed(host.id)"
                  :disabled="disabled || busy !== null"
                  @change="toggleHost(host.id)"
                >
                <span>{{ host.name }}</span>
              </label>
              <span class="mono small">{{ host.address }}</span>
            </li>
          </ul>
          <div class="cluster">
            <button
              class="btn btn-secondary btn-sm"
              id="ssh-allowlist-save"
              type="button"
              :disabled="disabled || busy !== null || !hostsLoaded"
              :aria-busy="busy === 'allowlist' ? 'true' : undefined"
              @click="saveAllowlist"
            >
              <AppIcon name="check" />{{ busy === "allowlist" ? "Saving…" : "Save allowlist" }}
            </button>
          </div>
        </div>
      </details>

      <div class="card__head">
        <h3 class="card__title" id="ssh-grants-title">Active grants</h3>
        <span class="mono">{{ ssh.grants.length }}</span>
      </div>
      <div class="card__body" :class="{ 'card__body--flush': ssh.grants.length > 0 }">
        <p v-if="ssh.grants.length === 0" class="hint">No app-scoped grants.</p>
        <div v-else class="table-wrap">
          <table class="table table--stack" id="ssh-grants" aria-labelledby="ssh-grants-title">
            <thead>
              <tr>
                <th scope="col">Host</th>
                <th scope="col">State</th>
                <th scope="col">Granted</th>
                <th scope="col">Last used</th>
                <th scope="col">Idle expires</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="grant in ssh.grants" :key="grant.id">
                <td data-label="Host">
                  <span class="mono">{{ grant.hostName }}</span>
                </td>
                <td data-label="State"><StatusPill :pill="grantPill(grant)" /></td>
                <td data-label="Granted">
                  <time :datetime="grant.grantedAt" :title="absoluteTime(grant.grantedAt)">
                    {{ timeAgo(grant.grantedAt) }}
                  </time>
                </td>
                <td data-label="Last used">
                  <time :datetime="grant.lastUsedAt" :title="absoluteTime(grant.lastUsedAt)">
                    {{ timeAgo(grant.lastUsedAt) }}
                  </time>
                </td>
                <td data-label="Idle expires">
                  <time :datetime="grant.idleExpiresAt" :title="absoluteTime(grant.idleExpiresAt)">
                    {{ absoluteTime(grant.idleExpiresAt) }}
                  </time>
                </td>
                <td data-label="Actions">
                  <button
                    v-if="grant.state !== 'revoked'"
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="disabled || busy !== null"
                    :aria-busy="busy === `revoke:${grant.id}` ? 'true' : undefined"
                    @click="revokeGrant(grant)"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card__head">
        <h3 class="card__title" id="ssh-approvals-title">Pending approvals</h3>
        <span class="mono">{{ ssh.approvals.length }}</span>
      </div>
      <div class="card__body" :class="{ 'card__body--flush': ssh.approvals.length > 0 }">
        <p v-if="ssh.approvals.length === 0" class="hint">No pending approvals.</p>
        <div v-else class="table-wrap">
          <table
            class="table table--stack"
            id="ssh-approvals"
            aria-labelledby="ssh-approvals-title"
          >
            <thead>
              <tr>
                <th scope="col">Host</th>
                <th scope="col">Action</th>
                <th scope="col">Command</th>
                <th scope="col">State</th>
                <th scope="col">Expires</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="approval in ssh.approvals" :key="approval.id">
                <td data-label="Host"><span class="mono">{{ approval.hostName }}</span></td>
                <td data-label="Action">
                  <span class="badge badge--mono">{{ approval.action }}</span>
                </td>
                <td data-label="Command">
                  <span class="mono">{{ approval.commandPreview }}</span>
                </td>
                <td data-label="State"><StatusPill :pill="approvalPill(approval)" /></td>
                <td data-label="Expires">
                  <time :datetime="approval.expiresAt" :title="absoluteTime(approval.expiresAt)">
                    {{ absoluteTime(approval.expiresAt) }}
                  </time>
                </td>
                <td data-label="Actions">
                  <button
                    class="btn btn-primary btn-sm"
                    type="button"
                    :disabled="disabled || busy !== null"
                    :aria-busy="busy === `decision:${approval.id}:approve` ? 'true' : undefined"
                    @click="decide(approval, 'approve')"
                  >
                    Approve
                  </button>
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="disabled || busy !== null"
                    :aria-busy="busy === `decision:${approval.id}:reject` ? 'true' : undefined"
                    @click="decide(approval, 'reject')"
                  >
                    Reject
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card__head">
        <h3 class="card__title" id="ssh-audit-title">Recent audit</h3>
        <div class="cluster">
          <span class="mono">{{ auditRows.length }}</span>
          <button
            class="btn btn-ghost btn-icon btn-sm"
            id="ssh-audit-refresh"
            type="button"
            aria-label="Refresh SSH audit"
            title="Refresh SSH audit"
            :disabled="busy !== null"
            @click="refreshAudit"
          >
            <AppIcon name="refresh" />
          </button>
        </div>
      </div>
      <div class="card__body" :class="{ 'card__body--flush': auditRows.length > 0 }">
        <p v-if="auditRows.length === 0" class="hint">No audit entries.</p>
        <div v-else class="table-wrap">
          <table class="table table--stack" id="ssh-audit" aria-labelledby="ssh-audit-title">
            <thead>
              <tr>
                <th scope="col">Host</th>
                <th scope="col">Action</th>
                <th scope="col">Command</th>
                <th scope="col">Outcome</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in auditRows" :key="entry.id">
                <td data-label="Host"><span class="mono">{{ entry.hostName }}</span></td>
                <td data-label="Action">
                  <span class="badge badge--mono">{{ entry.action }}</span>
                </td>
                <td data-label="Command">
                  <span class="mono">{{ entry.commandPreview ?? "—" }}</span>
                </td>
                <td data-label="Outcome"><StatusPill :pill="auditPill(entry)" /></td>
                <td data-label="Started">
                  <time :datetime="entry.startedAt" :title="absoluteTime(entry.startedAt)">
                    {{ timeAgo(entry.startedAt) }}
                  </time>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>
