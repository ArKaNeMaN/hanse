<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import SshHostDialog from "../components/SshHostDialog.vue";
import { applyChrome } from "../composables/useChrome.js";
import { useSectionNav } from "../composables/useSectionNav.js";
import { absoluteTime, timeAgo } from "../format.js";
import type {
  SshApproval,
  SshAuditEntry,
  SshGrant,
  SshHost,
  SshProps,
  SshResponse,
  SshTestResult,
} from "../ssh-types.js";
import { useToastStore } from "../stores/toasts.js";

const EMPTY_COUNTS = {
  hosts: 0,
  pinned: 0,
  unpinned: 0,
  mismatch: 0,
  pendingApprovals: 0,
  activeGrants: 0,
  grants: 0,
  allowedHosts: 0,
  auditRows: 0,
} as const;

interface Pill {
  readonly state: string;
  readonly icon: string;
  readonly label: string;
}

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

const SSH_SECTION_IDS = ["ssh-hosts", "ssh-access", "ssh-approvals", "ssh-audit"] as const;
const { activeId: activeSection, activate: activateSection } = useSectionNav(SSH_SECTION_IDS);

function queryString(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

function scopeFromRoute(): { projectId: string; appKey: string; query: string } {
  const target = queryString(route.query.target);
  if (target.includes(":")) {
    const separator = target.indexOf(":");
    return {
      projectId: target.slice(0, separator),
      appKey: target.slice(separator + 1),
      query: `target=${encodeURIComponent(target)}`,
    };
  }
  const project = queryString(route.query.project);
  const app = queryString(route.query.app);
  if (project.length > 0 && app.length > 0) {
    return {
      projectId: project,
      appKey: app,
      query: `project=${encodeURIComponent(project)}&app=${encodeURIComponent(app)}`,
    };
  }
  return { projectId: "", appKey: "", query: "" };
}

const routeScope = computed(scopeFromRoute);
const scopeTarget = ref(
  routeScope.value.projectId.length > 0 && routeScope.value.appKey.length > 0
    ? `${routeScope.value.projectId}:${routeScope.value.appKey}`
    : "",
);
watch(routeScope, (scope) => {
  scopeTarget.value =
    scope.projectId.length > 0 && scope.appKey.length > 0
      ? `${scope.projectId}:${scope.appKey}`
      : "";
});

function expectedHref(): string {
  const scope = routeScope.value;
  return scope.projectId.length > 0 && scope.appKey.length > 0
    ? `/ssh?target=${encodeURIComponent(`${scope.projectId}:${scope.appKey}`)}`
    : "/ssh";
}

const bootProps = computed<SshProps | undefined>(() => {
  if (props.boot.route.id !== "ssh") {
    return undefined;
  }
  const value = props.boot.props;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as SshProps;
  return candidate.scope?.href === expectedHref() ? candidate : undefined;
});

const apiPath = computed(() =>
  routeScope.value.query.length === 0 ? "/api/ui/ssh" : `/api/ui/ssh?${routeScope.value.query}`,
);

const sshQuery = useQuery<SshResponse>({
  queryKey: computed(() => ["ssh", routeScope.value.query]),
  queryFn: () => apiQuery<SshResponse>(apiPath.value),
  initialData: () => bootProps.value,
  staleTime: 30_000,
  retry: false,
});

const view = computed<SshProps | undefined>(() => sshQuery.data.value ?? bootProps.value);
const counts = computed(() => view.value?.counts ?? EMPTY_COUNTS);
const loading = computed(() => sshQuery.isFetching.value);
const failed = computed(() => sshQuery.isError.value);
const failure = computed(() => {
  const error = sshQuery.error.value;
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Could not load the SSH console.";
});

const addDialog = ref<InstanceType<typeof SshHostDialog> | null>(null);
const editDialog = ref<InstanceType<typeof SshHostDialog> | null>(null);
const editingHost = ref<SshHost | null>(null);
const busyKey = ref<string | null>(null);
const testResults = ref<Partial<Record<string, SshTestResult>>>({});
const repinValues = ref<Record<string, string>>({});
const allowedHostIds = ref<ReadonlySet<string>>(new Set());

watch(
  () => view.value?.hosts,
  (hosts) => {
    allowedHostIds.value = new Set(
      (hosts ?? []).filter((host) => host.allowed).map((host) => host.id),
    );
  },
  { immediate: true },
);

function pinPill(host: SshHost): Pill {
  if (host.pinState === "mismatch") {
    return { state: "failed", icon: "alert-triangle", label: "Host key changed" };
  }
  if (host.pinState === "unpinned") {
    return { state: "queued", icon: "clock", label: "Not pinned" };
  }
  return { state: "delivered", icon: "check", label: "Pinned" };
}

function grantPill(grant: SshGrant): Pill {
  if (grant.state === "revoked") {
    return { state: "cancelled", icon: "slash", label: "Revoked" };
  }
  if (grant.state === "expired") {
    return { state: "expired", icon: "hourglass", label: "Expired" };
  }
  return { state: "delivered", icon: "check", label: "Active" };
}

function auditPill(entry: SshAuditEntry): Pill & { readonly className: string } {
  if (entry.outcome === "running") {
    return { state: "activity", className: "badge-info", icon: "activity", label: "running" };
  }
  if (entry.outcome === "error") {
    return {
      state: "failed",
      className: "badge-error",
      icon: "alert-triangle",
      label: entry.errorCode ?? "error",
    };
  }
  if (entry.outcome === "ok") {
    return { state: "delivered", className: "badge-success", icon: "check", label: "ok" };
  }
  if (entry.outcome === "exit") {
    return {
      state: "failed",
      className: "badge-error",
      icon: "alert-triangle",
      label: `exit ${entry.exitCode ?? ""}`,
    };
  }
  return { state: "recorded", className: "badge-ghost", icon: "check", label: "recorded" };
}

function shortFingerprint(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
    return "Not set";
  }
  return value.length <= 28 ? value : `${value.slice(0, 20)}…${value.slice(-8)}`;
}

function timeUntil(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  if (seconds <= 0) {
    return timeAgo(iso, now);
  }
  if (seconds < 45) {
    return "in a moment";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `in ${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

function testFor(host: SshHost): SshTestResult | undefined {
  return testResults.value[host.id];
}

function testKeyOpen(host: SshHost): boolean {
  const test = testFor(host);
  return (test?.prepareRePin === true && test.ok) || host.pinState === "mismatch";
}

function repinValue(host: SshHost): string {
  return repinValues.value[host.id] ?? "";
}

function setRepinValue(host: SshHost, value: string): void {
  repinValues.value = { ...repinValues.value, [host.id]: value };
}

function onRepinInput(host: SshHost, event: Event): void {
  const input = event.target;
  if (input instanceof HTMLInputElement) {
    setRepinValue(host, input.value);
  }
}

function pageErrorFor(target: string): string | null {
  return view.value?.error?.target === target ? view.value.error.message : null;
}

async function refreshChromeAndProps(): Promise<void> {
  const result = await sshQuery.refetch();
  const chrome = (result.data as SshResponse | undefined)?.chrome;
  if (chrome !== undefined) {
    applyChrome(chrome);
  }
}

function openAdd(): void {
  addDialog.value?.open();
}

async function openEdit(host: SshHost): Promise<void> {
  editingHost.value = host;
  await nextTick();
  editDialog.value?.open();
}

async function onHostSaved(): Promise<void> {
  await refreshChromeAndProps();
}

async function testHost(host: SshHost, ignorePin: boolean): Promise<void> {
  const key = `${host.id}:${ignorePin ? "prepare" : "test"}`;
  if (busyKey.value !== null) {
    return;
  }
  busyKey.value = key;
  try {
    const response = await apiMutation<{
      result: Omit<SshTestResult, "hostId" | "hostName" | "prepareRePin">;
    }>(host.actions.api.test, { json: { ignorePin } });
    const result: SshTestResult = {
      ...response.result,
      hostId: host.id,
      hostName: host.name,
      prepareRePin: ignorePin,
    };
    testResults.value = { ...testResults.value, [host.id]: result };
    if (result.fingerprint !== undefined && ignorePin) {
      setRepinValue(host, result.fingerprint);
    }
    if (result.ok) {
      toasts.push(
        ignorePin ? "Re-pin observation recorded." : "Connection authenticated.",
        "success",
      );
    } else {
      toasts.push(result.message ?? "The host could not be reached.", "error");
    }
    await refreshChromeAndProps();
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not test the host.";
    toasts.push(message, "error");
  } finally {
    busyKey.value = null;
  }
}

async function rePin(host: SshHost): Promise<void> {
  const fingerprint = repinValue(host).trim();
  if (fingerprint.length === 0 || busyKey.value !== null) {
    if (fingerprint.length === 0) {
      toasts.push("Prepare a re-pin and enter the observed fingerprint.", "error");
    }
    return;
  }
  busyKey.value = `${host.id}:repin`;
  try {
    await apiMutation<{ host: SshHost }>(host.actions.api.rePin, { json: { fingerprint } });
    toasts.push("Host key re-pinned.", "success");
    setRepinValue(host, "");
    const next = { ...testResults.value };
    delete next[host.id];
    testResults.value = next;
    await refreshChromeAndProps();
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not re-pin the host key.";
    toasts.push(message, "error");
  } finally {
    busyKey.value = null;
  }
}

function toggleAllowed(host: SshHost, event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const next = new Set(allowedHostIds.value);
  if (input.checked) {
    next.add(host.id);
  } else {
    next.delete(host.id);
  }
  allowedHostIds.value = next;
}

async function saveAllowlist(): Promise<void> {
  const action = view.value?.actions.saveGrants;
  if (action === null || action === undefined || busyKey.value !== null) {
    return;
  }
  busyKey.value = "allowlist";
  try {
    await apiMutation(action, { json: { hostIds: [...allowedHostIds.value] } });
    toasts.push("Allowlist saved.", "success");
    await refreshChromeAndProps();
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not save the allowlist.";
    toasts.push(message, "error");
  } finally {
    busyKey.value = null;
  }
}

async function revokeGrant(grant: SshGrant): Promise<void> {
  const key = `grant:${grant.id}`;
  if (busyKey.value !== null) {
    return;
  }
  busyKey.value = key;
  try {
    await apiMutation(grant.actions.api.revoke, { json: {} });
    toasts.push("Grant revoked.", "success");
    await refreshChromeAndProps();
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not revoke the grant.";
    toasts.push(message, "error");
  } finally {
    busyKey.value = null;
  }
}

async function decideApproval(
  approval: SshApproval,
  decision: "approve" | "reject",
): Promise<void> {
  const key = `approval:${approval.id}:${decision}`;
  if (busyKey.value !== null) {
    return;
  }
  busyKey.value = key;
  try {
    const action =
      decision === "approve" ? approval.actions.api.approve : approval.actions.api.reject;
    await apiMutation(action, { json: { decision } });
    toasts.push("Approval recorded.", "success");
    await refreshChromeAndProps();
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not record the approval.";
    toasts.push(message, "error");
  } finally {
    busyKey.value = null;
  }
}

function applyScope(): void {
  const value = scopeTarget.value.trim();
  void router.push(value.length === 0 ? "/ssh" : `/ssh?target=${encodeURIComponent(value)}`);
}

async function refreshPage(): Promise<void> {
  await refreshChromeAndProps();
}
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Access</p>
      <h1 class="page-title">{{ view?.labels.title ?? "SSH hosts" }}</h1>
      <p class="page-description">
        {{
          view?.labels.description ??
          "Coordinator-held keys, host-key pinning, per-application grants, approvals, and audit."
        }}
      </p>
    </div>
    <div class="page-header__actions">
      <button class="btn btn-secondary" type="button" @click="refreshPage">
        <AppIcon name="refresh" />{{ view?.labels.actions.refresh ?? "Refresh" }}
      </button>
      <button class="btn btn-primary" type="button" @click="openAdd">
        <AppIcon name="plus" />{{ view?.labels.actions.addHost ?? "Add host" }}
      </button>
    </div>
  </header>

  <div class="page__body">
    <p v-if="loading && view !== undefined" class="hint" role="status" aria-live="polite">
      Updating SSH console…
    </p>

    <section v-if="failed" class="card" aria-labelledby="ssh-error-title">
      <div class="card__head">
        <h2 class="card__title" id="ssh-error-title">SSH console could not be loaded</h2>
      </div>
      <div class="card__body stack--tight">
        <p class="form-error" role="alert">{{ failure }}</p>
        <div class="cluster">
          <button class="btn btn-secondary btn-sm" type="button" @click="sshQuery.refetch()">
            <AppIcon name="refresh" />Retry
          </button>
          <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
        </div>
      </div>
    </section>

    <p v-else-if="view === undefined" class="hint" role="status" aria-live="polite">
      Loading SSH console…
    </p>

    <template v-else>
      <p v-if="view.error !== null" class="form-error" role="alert">
        <AppIcon name="alert-triangle" />{{ view.error.message }}
      </p>

      <nav class="settings-nav ssh-nav" :aria-label="view.labels.nav.ariaLabel" data-section-nav>
        <div class="settings-nav__sections" :aria-label="view.labels.nav.sectionsLabel">
          <a
            class="settings-nav__link"
            :href="view.scope.hostsHref"
            :aria-current="activeSection === 'ssh-hosts' ? 'page' : undefined"
            @click.prevent="activateSection('ssh-hosts')"
          >
            {{ view.labels.nav.hosts }}
          </a>
          <a
            class="settings-nav__link"
            :href="view.scope.accessHref"
            :aria-current="activeSection === 'ssh-access' ? 'page' : undefined"
            @click.prevent="activateSection('ssh-access')"
          >
            {{ view.labels.nav.access }}
          </a>
          <a
            class="settings-nav__link"
            :href="view.scope.approvalsHref"
            :aria-current="activeSection === 'ssh-approvals' ? 'page' : undefined"
            @click.prevent="activateSection('ssh-approvals')"
          >
            {{ view.labels.nav.approvals }}
            ({{ counts.pendingApprovals }})
          </a>
          <a
            class="settings-nav__link"
            :href="view.scope.auditHref"
            :aria-current="activeSection === 'ssh-audit' ? 'page' : undefined"
            @click.prevent="activateSection('ssh-audit')"
          >
            {{ view.labels.nav.audit }}
          </a>
        </div>
        <form class="ssh-nav__scope" method="get" action="/ssh" @submit.prevent="applyScope">
          <label class="label ssh-nav__scope-label" for="ssh-scope">
            {{ view.labels.nav.scope }}
          </label>
          <div class="ssh-nav__scope-controls">
            <select
              id="ssh-scope"
              v-model="scopeTarget"
              class="select ssh-nav__select"
              name="target"
            >
              <option value="">{{ view.labels.nav.allApplications }}</option>
              <optgroup v-for="group in view.scope.options" :key="group.label" :label="group.label">
                <option v-for="option in group.options" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </optgroup>
            </select>
            <button class="btn btn-secondary btn-sm" type="submit">
              {{ view.labels.nav.apply }}
            </button>
          </div>
        </form>
      </nav>

      <div class="watch-strip watch-strip--4 ssh-watch">
        <div class="watch">
          <p class="watch__value">{{ counts.hosts }}</p>
          <p class="watch__label">Hosts</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ counts.pinned }} / {{ counts.hosts }}</p>
          <p class="watch__label">Host keys pinned</p>
          <span v-if="counts.mismatch > 0" class="badge badge-warning">
            {{ counts.mismatch }}
            mismatch
          </span>
          <span v-else-if="counts.unpinned > 0" class="badge">
            {{ counts.unpinned }}
            unpinned
          </span>
        </div>
        <div class="watch">
          <p class="watch__value">{{ counts.pendingApprovals }}</p>
          <p class="watch__label">Pending approvals</p>
        </div>
        <div class="watch">
          <p class="watch__value">{{ view.scope.scoped ? counts.activeGrants : "—" }}</p>
          <p class="watch__label">
            Active grants{{ view.scope.scoped ? "" : " (choose a scope)" }}
          </p>
        </div>
      </div>

      <section class="section ssh-section" id="ssh-hosts" aria-labelledby="ssh-hosts-title">
        <div class="section__head">
          <h2 class="section__title" id="ssh-hosts-title">Hosts</h2>
          <p class="section__note">
            One coordinator-held key per host. Host keys are pinned on first use (TOFU) and fail
            closed on a mismatch.
          </p>
        </div>

        <div v-if="counts.hosts === 0" class="empty-state">
          <span class="empty-state__mark">
            <AppIcon :name="view.labels.empty.hosts.iconName" class-name="icon--lg" />
          </span>
          <h3 class="empty-state__title">{{ view.labels.empty.hosts.title }}</h3>
          <p class="empty-state__body">{{ view.labels.empty.hosts.body }}</p>
          <button class="btn btn-primary btn-sm" type="button" @click="openAdd">
            <AppIcon name="plus" />{{ view.labels.empty.hosts.actionLabel ?? "Add host" }}
          </button>
        </div>

        <div v-else class="ssh-grid">
          <article
            v-for="host in view.hosts"
            :id="host.anchor"
            :key="host.id"
            class="card ssh-host"
            :data-pin="host.pinState"
            :aria-labelledby="`${host.anchor}-title`"
          >
            <div class="ssh-host__body">
              <div class="ssh-host__head">
                <div class="ssh-host__ident">
                  <h3 :id="`${host.anchor}-title`" class="ssh-host__name">{{ host.name }}</h3>
                  <p class="ssh-host__addr mono">
                    {{ host.username }}@{{ host.address }}:{{ host.port }}
                  </p>
                </div>
                <div class="cluster">
                  <span class="status" :data-state="pinPill(host).state">
                    <AppIcon :name="pinPill(host).icon" />{{ pinPill(host).label }}
                  </span>
                  <span v-if="host.requireApproval" class="badge">
                    <AppIcon name="stamp" class-name="icon--sm" />Approval
                  </span>
                  <span v-else class="badge badge-ghost">
                    <AppIcon name="check" class-name="icon--sm" />Direct
                  </span>
                </div>
              </div>
              <dl class="ssh-host__facts">
                <div class="ssh-host__fact">
                  <dt>Remote root</dt>
                  <dd class="mono">{{ host.remoteRoot ?? "Unrestricted" }}</dd>
                </div>
                <div class="ssh-host__fact">
                  <dt>Host key</dt>
                  <dd>
                    <span class="mono ssh-host__fingerprint" :title="host.hostKeyFingerprint ?? ''">
                      {{ shortFingerprint(host.hostKeyFingerprint) }}
                    </span>
                  </dd>
                </div>
                <div class="ssh-host__fact">
                  <dt>Client key</dt>
                  <dd>
                    <span
                      class="mono ssh-host__fingerprint"
                      :title="host.credential?.fingerprint ?? ''"
                    >
                      {{ shortFingerprint(host.credential?.fingerprint) }}
                    </span>
                  </dd>
                </div>
                <div class="ssh-host__fact">
                  <dt>Approval idle</dt>
                  <dd>
                    {{
                      host.requireApproval
                        ? `${Math.round(host.approvalIdleSec / 60)} min`
                        : "Not required"
                    }}
                  </dd>
                </div>
              </dl>
              <div v-if="view.scope.scoped" class="ssh-host__access">
                <span class="badge" :class="host.allowed ? 'badge-success' : 'badge-ghost'">
                  {{ host.allowed ? "Allowed" : "Not allowed" }}
                </span>
                <span v-if="host.pendingApprovals > 0" class="badge badge-warning">
                  {{ host.pendingApprovals }}
                  pending
                </span>
                <span v-if="host.grant !== null" class="ssh-host__grant">
                  Grant active · idle expires
                  <time
                    :datetime="host.grant.idleExpiresAt"
                    :title="absoluteTime(host.grant.idleExpiresAt)"
                  >
                    {{ timeUntil(host.grant.idleExpiresAt) }}
                  </time>
                </span>
              </div>
              <p v-if="pageErrorFor(`host:${host.id}`) !== null" class="field-error" role="alert">
                <AppIcon name="alert-triangle" />{{ pageErrorFor(`host:${host.id}`) }}
              </p>

              <div
                v-if="testFor(host) !== undefined"
                class="ssh-test"
                :data-tone="testFor(host)?.ok ? 'success' : 'failed'"
                :role="testFor(host)?.ok ? 'status' : 'alert'"
              >
                <p class="ssh-test__head">
                  <AppIcon :name="testFor(host)?.ok ? 'check' : 'alert-triangle'" />
                  {{ testFor(host)?.ok ? "Authenticated" : "Test failed" }}
                </p>
                <p v-if="testFor(host)?.ok !== true" class="ssh-test__note">
                  {{ testFor(host)?.message ?? "The host could not be reached." }}
                </p>
                <dl
                  v-if="
                    testFor(host)?.fingerprint !== undefined || testFor(host)?.previousFingerprint
                  "
                  class="ssh-test__facts"
                >
                  <div v-if="testFor(host)?.fingerprint !== undefined">
                    <dt>Presented</dt>
                    <dd class="ssh-fingerprint">{{ testFor(host)?.fingerprint }}</dd>
                  </div>
                  <div v-if="testFor(host)?.previousFingerprint">
                    <dt>Previously pinned</dt>
                    <dd class="ssh-fingerprint">{{ testFor(host)?.previousFingerprint }}</dd>
                  </div>
                </dl>
                <p v-if="testFor(host)?.mismatch === true" class="ssh-test__note">
                  <AppIcon name="alert-triangle" class-name="icon--sm" />
                  The presented host key does not match the pin. The connection failed closed.
                  Verify the change out-of-band before preparing a re-pin.
                </p>
                <p v-if="testFor(host)?.serverBanner !== undefined" class="ssh-test__note mono">
                  {{ testFor(host)?.serverBanner }}
                </p>
                <div
                  v-if="testFor(host)?.ok === true && testFor(host)?.prepareRePin === true"
                  class="ssh-warning"
                >
                  <AppIcon name="alert-triangle" />
                  <div class="stack--tight">
                    <p class="hint">
                      A 10-minute re-pin observation was recorded. Verify this fingerprint
                      out-of-band (provider console or a trusted network path), then submit the
                      re-pin form below with the exact value.
                    </p>
                    <p class="ssh-fingerprint">{{ testFor(host)?.fingerprint }}</p>
                  </div>
                </div>
              </div>

              <details class="disclosure ssh-host__key" :open="testKeyOpen(host)">
                <summary>
                  <span class="cluster">
                    Host key
                    <span class="mono">{{ shortFingerprint(host.hostKeyFingerprint) }}</span>
                  </span>
                  <AppIcon name="chevron-down" class-name="disclosure__chevron" />
                </summary>
                <div class="stack--tight">
                  <div>
                    <p class="label">Pinned fingerprint</p>
                    <p class="ssh-fingerprint">
                      {{ host.hostKeyFingerprint ?? "Not pinned" }}
                    </p>
                  </div>
                  <p class="hint">
                    {{
                      host.hostKeyPinnedAt === null
                        ? "This host is not pinned yet; the first successful test pins it (TOFU)."
                        : `Pinned ${absoluteTime(host.hostKeyPinnedAt)}`
                    }}
                  </p>
                  <p v-if="host.hostKeyMismatchAt !== null" class="field-error" role="alert">
                    <AppIcon name="alert-triangle" />
                    A presented key did not match at
                    {{ absoluteTime(host.hostKeyMismatchAt) }}. Connections fail closed until you
                    re-pin.
                  </p>
                  <div>
                    <button
                      class="btn btn-secondary btn-sm"
                      type="button"
                      :disabled="busyKey !== null"
                      @click="testHost(host, true)"
                    >
                      <AppIcon name="refresh" />{{ view.labels.actions.prepareRePin }}
                    </button>
                  </div>
                  <form class="stack--tight" @submit.prevent="rePin(host)">
                    <div class="field">
                      <label class="label" :for="`ssh-repin-${host.id}`">
                        Observed fingerprint
                      </label>
                      <input
                        :id="`ssh-repin-${host.id}`"
                        class="input mono"
                        name="fingerprint"
                        :value="repinValue(host)"
                        placeholder="SHA256:..."
                        required
                        :aria-describedby="`ssh-repin-${host.id}-hint`"
                        @input="onRepinInput(host, $event)"
                      >
                      <p :id="`ssh-repin-${host.id}-hint`" class="hint">
                        Run Prepare re-pin first, verify the fingerprint independently, then submit
                        the exact observed value.
                      </p>
                    </div>
                    <button
                      class="btn btn-secondary btn-sm"
                      type="submit"
                      :disabled="busyKey !== null"
                    >
                      {{ view.labels.actions.rePin }}
                    </button>
                  </form>
                </div>
              </details>

              <div class="ssh-host__actions">
                <button
                  class="btn btn-secondary btn-sm"
                  type="button"
                  :disabled="busyKey !== null"
                  @click="testHost(host, false)"
                >
                  <AppIcon name="activity" />{{ view.labels.actions.test }}
                </button>
                <button class="btn btn-secondary btn-sm" type="button" @click="openEdit(host)">
                  <AppIcon name="settings" />{{ view.labels.actions.editHost }}
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section class="section ssh-section" id="ssh-access" aria-labelledby="ssh-access-title">
        <div class="section__head">
          <h2 class="section__title" id="ssh-access-title">
            {{
              view.scope.scoped
                ? `Access for ${view.scope.projectName ?? ""} / ${view.scope.appKey}`
                : "Application access"
            }}
          </h2>
          <p class="section__note">
            {{
              view.scope.scoped
                ? `${counts.allowedHosts} of ${counts.hosts} hosts allowed`
                : "Per-application allowlists and grants."
            }}
          </p>
        </div>

        <div v-if="view.scope.scoped" class="ssh-panel stack">
          <p v-if="pageErrorFor('access') !== null" class="field-error" role="alert">
            <AppIcon name="alert-triangle" />{{ pageErrorFor("access") }}
          </p>
          <form class="stack" @submit.prevent="saveAllowlist">
            <div v-if="counts.hosts === 0" class="hint">
              No hosts are configured. Add a host before granting access.
            </div>
            <div v-else class="ssh-allowlist">
              <label v-for="host in view.hosts" :key="host.id" class="check">
                <input
                  class="checkbox"
                  type="checkbox"
                  name="hostIds"
                  :value="host.id"
                  :checked="allowedHostIds.has(host.id)"
                  @change="toggleAllowed(host, $event)"
                >
                <span>
                  <strong>{{ host.name }}</strong>
                  <span class="mono">{{ host.address }}</span>
                  <span class="status" :data-state="pinPill(host).state">
                    <AppIcon :name="pinPill(host).icon" />{{ pinPill(host).label }}
                  </span>
                </span>
              </label>
            </div>
            <p class="hint">
              Unchecking a host removes the application's access and revokes any active grant for
              that host.
            </p>
            <div>
              <button
                class="btn btn-primary btn-sm"
                type="submit"
                :disabled="busyKey !== null || view.actions.saveGrants === null"
              >
                {{ view.labels.actions.saveAllowlist }}
              </button>
            </div>
          </form>

          <h3 class="ssh-subtitle">Grants</h3>
          <p class="hint">Active, expired, and revoked approvals for this application.</p>
          <p v-if="view.grants.length === 0" class="hint">{{ view.labels.empty.grants }}</p>
          <div v-else class="table-wrap">
            <table class="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Host</th>
                  <th scope="col">Granted by</th>
                  <th scope="col">Idle expires</th>
                  <th scope="col">State</th>
                  <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="grant in view.grants" :key="grant.id">
                  <td data-label="Host"><span class="mono">{{ grant.hostName }}</span></td>
                  <td data-label="Granted by">{{ grant.grantedBy }}</td>
                  <td data-label="Idle expires">
                    <time
                      :datetime="grant.idleExpiresAt"
                      :title="absoluteTime(grant.idleExpiresAt)"
                    >
                      {{ timeUntil(grant.idleExpiresAt) }}
                    </time>
                  </td>
                  <td data-label="State">
                    <span class="status" :data-state="grantPill(grant).state">
                      <AppIcon :name="grantPill(grant).icon" />{{ grantPill(grant).label }}
                    </span>
                  </td>
                  <td class="table__actions">
                    <button
                      v-if="grant.canRevoke"
                      class="btn btn-danger btn-sm"
                      type="button"
                      :disabled="busyKey !== null"
                      @click="revokeGrant(grant)"
                    >
                      {{ view.labels.actions.revoke }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-else class="empty-state">
          <span class="empty-state__mark">
            <AppIcon :name="view.labels.empty.chooseApplication.iconName" class-name="icon--lg" />
          </span>
          <h3 class="empty-state__title">{{ view.labels.empty.chooseApplication.title }}</h3>
          <p class="empty-state__body">{{ view.labels.empty.chooseApplication.body }}</p>
        </div>
      </section>

      <section class="section ssh-section" id="ssh-approvals" aria-labelledby="ssh-approvals-title">
        <div class="section__head">
          <h2 class="section__title" id="ssh-approvals-title">Pending approvals</h2>
          <p class="section__note">
            {{
              view.scope.scoped
                ? `Scoped to ${view.scope.projectName ?? ""} / ${view.scope.appKey}`
                : "All applications"
            }}
          </p>
        </div>
        <p v-if="pageErrorFor('approvals') !== null" class="field-error" role="alert">
          <AppIcon name="alert-triangle" />{{ pageErrorFor("approvals") }}
        </p>

        <div v-if="counts.pendingApprovals === 0" class="empty-state">
          <span class="empty-state__mark">
            <AppIcon :name="view.labels.empty.approvals.iconName" class-name="icon--lg" />
          </span>
          <h3 class="empty-state__title">{{ view.labels.empty.approvals.title }}</h3>
          <p class="empty-state__body">{{ view.labels.empty.approvals.body }}</p>
        </div>
        <div v-else class="ssh-approvals">
          <article v-for="approval in view.approvals" :key="approval.id" class="ssh-approval">
            <div class="ssh-approval__head">
              <div class="ssh-approval__ident">
                <h3 class="ssh-approval__title">{{ approval.hostName }}</h3>
                <p class="ssh-approval__meta">
                  <span class="badge badge--mono">{{ approval.action }}</span>
                  {{ approval.appKey }}
                </p>
              </div>
              <p class="ssh-approval__meta">
                requested
                <time :datetime="approval.requestedAt" :title="absoluteTime(approval.requestedAt)">
                  {{ timeAgo(approval.requestedAt) }}
                </time>
                · expires
                <time :datetime="approval.expiresAt" :title="absoluteTime(approval.expiresAt)">
                  {{ timeUntil(approval.expiresAt) }}
                </time>
              </p>
            </div>
            <pre class="ssh-command">{{ approval.commandPreview }}</pre>
            <div class="ssh-approval__foot">
              <p class="hint">Approving creates an idle grant for this host.</p>
              <div class="cluster">
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  :disabled="busyKey !== null"
                  @click="decideApproval(approval, 'approve')"
                >
                  {{ view.labels.actions.approve }}
                </button>
                <button
                  class="btn btn-danger btn-sm"
                  type="button"
                  :disabled="busyKey !== null"
                  @click="decideApproval(approval, 'reject')"
                >
                  {{ view.labels.actions.reject }}
                </button>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section class="section ssh-section" id="ssh-audit" aria-labelledby="ssh-audit-title">
        <div class="section__head">
          <h2 class="section__title" id="ssh-audit-title">Audit</h2>
          <p class="section__note">
            {{
              view.scope.scoped
                ? `Scoped to ${view.scope.projectName ?? ""} / ${view.scope.appKey}`
                : "All applications"
            }}
          </p>
        </div>

        <div v-if="view.audit.length === 0" class="empty-state">
          <span class="empty-state__mark">
            <AppIcon :name="view.labels.empty.audit.iconName" class-name="icon--lg" />
          </span>
          <h3 class="empty-state__title">{{ view.labels.empty.audit.title }}</h3>
          <p class="empty-state__body">{{ view.labels.empty.audit.body }}</p>
        </div>
        <template v-else>
          <div class="ssh-panel ssh-panel--flush">
            <div class="table-wrap">
              <table class="table table--stack">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Action</th>
                    <th scope="col">Host</th>
                    <th v-if="!view.scope.scoped" scope="col">Application</th>
                    <th scope="col">Command</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="entry in view.audit" :key="entry.id">
                    <td data-label="Time">
                      <time :datetime="entry.startedAt" :title="absoluteTime(entry.startedAt)">
                        {{ timeAgo(entry.startedAt) }}
                      </time>
                    </td>
                    <td data-label="Action">
                      <span class="badge badge--mono">{{ entry.action }}</span>
                    </td>
                    <td data-label="Host"><span class="mono">{{ entry.hostName }}</span></td>
                    <td v-if="!view.scope.scoped" data-label="Application">
                      <span class="mono">{{ entry.appKey }}</span>
                    </td>
                    <td data-label="Command">
                      <span class="mono ssh-audit__command">
                        {{ entry.commandPreview ?? "—" }}
                      </span>
                    </td>
                    <td data-label="Result">
                      <span class="badge" :class="auditPill(entry).className">
                        <AppIcon :name="auditPill(entry).icon" class-name="icon--sm" />
                        {{ auditPill(entry).label }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <p class="hint ssh-note">Showing the {{ view.policy.auditLimit }} most recent events.</p>
        </template>
      </section>

      <SshHostDialog
        ref="addDialog"
        mode="add"
        :host="null"
        :action="view.actions.createHost"
        :idle-options="view.policy.idleOptions"
        :labels="view.labels.actions"
        :initial-values="view.dialogs.add.values"
        @saved="onHostSaved"
      />
      <SshHostDialog
        v-if="editingHost !== null"
        ref="editDialog"
        mode="edit"
        :host="editingHost"
        :action="editingHost.actions.api.update"
        :idle-options="view.policy.idleOptions"
        :labels="view.labels.actions"
        :initial-values="
          view.dialogs.edits.find((entry) => entry.hostId === editingHost?.id)?.values
        "
        @saved="onHostSaved"
        @deleted="onHostSaved"
      />
    </template>
  </div>
</template>
