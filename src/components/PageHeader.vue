<script setup lang="ts">
defineProps<{ title: string; desc?: string }>();
</script>

<template>
  <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap">
    <div>
      <h1>{{ title }}</h1>
      <p v-if="desc" style="color: var(--text-muted); margin-top: 6px; font-size: 13px">{{ desc }}</p>
    </div>
    <div style="display: flex; gap: 10px; align-items: center">
      <slot name="actions" />
    </div>
  </div>
</template>
