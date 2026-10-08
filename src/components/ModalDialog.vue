<script setup lang="ts">
defineProps<{ title: string; open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="emit('close')">
    <div class="card" style="width: min(520px, 92vw)">
      <div class="card-head">
        <h2>{{ title }}</h2>
        <button class="btn ghost small" @click="emit('close')">×</button>
      </div>
      <div class="card-body"><slot /></div>
      <div v-if="$slots.footer" class="card-head" style="border-top: 1px solid var(--border); border-bottom: none; justify-content: flex-end">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgb(15 17 21 / 45%);
  display: grid;
  place-items: center;
  z-index: 60;
  padding: 16px;
}
</style>
