<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { ProjectGrantsProps } from "../project-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";

type GrantMode = "auto" | "approve";

const props = defineProps<{
  projectId: string;
  grants: ProjectGrantsProps;
  returnTo: string;
}>();
const emit = defineEmits<{ changed: [] }>();

const toasts = useToastStore();
const fromKey = ref("*");
const targetProjectId = ref(props.grants.targetProjects[0]?.id ?? "");
const toKey = ref("*");
const dispatchMode = ref<GrantMode>("auto");
const replyMode = ref<GrantMode>("auto");
const busy = ref(false);

const base = computed(() => `/api/projects/${encodeURIComponent(props.projectId)}/handoff-grants`);
const fromOptions = computed(() => [
  props.grants.wildcard,
  ...props.grants.fromOptions.filter((key) => key !== props.grants.wildcard),
]);
const selectedTarget = computed(() =>
  props.grants.targetProjects.find((project) => project.id === targetProjectId.value),
);
const toOptions = computed(() => [props.grants.wildcard, ...(selectedTarget.value?.appKeys ?? [])]);
const hasTargets = computed(() => props.grants.targetProjects.length > 0);

watch(
  () => props.grants.targetProjects,
  (projects) => {
    if (!projects.some((project) => project.id === targetProjectId.value)) {
      targetProjectId.value = projects[0]?.id ?? "";
      toKey.value = props.grants.wildcard;
    }
  },
);
watch(targetProjectId, () => {
  toKey.value = props.grants.wildcard;
});

function label(value: string): string {
  return value === props.grants.wildcard ? "Any application" : value;
}

function failure(error: unknown, fallback: string): void {
  const message = error instanceof ApiError || error instanceof Error ? error.message : fallback;
  toasts.push(message, "error");
}

async function saveGrant(): Promise<void> {
  if (busy.value || !hasTargets.value) return;
  busy.value = true;
  try {
    await apiMutation(base.value, {
      form: {
        from: fromKey.value,
        target_project: targetProjectId.value,
        to: toKey.value,
        dispatch_mode: dispatchMode.value,
        reply_mode: replyMode.value,
        return_to: props.returnTo,
      },
    });
    toasts.push("Cross-project grant saved.", "success");
    emit("changed");
  } catch (error) {
    failure(error, "Could not save the cross-project grant.");
  } finally {
    busy.value = false;
  }
}

async function revokeGrant(from: string, targetProject: string, to: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await apiMutation(`${base.value}/delete`, {
      form: {
        from,
        target_project: targetProject,
        to,
        return_to: props.returnTo,
      },
    });
    toasts.push("Cross-project grant revoked.", "success");
    emit("changed");
  } catch (error) {
    failure(error, "Could not revoke the cross-project grant.");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card" aria-labelledby="handoff-grants-title">
    <div class="card__head">
      <h2 class="card__title" id="handoff-grants-title">Cross-project grants</h2>
      <span class="badge">{{ grants.outbound.length }} grants</span>
    </div>
    <div class="card__body stack--tight">
      <p class="small">
        A grant lets an application in this project route work to an application in another project.
        Grants are owned by the source project; the target project only sees them read-only.
      </p>

      <p v-if="grants.outbound.length === 0" class="small">
        No outbound grants. This project can only hand off to its own applications.
      </p>
      <div v-else class="table-wrap">
        <table class="table table--stack">
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">Target project</th>
              <th scope="col">To</th>
              <th scope="col">Dispatch</th>
              <th scope="col">Reply</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="grant in grants.outbound" :key="grant.id">
              <td data-label="From"><span class="mono">{{ label(grant.fromAppKey) }}</span></td>
              <td data-label="Target project">
                <span class="mono" :title="grant.targetProjectId">
                  {{ grant.targetProjectName }}
                </span>
              </td>
              <td data-label="To"><span class="mono">{{ label(grant.toAppKey) }}</span></td>
              <td data-label="Dispatch"><span class="mono">{{ grant.dispatchMode }}</span></td>
              <td data-label="Reply"><span class="mono">{{ grant.replyMode }}</span></td>
              <td data-label="" class="table__actions">
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="busy"
                  @click="revokeGrant(grant.fromAppKey, grant.targetProjectId, grant.toAppKey)"
                >
                  Revoke
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <form class="stack--tight" method="post" :action="base" @submit.prevent="saveGrant">
        <p class="overline">New outbound grant</p>
        <div class="cluster">
          <div class="field">
            <label class="label" for="handoff-grant-from">From</label>
            <div class="select-wrap">
              <select
                id="handoff-grant-from"
                v-model="fromKey"
                class="select"
                name="from"
                :disabled="busy"
              >
                <option v-for="appKey in fromOptions" :key="appKey" :value="appKey">
                  {{ label(appKey) }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-grant-target-project">Target project</label>
            <div class="select-wrap">
              <select
                id="handoff-grant-target-project"
                v-model="targetProjectId"
                class="select"
                name="target_project"
                :disabled="busy || !hasTargets"
              >
                <option v-if="!hasTargets" value="">No other projects available</option>
                <option
                  v-for="project in grants.targetProjects"
                  :key="project.id"
                  :value="project.id"
                >
                  {{ project.name }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-grant-to">To</label>
            <div class="select-wrap">
              <select
                id="handoff-grant-to"
                v-model="toKey"
                class="select"
                name="to"
                :disabled="busy || !hasTargets"
              >
                <option v-for="appKey in toOptions" :key="appKey" :value="appKey">
                  {{ label(appKey) }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-grant-dispatch">Dispatch</label>
            <div class="select-wrap">
              <select
                id="handoff-grant-dispatch"
                v-model="dispatchMode"
                class="select"
                name="dispatch_mode"
                :disabled="busy"
              >
                <option v-for="mode in grants.dispatchModes" :key="mode" :value="mode">
                  {{ mode.charAt(0).toUpperCase() + mode.slice(1) }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-grant-reply">Reply</label>
            <div class="select-wrap">
              <select
                id="handoff-grant-reply"
                v-model="replyMode"
                class="select"
                name="reply_mode"
                :disabled="busy"
              >
                <option v-for="mode in grants.replyModes" :key="mode" :value="mode">
                  {{ mode.charAt(0).toUpperCase() + mode.slice(1) }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
        </div>
        <input type="hidden" name="return_to" :value="returnTo">
        <div class="cluster">
          <button class="btn btn-secondary btn-sm" type="submit" :disabled="busy || !hasTargets">
            Save grant
          </button>
        </div>
      </form>

      <div class="stack--tight">
        <p class="overline">Inbound grants</p>
        <p class="small">
          Read-only. These grants were created by other projects; this is visibility, not consent,
          and only the source project can revoke them.
        </p>
        <p v-if="grants.inbound.length === 0" class="small">
          No other project may route work into this project.
        </p>
        <div v-else class="table-wrap">
          <table class="table table--stack">
            <thead>
              <tr>
                <th scope="col">Source project</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Dispatch</th>
                <th scope="col">Reply</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="grant in grants.inbound" :key="grant.id">
                <td data-label="Source project">
                  <span class="mono" :title="grant.sourceProjectId">
                    {{ grant.sourceProjectName }}
                  </span>
                </td>
                <td data-label="From"><span class="mono">{{ label(grant.fromAppKey) }}</span></td>
                <td data-label="To"><span class="mono">{{ label(grant.toAppKey) }}</span></td>
                <td data-label="Dispatch"><span class="mono">{{ grant.dispatchMode }}</span></td>
                <td data-label="Reply"><span class="mono">{{ grant.replyMode }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>
