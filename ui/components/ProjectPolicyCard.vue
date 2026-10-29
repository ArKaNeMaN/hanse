<script setup lang="ts">
import { computed, ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { HandoffDispatchMode, HandoffReplyMode, ProjectPolicy } from "../project-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{
  projectId: string;
  policy: ProjectPolicy;
  returnTo: string;
}>();
const emit = defineEmits<{ changed: [] }>();

const toasts = useToastStore();
const fromKey = ref("*");
const toKey = ref("*");
const dispatchMode = ref<HandoffDispatchMode>("auto");
const replyMode = ref<HandoffReplyMode>("auto");
const busy = ref(false);

const base = computed(() => `/api/projects/${encodeURIComponent(props.projectId)}/handoff-policy`);
const label = (value: string): string => (value === "*" ? "Any application" : value);

function failure(error: unknown, fallback: string): void {
  const message = error instanceof ApiError || error instanceof Error ? error.message : fallback;
  toasts.push(message, "error");
}

async function saveRule(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await apiMutation(base.value, {
      form: {
        from: fromKey.value,
        to: toKey.value,
        dispatch_mode: dispatchMode.value,
        reply_mode: replyMode.value,
        return_to: props.returnTo,
      },
    });
    toasts.push("Handoff policy saved.", "success");
    emit("changed");
  } catch (error) {
    failure(error, "Could not save the handoff policy.");
  } finally {
    busy.value = false;
  }
}

async function deleteRule(from: string, to: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await apiMutation(`${base.value}/delete`, {
      form: { from, to, return_to: props.returnTo },
    });
    toasts.push("Handoff policy rule deleted.", "success");
    emit("changed");
  } catch (error) {
    failure(error, "Could not delete the handoff policy rule.");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card" aria-labelledby="handoff-policy-title">
    <div class="card__head">
      <h2 class="card__title" id="handoff-policy-title">Handoff policy</h2>
      <span class="badge">{{ policy.rules.length }} rules</span>
    </div>
    <div class="card__body stack--tight">
      <p class="small">
        The most specific rule wins: exact pair, then one wildcard (a from-specific rule wins a
        tie), then the project default. No matching rule means
        <span class="mono">auto</span>
        dispatch and
        <span class="mono">auto</span>
        reply.
      </p>

      <p v-if="policy.rules.length === 0" class="small">
        No rules. Dispatch and replies are autonomous for every directed pair.
      </p>
      <div v-else class="table-wrap">
        <table class="table table--stack">
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Dispatch</th>
              <th scope="col">Reply</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in policy.rules" :key="rule.id">
              <td data-label="From"><span class="mono">{{ label(rule.fromAppKey) }}</span></td>
              <td data-label="To"><span class="mono">{{ label(rule.toAppKey) }}</span></td>
              <td data-label="Dispatch"><span class="mono">{{ rule.dispatchMode }}</span></td>
              <td data-label="Reply"><span class="mono">{{ rule.replyMode }}</span></td>
              <td data-label="" class="table__actions">
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="busy"
                  @click="deleteRule(rule.fromAppKey, rule.toAppKey)"
                >
                  Delete
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <form class="stack--tight" method="post" :action="base" @submit.prevent="saveRule">
        <div class="cluster">
          <div class="field">
            <label class="label" for="handoff-policy-from">From</label>
            <div class="select-wrap">
              <select
                id="handoff-policy-from"
                v-model="fromKey"
                class="select"
                name="from"
                :disabled="busy"
              >
                <option value="*">Any application</option>
                <option v-for="appKey in policy.appOptions" :key="appKey" :value="appKey">
                  {{ appKey }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-policy-to">To</label>
            <div class="select-wrap">
              <select
                id="handoff-policy-to"
                v-model="toKey"
                class="select"
                name="to"
                :disabled="busy"
              >
                <option value="*">Any application</option>
                <option v-for="appKey in policy.appOptions" :key="appKey" :value="appKey">
                  {{ appKey }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-policy-dispatch">Dispatch</label>
            <div class="select-wrap">
              <select
                id="handoff-policy-dispatch"
                v-model="dispatchMode"
                class="select"
                name="dispatch_mode"
                :disabled="busy"
              >
                <option v-for="mode in policy.dispatchModes" :key="mode" :value="mode">
                  {{ mode.charAt(0).toUpperCase() + mode.slice(1) }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-policy-reply">Reply</label>
            <div class="select-wrap">
              <select
                id="handoff-policy-reply"
                v-model="replyMode"
                class="select"
                name="reply_mode"
                :disabled="busy"
              >
                <option v-for="mode in policy.replyModes" :key="mode" :value="mode">
                  {{ mode.charAt(0).toUpperCase() + mode.slice(1) }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
        </div>
        <input type="hidden" name="return_to" :value="returnTo">
        <div class="cluster">
          <button class="btn btn-secondary btn-sm" type="submit" :disabled="busy">Save rule</button>
        </div>
      </form>
    </div>
  </section>
</template>
