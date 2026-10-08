<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "success" | "warning" | "danger";
}>();
</script>

<template>
  <div class="card stat">
    <div class="label">{{ label }}</div>
    <div class="value" :style="tone === 'danger' ? 'color: var(--danger)' : tone === 'warning' ? 'color: var(--warning)' : tone === 'success' ? 'color: var(--success)' : ''">
      {{ value }}
    </div>
    <div v-if="sub" class="sub">{{ sub }}</div>
  </div>
</template>
