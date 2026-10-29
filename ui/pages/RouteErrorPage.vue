<script setup lang="ts">
defineProps<{ message: string }>();

function retry(): void {
  window.location.reload();
}
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Interface</p>
      <h1 class="page-title">This view could not be rendered</h1>
      <p class="page-description">
        The client hit an unexpected error while rendering this route. Reload, or switch to the
        classic interface.
      </p>
      <p class="hint">{{ message }}</p>
    </div>
  </header>

  <div class="page__body">
    <div class="empty-state">
      <span class="empty-state__mark">
        <svg class="icon icon--lg" aria-hidden="true" focusable="false">
          <use href="#i-alert-triangle" />
        </svg>
      </span>
      <h3 class="empty-state__title">Unexpected error</h3>
      <p class="empty-state__body">No data was changed.</p>
      <div class="cluster">
        <button class="btn btn-secondary btn-sm" type="button" @click="retry">Reload</button>
        <a class="btn btn-ghost btn-sm" href="?legacy=1">Use the classic interface</a>
      </div>
    </div>
  </div>
</template>
