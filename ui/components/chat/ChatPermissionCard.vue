<script setup lang="ts">
/**
 * One permission request. Risk and scope stay visible before any grant; "always" and "deny" require
 * an explicit confirmation step so a click cannot silently widen the grant.
 */
import { computed, ref } from "vue";
import type { NormalizedPermissionRequest } from "../../../src/opencode/prompts.js";
import { permissionRisk, permissionRiskLabel, permissionTitle } from "../../chat/prompt-utils.js";
import AppIcon from "../AppIcon.vue";

const props = defineProps<{
  request: NormalizedPermissionRequest;
  busy?: boolean;
  error?: string;
  disabled?: boolean;
  queueCount?: number;
}>();

const emit = defineEmits<{
  once: [];
  always: [];
  deny: [message: string];
  "open-saved": [];
}>();

const confirm = ref<"always" | "deny" | null>(null);
const feedback = ref("");
const risk = computed(() => permissionRisk(props.request));
const title = computed(() => permissionTitle(props.request.permission));
const canAlways = computed(() => props.request.always.length > 0);
const busy = computed(() => props.busy === true || props.disabled === true);

function requestOnce(): void {
  if (!busy.value) emit("once");
}

function requestAlways(): void {
  if (busy.value || !canAlways.value) return;
  if (confirm.value === "always") {
    confirm.value = null;
    emit("always");
    return;
  }
  confirm.value = "always";
}

function requestDeny(): void {
  if (busy.value) return;
  if (confirm.value === "deny") {
    confirm.value = null;
    emit("deny", feedback.value.trim());
    return;
  }
  confirm.value = "deny";
}

function cancelConfirm(): void {
  confirm.value = null;
  feedback.value = "";
}
</script>

<template>
  <article
    class="prompt-dock__card"
    data-prompt-kind="permission"
    :data-permission-key="request.key"
    :data-permission="request.permission"
    :aria-labelledby="`permission-title-${request.key}`"
  >
    <header class="prompt-dock__head">
      <div class="prompt-dock__identity">
        <span class="overline" :id="`permission-title-${request.key}`" tabindex="-1"
          >Permission</span
        >
        <span class="risk-chip" :data-risk="risk" data-permission-risk>
          <AppIcon :name="risk === 'high' ? 'alert-triangle' : 'alert-circle'" />
          <span>{{ permissionRiskLabel(risk) }}</span>
        </span>
        <span v-if="queueCount !== undefined && queueCount > 0" class="prompt-dock__queue-count">
          {{ queueCount }}
          more waiting
        </span>
      </div>
    </header>

    <div class="prompt-dock__body">
      <h3 class="prompt-dock__title">{{ title }}</h3>
      <div class="prompt-scope">
        <div class="prompt-scope__row">
          <span class="prompt-scope__label">This request:</span>
          <ul v-if="request.patterns.length > 0" class="prompt-scope__list">
            <li v-for="pattern in request.patterns" :key="pattern" class="mono">{{ pattern }}</li>
          </ul>
          <span v-else class="caption">This request only.</span>
        </div>
        <div v-if="canAlways" class="prompt-scope__row">
          <span class="prompt-scope__label">Always grants:</span>
          <ul class="prompt-scope__list">
            <li v-for="pattern in request.always" :key="pattern" class="mono">{{ pattern }}</li>
          </ul>
        </div>
        <p class="prompt-scope__note">
          {{
            request.source === "v2"
              ? "Saved for this project until revoked."
              : "For this app instance until restart."
          }}
        </p>
        <button
          v-if="request.source === 'v2'"
          class="btn btn-secondary btn-sm prompt-scope__action"
          type="button"
          data-permission-open-saved
          @click="emit('open-saved')"
        >
          Saved permissions
        </button>
      </div>

      <div v-if="confirm === 'always'" class="prompt-confirm">
        <p class="prompt-confirm__text">
          {{
            request.source === "v2"
              ? "Always allow is saved for this project until revoked."
              : "Always allow applies to this app instance until it restarts."
          }}
        </p>
        <p class="caption">This grants:</p>
        <ul class="prompt-scope__list">
          <li v-for="pattern in request.always" :key="pattern" class="mono">{{ pattern }}</li>
        </ul>
        <div class="cluster">
          <button class="btn btn-ghost btn-sm" type="button" @click="cancelConfirm">Cancel</button>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            data-permission-confirm-always
            @click="requestAlways"
          >
            Always allow
          </button>
        </div>
      </div>
      <div v-else-if="confirm === 'deny'" class="prompt-confirm">
        <p class="prompt-confirm__text">Deny this request?</p>
        <p class="caption">
          Denying also rejects other pending permission requests in this session.
        </p>
        <label class="label" :for="`permission-feedback-${request.key}`">Feedback (optional)</label>
        <textarea
          :id="`permission-feedback-${request.key}`"
          v-model="feedback"
          class="textarea prompt-feedback"
          rows="2"
          maxlength="4000"
        />
        <div class="cluster">
          <button class="btn btn-ghost btn-sm" type="button" @click="cancelConfirm">Cancel</button>
          <button
            class="btn btn-danger btn-sm"
            type="button"
            data-permission-confirm-deny
            @click="requestDeny"
          >
            Deny request
          </button>
        </div>
      </div>

      <p v-if="error !== undefined" class="field-error prompt-dock__error" role="alert">
        {{ error }}
      </p>
    </div>

    <div v-if="confirm === null" class="prompt-dock__foot">
      <div class="cluster">
        <button
          class="btn btn-danger btn-sm"
          type="button"
          data-permission-deny
          :disabled="busy"
          @click="requestDeny"
        >
          Deny
        </button>
      </div>
      <div class="cluster">
        <button
          v-if="canAlways"
          class="btn btn-secondary btn-sm"
          type="button"
          data-permission-always
          :disabled="busy"
          @click="requestAlways"
        >
          Always allow
        </button>
        <button
          class="btn btn-primary btn-sm"
          type="button"
          data-permission-once
          :disabled="busy"
          :aria-busy="busy"
          @click="requestOnce"
        >
          {{ busy ? "Sending reply…" : error !== undefined ? "Try again" : "Allow once" }}
        </button>
      </div>
    </div>
  </article>
</template>
