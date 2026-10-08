<script setup lang="ts">
// AsyncSection renders the three states every data card has: loading, error
// and content, so views do not repeat the same v-if ladder.
defineProps<{ loading: boolean; error?: string }>();
</script>

<template>
  <div v-if="loading" class="page-loading"><div class="spinner" /></div>
  <div v-else-if="error" class="card-body"><div class="alert error">{{ error }}</div></div>
  <slot v-else />
</template>
