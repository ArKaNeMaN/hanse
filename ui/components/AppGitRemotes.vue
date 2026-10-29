<script setup lang="ts">
import { computed } from "vue";
import type { GitRemoteState, GitStatus } from "../git-types.js";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{
  status: GitStatus | null;
  failure: boolean;
  loaded: boolean;
}>();

const remotes = computed<readonly GitRemoteState[]>(() => props.status?.remotes ?? []);
const unavailable = computed(
  () =>
    props.failure ||
    (props.status !== null && props.status.state !== "ok") ||
    (props.status === null && !props.loaded),
);
</script>

<template>
  <section class="card" aria-labelledby="remotes-title" id="remotes-card">
    <div class="card__head">
      <h2 class="card__title" id="remotes-title">Remotes</h2>
    </div>
    <div class="card__body stack--tight" id="git-remotes-body">
      <p v-if="unavailable" class="hint">Remotes are unavailable for this repository.</p>
      <div v-else-if="remotes.length === 0" class="empty-state">
        <span class="empty-state__mark">
          <AppIcon name="branch" class-name="icon--lg" />
        </span>
        <h3 class="empty-state__title">No remotes configured.</h3>
        <p class="empty-state__body">Fetch and push need a remote. Local commits still work.</p>
      </div>
      <ul v-else class="git-file-list">
        <li v-for="remote in remotes" :key="remote.name" class="git-file">
          <span class="badge badge--mono">{{ remote.name || "remote" }}</span>
          <span class="git-file__path mono" :title="remote.url">{{ remote.url }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>
