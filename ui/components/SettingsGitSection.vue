<script setup lang="ts">
import { ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type {
  GitAuthKind,
  GitTestResult,
  SettingsGitCredentialProps,
  SettingsProps,
} from "../settings-types.js";
import type { PillSpec } from "../status.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";
import SettingsConfirmDialog from "./SettingsConfirmDialog.vue";
import SmartLink from "./SmartLink.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{ settings: SettingsProps }>();
const emit = defineEmits<{ changed: [message: string] }>();
const toasts = useToastStore();

const busy = ref<string | null>(null);
const pendingClear = ref<SettingsGitCredentialProps | null>(null);
const testResults = ref<Partial<Record<GitAuthKind, GitTestResult>>>({});
const testErrors = ref<Partial<Record<GitAuthKind, string>>>({});

const credentials = (): readonly SettingsGitCredentialProps[] => [
  props.settings.git.ssh,
  props.settings.git.https,
];

function credentialPill(credential: SettingsGitCredentialProps): PillSpec {
  switch (credential.status.state) {
    case "set":
      return { variant: "status", dataState: "delivered", icon: "check", label: "Set" };
    case "cleared":
      return { variant: "status", dataState: "cancelled", icon: "slash", label: "Cleared" };
    case "error":
      return { variant: "status", dataState: "failed", icon: "alert-triangle", label: "Error" };
    default:
      return { variant: "status", dataState: "cancelled", icon: "slash", label: "Missing" };
  }
}

function failure(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

function formOf(event: Event): HTMLFormElement | null {
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }
  const form = target.closest("form");
  return form instanceof HTMLFormElement ? form : null;
}

function field(form: HTMLFormElement, name: string): string {
  return (
    form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? ""
  );
}

function clearSecretFields(form: HTMLFormElement): void {
  for (const name of ["privateKey", "knownHosts", "hosts", "username", "token", "testRemote"]) {
    const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    if (input !== null) {
      input.value = "";
    }
  }
}

function draft(form: HTMLFormElement, kind: GitAuthKind): Record<string, unknown> {
  if (kind === "ssh") {
    const knownHosts = field(form, "knownHosts");
    return {
      privateKey: field(form, "privateKey"),
      ...(knownHosts.trim().length === 0 ? {} : { knownHosts }),
    };
  }
  return {
    hosts: field(form, "hosts")
      .split(/[\n,]+/)
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
    username: field(form, "username"),
    token: field(form, "token"),
  };
}

function targetBody(): Record<string, unknown> {
  const scope = props.settings.scope;
  return {
    scope: scope.scope,
    ...(scope.scope === "global" ? {} : { projectId: scope.projectId ?? "" }),
    ...(scope.scope === "app" ? { appKey: scope.appKey ?? "" } : {}),
  };
}

async function save(event: Event, kind: GitAuthKind, action: "set" | "inherit"): Promise<void> {
  const form = formOf(event);
  if (form === null || busy.value !== null) {
    return;
  }
  const value = draft(form, kind);
  if (action === "set" && kind === "ssh" && String(value.privateKey).trim().length === 0) {
    toasts.push("SSH private key is required.", "error");
    return;
  }
  if (action === "set" && kind === "https" && String(value.token).trim().length === 0) {
    toasts.push("Token is required.", "error");
    return;
  }
  busy.value = `${kind}:${action}`;
  try {
    await apiMutation("/api/settings/git", {
      json: {
        ...targetBody(),
        kind,
        action,
        ...(action === "set" ? { value } : {}),
      },
    });
    clearSecretFields(form);
    emit("changed", "Git credential saved.");
  } catch (error) {
    toasts.push(failure(error, "Could not save the git credential."), "error");
  } finally {
    busy.value = null;
  }
}

async function confirmClear(): Promise<void> {
  const credential = pendingClear.value;
  if (credential === null || busy.value !== null) {
    return;
  }
  busy.value = `${credential.kind}:clear`;
  try {
    await apiMutation("/api/settings/git", {
      json: { ...targetBody(), kind: credential.kind, action: "clear" },
    });
    pendingClear.value = null;
    emit("changed", "Git credential cleared.");
  } catch (error) {
    toasts.push(failure(error, "Could not clear the git credential."), "error");
  } finally {
    busy.value = null;
  }
}

async function test(event: Event, credential: SettingsGitCredentialProps): Promise<void> {
  const form = formOf(event);
  const scope = props.settings.scope;
  if (form === null || busy.value !== null) {
    return;
  }
  if (scope.scope !== "app" || scope.projectId === null || scope.appKey === null) {
    toasts.push("An application scope is required to test the remote.", "error");
    return;
  }
  const remote = field(form, "testRemote").trim();
  const url = `/api/projects/${encodeURIComponent(scope.projectId)}/apps/${encodeURIComponent(
    scope.appKey,
  )}/git/test`;
  busy.value = `${credential.kind}:test`;
  const nextErrors = { ...testErrors.value };
  delete nextErrors[credential.kind];
  testErrors.value = nextErrors;
  try {
    const result = await apiMutation<GitTestResult>(url, {
      json: {
        kind: credential.kind,
        ...(remote.length === 0 ? {} : { remote }),
        [credential.kind]: draft(form, credential.kind),
      },
    });
    testResults.value = { ...testResults.value, [credential.kind]: result };
    toasts.push("Connection authenticated.", "success");
  } catch (error) {
    testErrors.value = {
      ...testErrors.value,
      [credential.kind]: failure(error, "The remote could not be reached."),
    };
    toasts.push(failure(error, "The remote could not be reached."), "error");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="stack--tight" id="settings-git-credentials">
    <div
      v-for="credential in credentials()"
      :key="credential.kind"
      class="stack--tight"
      :id="`git-${credential.kind}`"
    >
      <details class="setting-row" :id="`setting-git-${credential.kind}`">
        <summary class="setting-row__summary">
          <span class="setting-row__title">{{ credential.title }}</span>
          <span class="setting-row__effective">
            <span class="mono">{{ credential.effectiveText }}</span>
            <span class="setting-row__source">{{ credential.sourceLine }}</span>
          </span>
          <span class="setting-row__state">
            <StatusPill :pill="credentialPill(credential)" />
          </span>
          <span class="setting-row__chevron"><AppIcon name="chevron-down" /></span>
        </summary>
        <div class="setting-row__body">
          <div v-if="credential.status.state === 'set' && credential.status.kind === 'ssh'">
            <span class="overline">{{ settings.labels.git.key.overline }}</span>
            <span class="mono small" id="git-ssh-public-key">
              {{ credential.details.publicKey ?? "" }}
            </span>
            <span class="overline">{{ settings.labels.git.key.fingerprint }}</span>
            <span class="mono small" id="git-ssh-fingerprint">
              {{ credential.details.fingerprint ?? "" }}
            </span>
            <span class="overline">{{ settings.labels.git.key.knownHosts }}</span>
            <span class="small">
              {{
                credential.details.hasKnownHosts === true
                  ? settings.labels.git.key.knownHostsSet
                  : settings.labels.git.key.knownHostsUnset
              }}
            </span>
          </div>
          <div v-else-if="credential.status.state === 'set' && credential.status.kind === 'https'">
            <span class="overline">{{ settings.labels.git.key.allowedHosts }}</span>
            <span class="mono small" id="git-https-allowed-hosts">
              {{ (credential.details.hosts ?? []).join(", ") }}
            </span>
            <span class="overline">{{ settings.labels.git.key.username }}</span>
            <span class="mono small" id="git-https-username-value">
              {{ credential.details.username ?? "" }}
            </span>
          </div>
          <p v-else-if="credential.status.state === 'error'" class="field-error" role="alert">
            <AppIcon name="alert-triangle" />{{ credential.details.error ?? "" }}
          </p>
          <p v-else-if="credential.status.state === 'cleared'" class="hint">
            {{ settings.labels.git.key.cleared }}
          </p>
          <p v-else class="hint">{{ settings.labels.git.key.missing }}</p>
          <p class="hint">Secret: <span class="mono">{{ credential.masked }}</span></p>

          <form class="stack--tight" @submit.prevent="save($event, credential.kind, 'set')">
            <template v-if="credential.kind === 'ssh'">
              <div class="field">
                <label class="label" :for="`git-ssh-private-key`">SSH private key</label>
                <textarea
                  id="git-ssh-private-key"
                  class="textarea"
                  name="privateKey"
                  rows="6"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                ></textarea>
              </div>
              <div class="field">
                <label class="label" for="git-ssh-known-hosts">known_hosts (optional)</label>
                <textarea
                  id="git-ssh-known-hosts"
                  class="textarea"
                  name="knownHosts"
                  rows="4"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="github.com ssh-ed25519 AAAA..."
                ></textarea>
              </div>
            </template>
            <template v-else>
              <div class="field">
                <label class="label" for="git-https-hosts">Allowed hosts</label>
                <textarea
                  id="git-https-hosts"
                  class="textarea"
                  name="hosts"
                  rows="3"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="github.com&#10;gitlab.com"
                ></textarea>
              </div>
              <div class="field">
                <label class="label" for="git-https-username">Username</label>
                <input
                  id="git-https-username"
                  class="input"
                  name="username"
                  type="text"
                  autocomplete="off"
                  placeholder="x-access-token"
                >
              </div>
              <div class="field">
                <label class="label" for="git-https-token">Token</label>
                <input
                  id="git-https-token"
                  class="input"
                  name="token"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="credential.masked"
                >
              </div>
            </template>
            <div v-if="credential.allowTest" class="field">
              <label class="label" :for="`git-${credential.kind}-test-remote`">
                Remote (optional)
              </label>
              <input
                :id="`git-${credential.kind}-test-remote`"
                class="input"
                name="testRemote"
                type="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="Defaults to origin"
              >
            </div>

            <div class="setting-row__actions">
              <button class="btn btn-primary btn-sm" type="submit" :disabled="busy !== null">
                {{ settings.labels.actions.save }}
              </button>
              <button
                v-if="credential.form.hidden.scope !== 'global'"
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="busy !== null || credential.inheritReason !== null"
                @click="save($event, credential.kind, 'inherit')"
              >
                {{ settings.labels.actions.inherit }}
              </button>
              <button
                class="btn btn-danger btn-sm"
                type="button"
                :disabled="busy !== null || credential.clearReason !== null"
                @click="pendingClear = credential"
              >
                {{ settings.labels.actions.clear }}
              </button>
              <button
                v-if="credential.allowTest"
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="busy !== null"
                @click="test($event, credential)"
              >
                {{ settings.labels.actions.testConnection }}
              </button>
            </div>
            <p v-if="credential.inheritReason !== null" class="hint setting-row__reason">
              {{ credential.inheritReason }}
            </p>
            <p v-if="credential.clearReason !== null" class="hint setting-row__reason">
              {{ credential.clearReason }}
            </p>
          </form>

          <div
            v-if="testResults[credential.kind] !== undefined"
            class="stack--tight"
            role="status"
            aria-live="polite"
          >
            <p class="small">
              Connected:
              {{ testResults[credential.kind]?.refs ?? 0 }} refs
              <span v-if="testResults[credential.kind]?.remote">
                from {{ testResults[credential.kind]?.remote }}
              </span>
              <span v-if="testResults[credential.kind]?.head">
                HEAD {{ testResults[credential.kind]?.head }}
              </span>
            </p>
            <ul v-if="(testResults[credential.kind]?.warnings ?? []).length > 0" class="small">
              <li v-for="warning in testResults[credential.kind]?.warnings ?? []" :key="warning">
                {{ warning }}
              </li>
            </ul>
          </div>
          <p v-if="testErrors[credential.kind] !== undefined" class="field-error" role="alert">
            {{ testErrors[credential.kind] }}
          </p>
        </div>
      </details>
    </div>

    <div class="stack--tight git-notes">
      <p class="hint">{{ settings.git.testCheck.hint }}</p>
      <SmartLink
        v-if="settings.git.testCheck.href !== null"
        class="btn btn-ghost btn-sm"
        :to="settings.git.testCheck.href"
      >
        {{ settings.labels.git.appSettings }}
      </SmartLink>
      <span class="overline">{{ settings.labels.git.securityNotes }}</span>
      <p class="hint">{{ settings.git.securityNotes }}</p>
    </div>
  </div>

  <SettingsConfirmDialog
    :open="pendingClear !== null"
    :title="settings.labels.actions.clearTitle"
    :body="settings.labels.actions.clearBody"
    :submit-label="settings.labels.actions.clearConfirm"
    :busy="busy !== null"
    @confirm="confirmClear"
    @cancel="pendingClear = null"
  />
</template>
