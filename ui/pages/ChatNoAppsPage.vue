<script setup lang="ts">
import type { BootPayload } from "../boot.js";

defineProps<{ boot: BootPayload }>();
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Workbench</p>
      <h1 class="page-title">Chat</h1>
      <p class="page-description">A workspace for one application agent at a time.</p>
    </div>
  </header>

  <div class="page__body">
    <div class="empty-state">
      <span class="empty-state__mark">
        <svg class="icon icon--lg" aria-hidden="true" focusable="false">
          <use href="#i-message" />
        </svg>
      </span>
      <h3 class="empty-state__title">No applications yet</h3>
      <p class="empty-state__body">
        Add an application to a project before opening a chat. The agent starts when you open its
        workspace.
      </p>
      <div class="cluster">
        <a class="btn btn-primary btn-sm" href="/projects">Open projects</a>
        <a class="btn btn-secondary btn-sm" :href="boot.chrome.masterHref">Open master chat</a>
      </div>
    </div>
  </div>
</template>
