<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { BootPayload } from "../boot.js";
import AppIcon from "../components/AppIcon.vue";
import { fullDocumentNavigate } from "../navigation.js";

interface LoginProps {
  readonly next?: unknown;
}

const props = defineProps<{ boot: BootPayload }>();

function localNext(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (value === "/login" || value.startsWith("/login?")) return "/";
  return value;
}

const next = computed(() => localNext((props.boot.props as LoginProps | undefined)?.next));
const token = ref("");
const showToken = ref(false);
const busy = ref(false);
const errorMessage = ref<string | undefined>(undefined);
const input = ref<HTMLInputElement | null>(null);

onMounted(() => input.value?.focus());

async function submit(): Promise<void> {
  if (busy.value) return;
  const value = token.value.trim();
  if (value.length === 0) {
    errorMessage.value = "Enter the operator token.";
    return;
  }
  busy.value = true;
  errorMessage.value = undefined;
  try {
    const result = await apiMutation<{ ok: boolean; next?: unknown }>(
      "/api/session",
      { json: { token: value, next: next.value } },
      { onUnauthorized: () => undefined },
    );
    fullDocumentNavigate(localNext(result.next ?? next.value));
  } catch (error) {
    errorMessage.value =
      error instanceof ApiError && error.status === 401
        ? "Token rejected. Check the value and try again."
        : "Sign in failed. Try again.";
    busy.value = false;
  }
}
</script>

<template>
  <div></div>
  <section class="login-plate" aria-labelledby="login-title">
    <div class="login-plate__head">
      <span class="login-plate__brand">hanse</span>
      <span class="sidebar__kicker">coordinator</span>
    </div>
    <hr class="rule rule--double">
    <h1 class="h2" id="login-title">Operator sign-in</h1>
    <p class="body">Enter the operator token to open the chart room.</p>
    <form class="stack" @submit.prevent="submit">
      <div class="field" :data-invalid="errorMessage !== undefined ? 'true' : undefined">
        <label class="label" for="token">Operator token (required)</label>
        <div class="field__control">
          <input
            id="token"
            ref="input"
            v-model="token"
            class="input"
            name="token"
            :type="showToken ? 'text' : 'password'"
            required
            autocomplete="current-password"
            :aria-invalid="errorMessage !== undefined ? 'true' : undefined"
            :aria-describedby="errorMessage !== undefined ? 'token-error' : 'token-hint'"
          >
          <button
            class="btn btn-ghost btn-icon btn-sm"
            type="button"
            data-password-toggle
            :aria-label="showToken ? 'Hide token' : 'Show token'"
            :aria-pressed="showToken ? 'true' : 'false'"
            @click="showToken = !showToken"
          >
            <AppIcon :name="showToken ? 'eye-off' : 'eye'" />
          </button>
        </div>
        <p v-if="errorMessage !== undefined" class="field-error" id="token-error" role="alert">
          <AppIcon name="alert-circle" />{{ errorMessage }}
        </p>
        <p v-else class="hint" id="token-hint">
          The operator token is set by HANSE_OPERATOR_TOKEN.
        </p>
      </div>
      <button
        class="btn btn-primary btn-lg btn-block"
        type="submit"
        :disabled="busy"
        :aria-busy="busy ? 'true' : undefined"
      >
        <span v-if="busy" class="spinner" aria-hidden="true" />
        <span class="btn__label">Sign in</span>
      </button>
    </form>
    <p class="caption">The session stays on this browser for 30 days. Sign out from the sidebar.</p>
  </section>
  <p class="caption login-plate__foot">hanse coordinator / operator access</p>
</template>
