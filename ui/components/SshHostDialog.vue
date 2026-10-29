<script setup lang="ts">
import { computed, ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { SshHost, SshLabels } from "../ssh-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{
  mode: "add" | "edit";
  host: SshHost | null;
  action: string;
  idleOptions: readonly number[];
  labels: SshLabels["actions"];
  initialValues?: Readonly<Record<string, string>>;
}>();

const emit = defineEmits<{ saved: []; deleted: [] }>();

const toasts = useToastStore();
const dialogEl = ref<HTMLDialogElement | null>(null);
const keyInput = ref<HTMLTextAreaElement | null>(null);
const name = ref("");
const address = ref("");
const port = ref("22");
const username = ref("");
const remoteRoot = ref("");
const requireApproval = ref(true);
const idle = ref("1800");
const error = ref<string | null>(null);
const busy = ref(false);
const confirmingDelete = ref(false);

const editing = computed(() => props.mode === "edit" && props.host !== null);
const dialogId = computed(() =>
  props.host === null ? "ssh-add-dialog" : `ssh-edit-${props.host.id}`,
);
const title = computed(() => (props.host === null ? "Add SSH host" : `Edit ${props.host.name}`));

function chosenIdle(): number {
  const selected = Number(idle.value);
  return Number.isFinite(selected) ? selected : 1800;
}

function idleOptionsFor(selected: number): number[] {
  const options = [...props.idleOptions];
  if (Number.isFinite(selected) && !options.includes(selected)) {
    options.push(selected);
    options.sort((left, right) => left - right);
  }
  return options;
}

function idleLabel(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
}

function fieldValue(key: string, fallback: string): string {
  const value = props.initialValues?.[key];
  return value === undefined ? fallback : value;
}

function open(): void {
  const host = props.host;
  const values = props.initialValues ?? {};
  name.value = fieldValue("name", host?.name ?? "");
  address.value = fieldValue("address", host?.address ?? "");
  port.value = fieldValue("port", host === null ? "22" : String(host.port));
  username.value = fieldValue("username", host?.username ?? "");
  remoteRoot.value = fieldValue("remoteRoot", host?.remoteRoot ?? "");
  requireApproval.value =
    values.requireApproval === undefined
      ? (host?.requireApproval ?? true)
      : values.requireApproval !== "0";
  idle.value = fieldValue("approvalIdleSec", host === null ? "1800" : String(host.approvalIdleSec));
  error.value = null;
  confirmingDelete.value = false;
  if (keyInput.value !== null) {
    keyInput.value.value = "";
  }
  if (dialogEl.value !== null && !dialogEl.value.open) {
    dialogEl.value.showModal();
  }
}

function close(): void {
  if (busy.value) {
    return;
  }
  if (keyInput.value !== null) {
    keyInput.value.value = "";
  }
  dialogEl.value?.close();
}

function onClose(): void {
  if (keyInput.value !== null) {
    keyInput.value.value = "";
  }
  confirmingDelete.value = false;
  error.value = null;
}

async function loadKeyFile(event: Event): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const file = input.files?.[0];
  if (file === undefined || keyInput.value === null) {
    return;
  }
  keyInput.value.value = await file.text();
}

function failureMessage(fallback: string): string {
  return fallback;
}

async function submit(): Promise<void> {
  if (busy.value) {
    return;
  }
  const privateKey = keyInput.value?.value.trim() ?? "";
  if (name.value.trim().length === 0 || address.value.trim().length === 0) {
    error.value = "Name and address are required.";
    return;
  }
  if (username.value.trim().length === 0) {
    error.value = "User is required.";
    return;
  }
  if (props.mode === "add" && privateKey.length === 0) {
    error.value = "A private key is required.";
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    const json: Record<string, unknown> = {
      name: name.value.trim(),
      address: address.value.trim(),
      port: Number(port.value),
      username: username.value.trim(),
      requireApproval: requireApproval.value,
      approvalIdleSec: chosenIdle(),
      remoteRoot: remoteRoot.value.trim().length === 0 ? null : remoteRoot.value.trim(),
    };
    if (privateKey.length > 0) {
      json.privateKey = privateKey;
    }
    await apiMutation(props.action, { json }, { method: props.mode === "edit" ? "PATCH" : "POST" });
    if (keyInput.value !== null) {
      keyInput.value.value = "";
    }
    toasts.push(props.mode === "add" ? "Host added." : "Host updated.", "success");
    emit("saved");
    dialogEl.value?.close();
  } catch (caught) {
    const message =
      caught instanceof ApiError || caught instanceof Error
        ? caught.message
        : failureMessage("Could not save the host.");
    error.value = message;
    toasts.push(message, "error");
  } finally {
    busy.value = false;
  }
}

async function deleteHost(): Promise<void> {
  if (props.host === null || busy.value) {
    return;
  }
  if (!confirmingDelete.value) {
    confirmingDelete.value = true;
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await apiMutation(props.host.actions.api.delete, { json: {} }, { method: "DELETE" });
    toasts.push("Host deleted.", "success");
    emit("deleted");
    dialogEl.value?.close();
  } catch (caught) {
    const message =
      caught instanceof ApiError || caught instanceof Error
        ? caught.message
        : "Could not delete the host.";
    error.value = message;
    toasts.push(message, "error");
  } finally {
    busy.value = false;
  }
}

async function copyPublicKey(): Promise<void> {
  const publicKey = props.host?.credential?.publicKey;
  if (publicKey === undefined) {
    return;
  }
  try {
    await navigator.clipboard.writeText(publicKey);
    toasts.push("Public key copied.", "success");
  } catch {
    toasts.push("Could not copy the public key.", "error");
  }
}

defineExpose({ open });
</script>

<template>
  <dialog
    :id="dialogId"
    ref="dialogEl"
    class="dialog ssh-dialog"
    :aria-labelledby="`${dialogId}-title`"
    @close="onClose"
  >
    <div class="dialog__frame">
      <form class="dialog__form" method="post" :action="action" @submit.prevent="submit">
        <header class="dialog__head">
          <h2 :id="`${dialogId}-title`" class="dialog__title">{{ title }}</h2>
          <p class="dialog__meta">
            <template v-if="host === null">
              Coordinator-held key · per-application access
            </template>
            <template v-else> {{ host.username }}@{{ host.address }}:{{ host.port }} </template>
          </p>
        </header>
        <div class="dialog__body">
          <p v-if="error !== null" class="field-error" role="alert">
            <AppIcon name="alert-triangle" />{{ error }}
          </p>
          <fieldset class="ssh-form__group">
            <legend class="overline">Connection</legend>
            <div class="ssh-form__grid">
              <div class="field">
                <label class="label" :for="`${dialogId}-name`">Name (required)</label>
                <input
                  :id="`${dialogId}-name`"
                  v-model="name"
                  class="input"
                  name="name"
                  required
                  :disabled="busy"
                >
              </div>
              <div class="field">
                <label class="label" :for="`${dialogId}-address`">Address (required)</label>
                <input
                  :id="`${dialogId}-address`"
                  v-model="address"
                  class="input"
                  name="address"
                  required
                  placeholder="203.0.113.10"
                  :aria-describedby="`${dialogId}-address-hint`"
                  :disabled="busy"
                >
                <p :id="`${dialogId}-address-hint`" class="hint">
                  Hostname or IP reachable from the coordinator.
                </p>
              </div>
              <div class="field">
                <label class="label" :for="`${dialogId}-port`">Port</label>
                <input
                  :id="`${dialogId}-port`"
                  v-model="port"
                  class="input"
                  name="port"
                  type="number"
                  min="1"
                  max="65535"
                  required
                  :disabled="busy"
                >
              </div>
              <div class="field">
                <label class="label" :for="`${dialogId}-username`">User (required)</label>
                <input
                  :id="`${dialogId}-username`"
                  v-model="username"
                  class="input"
                  name="username"
                  required
                  placeholder="deploy"
                  :disabled="busy"
                >
              </div>
              <div class="field ssh-form__full">
                <label class="label" :for="`${dialogId}-remote-root`">
                  Remote root (optional)
                </label>
                <input
                  :id="`${dialogId}-remote-root`"
                  v-model="remoteRoot"
                  class="input mono"
                  name="remoteRoot"
                  placeholder="/srv/app"
                  :aria-describedby="`${dialogId}-remote-root-hint`"
                  :disabled="busy"
                >
                <p :id="`${dialogId}-remote-root-hint`" class="hint">
                  Confines SFTP transfers only. Commands are not confined to this directory.
                </p>
              </div>
            </div>
            <div v-if="mode === 'add'" class="ssh-warning">
              <AppIcon name="alert-triangle" />
              <p class="hint">
                Never target the coordinator host, a host that can read coordinator state, the
                Docker socket, or any host whose compromise grants control of this deployment.
              </p>
            </div>
          </fieldset>

          <fieldset class="ssh-form__group">
            <legend class="overline">Private key</legend>
            <div v-if="host?.credential" class="ssh-public-key">
              <div class="ssh-key-meta">
                <span class="overline">Client public key</span>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  aria-label="Copy public key"
                  @click="copyPublicKey"
                >
                  <AppIcon name="copy" />Copy
                </button>
              </div>
              <code :id="`ssh-pub-${host.id}`" class="ssh-fingerprint">
                {{ host.credential.publicKey }}
              </code>
              <div class="ssh-key-meta">
                <span class="badge badge--mono">{{ host.credential.keyType }}</span>
                <span v-if="host.credential.bits !== null" class="badge badge--mono">
                  {{ host.credential.bits }}
                  bits
                </span>
                <span class="mono">{{ host.credential.fingerprint }}</span>
              </div>
              <p class="hint">Install this public key on the remote account before testing.</p>
            </div>
            <div class="field">
              <label class="label" :for="`${dialogId}-private-key`">
                {{ mode === "add" ? "Private key (required)" : "Replace private key (optional)" }}
              </label>
              <textarea
                :id="`${dialogId}-private-key`"
                ref="keyInput"
                class="textarea mono"
                name="privateKey"
                :rows="mode === 'add' ? 5 : 4"
                :required="mode === 'add'"
                spellcheck="false"
                :aria-describedby="`${dialogId}-private-key-hint`"
                :disabled="busy"
              />
              <p :id="`${dialogId}-private-key-hint`" class="hint">
                Unencrypted OpenSSH key. It is sealed in the coordinator and never shown again; only
                the derived public key is displayed.
              </p>
            </div>
            <div class="field">
              <label class="label" :for="`${dialogId}-key-file`">
                {{
                  mode === "add"
                    ? "Load from file (optional)"
                    : "Load replacement from file (optional)"
                }}
              </label>
              <input
                :id="`${dialogId}-key-file`"
                class="input"
                type="file"
                :disabled="busy"
                @change="loadKeyFile"
              >
            </div>
          </fieldset>

          <fieldset class="ssh-form__group">
            <legend class="overline">Access policy</legend>
            <label class="check">
              <input
                v-model="requireApproval"
                class="checkbox"
                type="checkbox"
                name="requireApproval"
                value="1"
                :disabled="busy"
              >
              <span>Ask for approval before each session</span>
            </label>
            <div class="field">
              <label class="label" :for="`${dialogId}-idle`">Idle grant</label>
              <select
                :id="`${dialogId}-idle`"
                v-model="idle"
                class="select"
                name="approvalIdleSec"
                :aria-describedby="`${dialogId}-idle-hint`"
                :disabled="busy"
              >
                <option
                  v-for="seconds in idleOptionsFor(chosenIdle())"
                  :key="seconds"
                  :value="String(seconds)"
                >
                  {{ idleLabel(seconds) }}
                </option>
              </select>
              <p :id="`${dialogId}-idle-hint`" class="hint">
                How long an approved session stays usable without another request. The absolute cap
                is 8 hours.
              </p>
            </div>
          </fieldset>

          <fieldset v-if="editing && host !== null" class="ssh-form__group">
            <legend class="overline">Host key</legend>
            <div>
              <p class="label">Pinned fingerprint</p>
              <p class="ssh-fingerprint">
                {{ host.hostKeyFingerprint === null ? "Not pinned" : host.hostKeyFingerprint }}
              </p>
            </div>
            <p class="hint">
              {{
                host.hostKeyPinnedAt === null
                  ? "The next successful test pins it (TOFU)."
                  : `Pinned ${host.hostKeyPinnedAt}`
              }}
            </p>
            <p v-if="host.hostKeyMismatchAt !== null" class="field-error" role="alert">
              <AppIcon name="alert-triangle" />
              A mismatch was observed. Connections fail closed until the host is re-pinned.
            </p>
            <p class="hint">
              Changing the address or port clears the pin. Use Test connection and Prepare re-pin on
              the host card to change it.
            </p>
          </fieldset>

          <fieldset v-if="editing" class="ssh-form__group ssh-form__group--danger">
            <legend class="overline">Danger zone</legend>
            <p class="hint">
              Deleting this host removes its sealed key and every per-application grant. Audit
              history is kept.
            </p>
            <p v-if="confirmingDelete" class="field-error" role="alert">
              <AppIcon name="alert-triangle" />
              Click Delete host again to confirm. This cannot be undone.
            </p>
            <div class="cluster">
              <button
                class="btn btn-danger btn-sm"
                type="button"
                :disabled="busy"
                @click="deleteHost"
              >
                <AppIcon name="trash" />{{ confirmingDelete ? "Delete host" : labels.deleteHost }}
              </button>
              <button
                v-if="confirmingDelete"
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="busy"
                @click="confirmingDelete = false"
              >
                {{ labels.cancel }}
              </button>
            </div>
          </fieldset>
        </div>
        <footer class="dialog__foot">
          <button
            class="btn btn-ghost"
            type="button"
            data-dialog-close
            :disabled="busy"
            @click="close"
          >
            {{ labels.cancel }}
          </button>
          <button
            class="btn btn-primary"
            type="submit"
            :disabled="busy"
            :aria-busy="busy ? 'true' : undefined"
          >
            {{ busy ? "Saving…" : mode === "add" ? "Add host" : labels.saveHost }}
          </button>
        </footer>
      </form>
    </div>
  </dialog>
</template>
