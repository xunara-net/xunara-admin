<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
const props = defineProps<{ title: string; open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();
const titleID = useId();
const dialog = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
let previousOverflow = "";
let locked = false;
function unlock() {
  if (!locked) return;
  document.body.style.overflow = previousOverflow; locked = false;
  if (previousFocus?.isConnected) previousFocus.focus();
}
watch(() => props.open, async (open) => {
  if (!open) { unlock(); return; }
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden"; locked = true;
  await nextTick();
  if (props.open) dialog.value?.focus();
}, { immediate: true });
function keyboard(event: KeyboardEvent) {
  if (event.key === "Escape") { event.preventDefault(); emit("close"); return; }
  if (event.key !== "Tab") return;
  const controls = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []).filter((control) => control.getClientRects().length);
  const first = controls[0], last = controls[controls.length - 1];
  if (!first || !last) { event.preventDefault(); dialog.value?.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first.focus(); }
}
onBeforeUnmount(unlock);
</script>

<template>
  <Teleport to="body"><div v-if="open" class="modal-mask" @click.self="emit('close')">
    <div ref="dialog" class="card modal-card" role="dialog" aria-modal="true" :aria-labelledby="titleID" tabindex="-1" @keydown="keyboard">
      <div class="card-head">
        <h2 :id="titleID">{{ title }}</h2>
        <button class="btn ghost small" aria-label="关闭弹窗" @click="emit('close')">×</button>
      </div>
      <div class="card-body"><slot /></div>
      <div v-if="$slots.footer" class="card-head" style="border-top: 1px solid var(--border); border-bottom: none; justify-content: flex-end">
        <slot name="footer" />
      </div>
    </div>
  </div></Teleport>
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
.modal-card { width: min(520px, 100%); max-height: calc(100dvh - 32px); display: flex; flex-direction: column; min-height: 0; outline: none; }
.modal-card > .card-head { flex-shrink: 0; flex-wrap: wrap; }
.modal-card > .card-body { overflow-y: auto; min-height: 0; }
.modal-card h2 { overflow-wrap: anywhere; }
</style>
