<script setup lang="ts">
import type { BootPayload } from "../boot.js";

defineProps<{ boot: BootPayload }>();
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">404</p>
      <h1 class="page-title">Page not found</h1>
      <p class="page-description">
        The route does not exist, or the project was not discovered by this coordinator.
      </p>
    </div>
  </header>

  <div class="page__body">
    <div class="empty-state">
      <span class="empty-state__mark">
        <svg class="icon icon--lg" aria-hidden="true" focusable="false">
          <use href="#i-alert-triangle" />
        </svg>
      </span>
      <h3 class="empty-state__title">Nothing is moored here</h3>
      <p class="empty-state__body">
        Check the address, or return to the fleet overview to find the project you expected.
      </p>
      <div class="cluster">
        <a class="btn btn-primary btn-sm" href="/">Open overview</a>
        <a class="btn btn-secondary btn-sm" href="/projects">Browse projects</a>
      </div>
    </div>
  </div>
</template>
