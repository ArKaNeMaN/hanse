<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import type { SkillSourceDialogPayload, SkillSourceView } from "../skill-sources-types.js";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{
  open: boolean;
  mode: "create" | "edit";
  source?: SkillSourceView | null;
  busy?: boolean;
}>();

const emit = defineEmits<{ submit: [SkillSourceDialogPayload]; cancel: [] }>();

const dialogEl = ref<HTMLDialogElement | null>(null);
const error = ref<string | null>(null);
const slugEdited = ref(false);

interface FormModel {
  name: string;
  slug: string;
  endpoint: string;
  buckets: string;
  token: string;
  allowInsecureHttp: boolean;
  priority: string;
  syncIntervalSec: string;
  staleAfterSec: string;
  requestTimeoutMs: string;
}

const form = reactive<FormModel>({
  name: "",
  slug: "",
  endpoint: "",
  buckets: "",
  token: "",
  allowInsecureHttp: false,
  priority: "100",
  syncIntervalSec: "900",
  staleAfterSec: "86400",
  requestTimeoutMs: "15000",
});

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}

function reset(): void {
  const source = props.mode === "edit" ? props.source : null;
  form.name = source?.name ?? "";
  form.slug = source?.slug ?? "";
  form.endpoint = source?.endpoint ?? "";
  form.buckets = source?.config.buckets.join(", ") ?? "";
  form.token = "";
  form.allowInsecureHttp = source?.config.allowInsecureHttp ?? false;
  form.priority = String(source?.priority ?? 100);
  form.syncIntervalSec = String(source?.syncIntervalSec ?? 900);
  form.staleAfterSec = String(source?.staleAfterSec ?? 86400);
  form.requestTimeoutMs = String(source?.requestTimeoutMs ?? 15000);
  slugEdited.value = props.mode === "edit";
  error.value = null;
}

function syncOpenState(open: boolean): void {
  const dialog = dialogEl.value;
  if (dialog === null) {
    return;
  }
  if (open) {
    reset();
    if (!dialog.open) {
      dialog.showModal();
    }
  } else if (dialog.open) {
    dialog.close();
  }
}

watch(() => props.open, syncOpenState);
onMounted(() => syncOpenState(props.open));

watch(
  () => form.name,
  (name) => {
    if (!slugEdited.value && props.mode === "create") {
      form.slug = slugify(name);
    }
  },
);

const insecureCandidate = computed(() => form.endpoint.trim().toLowerCase().startsWith("http://"));

watch(insecureCandidate, (insecure) => {
  if (!insecure) {
    form.allowInsecureHttp = false;
  }
});

function parseBuckets(): string[] | undefined {
  const values = form.buckets
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const value of values) {
    if (value.length > 64 || !SLUG_PATTERN.test(value)) {
      error.value = `Bucket "${value}" must use lowercase letters, digits, and single hyphens.`;
      return undefined;
    }
  }
  return values;
}

function parseInteger(value: string, label: string, minimum: number): number | undefined {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < minimum) {
    error.value = `${label} must be a whole number of at least ${minimum}.`;
    return undefined;
  }
  return parsed;
}

function validateEndpoint(): boolean {
  const raw = form.endpoint.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    error.value = "Endpoint must be an absolute http or https URL.";
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    error.value = "Endpoint must use http or https.";
    return false;
  }
  if (parsed.protocol === "http:" && !form.allowInsecureHttp) {
    error.value = "Enable insecure HTTP or use an HTTPS endpoint.";
    return false;
  }
  return true;
}

function onSubmit(): void {
  if (props.busy === true) {
    return;
  }
  error.value = null;
  const name = form.name.trim();
  if (name.length === 0 || name.length > 128) {
    error.value = "Name is required and must be at most 128 characters.";
    return;
  }
  const slug = form.slug.trim();
  if (slug.length === 0 || slug.length > 64 || !SLUG_PATTERN.test(slug)) {
    error.value = "Slug must use lowercase letters, digits, and single hyphens.";
    return;
  }
  if (!validateEndpoint()) {
    return;
  }
  const buckets = parseBuckets();
  if (buckets === undefined) {
    return;
  }
  const priority = parseInteger(form.priority, "Priority", 0);
  if (priority === undefined) {
    return;
  }
  const syncIntervalSec = parseInteger(form.syncIntervalSec, "Sync interval", 1);
  if (syncIntervalSec === undefined) {
    return;
  }
  const staleAfterSec = parseInteger(form.staleAfterSec, "Stale after", 1);
  if (staleAfterSec === undefined) {
    return;
  }
  const requestTimeoutMs = parseInteger(form.requestTimeoutMs, "Request timeout", 1);
  if (requestTimeoutMs === undefined) {
    return;
  }
  const isCreate = props.mode === "create";
  emit("submit", {
    name,
    slug,
    endpoint: form.endpoint.trim(),
    buckets,
    allowInsecureHttp: form.allowInsecureHttp,
    token: isCreate && form.token.length > 0 ? form.token : null,
    priority,
    syncIntervalSec,
    staleAfterSec,
    requestTimeoutMs,
  });
}

function onCancel(): void {
  if (props.busy === true) {
    return;
  }
  emit("cancel");
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog skill-source-dialog"
    aria-labelledby="skill-source-dialog-title"
    @cancel.prevent="onCancel"
  >
    <div class="dialog__frame">
      <form class="dialog__form" @submit.prevent="onSubmit">
        <div class="dialog__head">
          <h2 class="dialog__title" id="skill-source-dialog-title">
            {{ mode === "create" ? "Add skill source" : "Edit skill source" }}
          </h2>
          <p v-if="mode === 'edit' && source" class="dialog__meta mono">{{ source.slug }}</p>
        </div>

        <div class="dialog__body">
          <p v-if="error !== null" class="field-error" role="alert">{{ error }}</p>

          <div class="field">
            <label class="label" for="skill-source-name">Name</label>
            <input
              id="skill-source-name"
              v-model="form.name"
              class="input"
              name="name"
              type="text"
              maxlength="128"
              autocomplete="off"
              required
            >
          </div>

          <div v-if="mode === 'create'" class="field">
            <label class="label" for="skill-source-slug">Slug</label>
            <input
              id="skill-source-slug"
              v-model="form.slug"
              class="input mono"
              name="slug"
              type="text"
              maxlength="64"
              autocomplete="off"
              :aria-describedby="'skill-source-slug-hint'"
              required
              @input="slugEdited = true"
            >
            <p class="hint" id="skill-source-slug-hint">
              Lowercase letters, digits, and single hyphens. Auto-derived from the name.
            </p>
          </div>
          <p v-else class="hint">Slug <span class="mono">{{ source?.slug }}</span> is permanent.</p>

          <div class="field">
            <label class="label" for="skill-source-endpoint">Endpoint</label>
            <input
              id="skill-source-endpoint"
              v-model="form.endpoint"
              class="input mono"
              name="endpoint"
              type="url"
              placeholder="https://&lt;skills-hub-host&gt;"
              autocomplete="off"
              required
            >
          </div>

          <div class="field">
            <label class="label" for="skill-source-buckets">Buckets</label>
            <input
              id="skill-source-buckets"
              v-model="form.buckets"
              class="input mono"
              name="buckets"
              type="text"
              placeholder="default"
              autocomplete="off"
              aria-describedby="skill-source-buckets-hint"
            >
            <p class="hint" id="skill-source-buckets-hint">
              Comma-separated bucket slugs. Leave empty for every bucket.
            </p>
          </div>

          <div v-if="mode === 'create'" class="field">
            <label class="label" for="skill-source-token">Token</label>
            <input
              id="skill-source-token"
              v-model="form.token"
              class="input"
              name="token"
              type="password"
              autocomplete="new-password"
              aria-describedby="skill-source-token-hint"
            >
            <p class="hint" id="skill-source-token-hint">
              Stored write-only. You will not be able to view it again.
            </p>
          </div>

          <template v-if="insecureCandidate">
            <label class="check">
              <input v-model="form.allowInsecureHttp" class="checkbox" type="checkbox">
              <span>Allow insecure HTTP</span>
            </label>
            <p class="field-error" role="note">
              <AppIcon name="alert-triangle" />Only enable for a trusted LAN source. The token is
              sent unencrypted.
            </p>
          </template>

          <details class="disclosure skill-source-dialog__advanced">
            <summary>
              Advanced
              <AppIcon name="chevron-down" class-name="disclosure__chevron" />
            </summary>
            <div class="skill-source-form__grid">
              <div class="field">
                <label class="label" for="skill-source-priority">Priority</label>
                <input
                  id="skill-source-priority"
                  v-model="form.priority"
                  class="input mono"
                  name="priority"
                  type="number"
                  min="0"
                  step="1"
                >
              </div>
              <div class="field">
                <label class="label" for="skill-source-sync-interval"
                  >Sync interval (seconds)</label
                >
                <input
                  id="skill-source-sync-interval"
                  v-model="form.syncIntervalSec"
                  class="input mono"
                  name="syncIntervalSec"
                  type="number"
                  min="1"
                  step="1"
                >
              </div>
              <div class="field">
                <label class="label" for="skill-source-stale-after">Stale after (seconds)</label>
                <input
                  id="skill-source-stale-after"
                  v-model="form.staleAfterSec"
                  class="input mono"
                  name="staleAfterSec"
                  type="number"
                  min="1"
                  step="1"
                >
              </div>
              <div class="field">
                <label class="label" for="skill-source-request-timeout">
                  Request timeout (ms)
                </label>
                <input
                  id="skill-source-request-timeout"
                  v-model="form.requestTimeoutMs"
                  class="input mono"
                  name="requestTimeoutMs"
                  type="number"
                  min="1"
                  step="1"
                >
              </div>
            </div>
          </details>
        </div>

        <div class="dialog__foot">
          <button class="btn btn-ghost" type="button" :disabled="busy" @click="onCancel">
            Cancel
          </button>
          <button class="btn btn-primary" type="submit" :disabled="busy">
            {{ mode === "create" ? "Add and sync" : "Save changes" }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>
