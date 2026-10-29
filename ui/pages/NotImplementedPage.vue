<script setup lang="ts">
import type { BootPayload } from "../boot.js";

defineProps<{ boot: BootPayload }>();
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <p class="overline">Interface</p>
      <h1 class="page-title">This view is not migrated yet</h1>
      <p class="page-description">
        The client application is only registered for migrated routes. Open the classic interface to
        use this page.
      </p>
    </div>
  </header>

  <div class="page__body">
    <section class="card">
      <div class="card__body stack--tight">
        <p class="small">No data was changed and no request was sent.</p>
        <div class="cluster">
          <a class="btn btn-secondary" href="?legacy=1">Use the classic interface</a>
        </div>
      </div>
    </section>
  </div>
</template>
