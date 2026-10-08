<script setup lang="ts">
defineProps<{ online?: boolean; expired?: boolean; ephemeral?: boolean; label?: string }>();
</script>

<template>
  <span class="badge" :class="expired ? 'danger' : online ? 'success' : ''">
    <span class="dot" :class="expired ? '' : online ? 'online' : 'offline'" />
    {{ label || (expired ? "密钥过期" : online ? "在线" : "离线") }}
  </span>
</template>
