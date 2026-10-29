<script setup lang="ts">
import type {
  AppSshApprovalProps,
  AppSshApprovalStatus,
  AppSshAuditProps,
  AppSshGrantProps,
  AppSshGrantState,
  AppSshProps,
} from "../app-types.js";
import { absoluteTime, timeAgo } from "../format.js";
import type { PillSpec } from "../status.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

defineProps<{ ssh: AppSshProps }>();

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
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card__head">
        <h3 class="card__title" id="ssh-audit-title">Recent audit</h3>
        <span class="mono">{{ ssh.audit.length }}</span>
      </div>
      <div class="card__body" :class="{ 'card__body--flush': ssh.audit.length > 0 }">
        <p v-if="ssh.audit.length === 0" class="hint">No audit entries.</p>
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
              <tr v-for="entry in ssh.audit" :key="entry.id">
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
