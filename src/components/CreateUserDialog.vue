<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { listOrganizations } from "../api/endpoints";
import { createUser, type CreateUserInput } from "../api/create-user";
import type { Organization } from "../api/types";
import { ApiError, errorMessage } from "../api/client";
import ModalDialog from "./ModalDialog.vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; created: [] }>();
const organizations = ref<Organization[]>([]), organization = ref("");
const loading = ref(false), busy = ref(false), error = ref(""), unknownResult = ref(false);
const draft = ref<CreateUserInput>({ login: "", display_name: "", email: "", password: "", role: "member" });
const confirm = ref("");
let disposed = false;
let generation = 0;
function clear() { draft.value = { login: "", display_name: "", email: "", password: "", role: "member" }; confirm.value = ""; organization.value = ""; }
onUnmounted(() => { disposed = true; generation++; clear(); });
watch(() => props.open, async open => {
  const current = ++generation;
  clear(); error.value = ""; unknownResult.value = false;
  if (!open) return;
  loading.value = true;
  try { const result = await listOrganizations(); if (!disposed && current === generation) organizations.value = result; }
  catch (failure) { if (!disposed && current === generation) error.value = errorMessage(failure); }
  finally { if (current === generation) loading.value = false; }
});
function close() { if (!busy.value) { clear(); emit("close"); } }
async function submit() {
  if (busy.value || loading.value || unknownResult.value || !organization.value) return;
  if (draft.value.password !== confirm.value) { error.value = "两次密码不一致"; return; }
  busy.value = true; error.value = "";
  try {
    await createUser(organization.value, { ...draft.value, login: draft.value.login.trim().toLowerCase() });
    if (disposed) return;
    clear(); emit("created"); emit("close");
  } catch (failure) {
    if (disposed) return;
    error.value = errorMessage(failure);
    unknownResult.value = !(failure instanceof ApiError && [400, 403, 404, 409].includes(failure.status));
    if (unknownResult.value) { draft.value.password = ""; confirm.value = ""; }
  } finally { busy.value = false; }
}
</script>

<template>
  <ModalDialog :open="open" title="添加用户" @close="close">
    <form id="platform-create-user" class="create-form" @submit.prevent="submit">
      <p class="help">添加到明确选定的已有网络，不会创建新网络。租户成员角色不等于平台管理员权限。</p>
      <label>所属网络<select v-model="organization" class="input" aria-label="所属网络" required :disabled="busy || loading || unknownResult"><option value="" disabled>{{ loading ? '加载网络…' : '请选择网络' }}</option><option v-for="item in organizations" :key="item.id" :value="item.id">{{ item.name || item.id }} · {{ item.stats.users }} 位成员</option></select></label>
      <label>用户名<input v-model="draft.login" class="input" maxlength="128" pattern="[a-zA-Z0-9@._+\-]+" required autocomplete="off" :disabled="busy || unknownResult" placeholder="字母、数字及 @ . _ - +" /></label>
      <label>显示名称<input v-model="draft.display_name" class="input" maxlength="100" :disabled="busy || unknownResult" /></label>
      <label>联系邮箱（选填）<input v-model="draft.email" class="input" type="email" maxlength="254" :disabled="busy || unknownResult" /></label>
      <label>角色<select v-model="draft.role" class="input" aria-label="角色" :disabled="busy || unknownResult"><option value="member">成员</option><option value="admin">网络管理员</option><option value="owner">网络所有者</option></select></label>
      <label>初始密码<input v-model="draft.password" class="input" type="password" autocomplete="new-password" required maxlength="256" :disabled="busy || unknownResult" /></label>
      <label>确认密码<input v-model="confirm" class="input" type="password" autocomplete="new-password" required maxlength="256" :disabled="busy || unknownResult" /></label>
      <p class="help">按套餐成员额度校验。密码只在本次提交使用，请通过可靠渠道交付；联系邮箱不会被自动视为已验证。</p>
      <div v-if="error" class="alert error" role="alert">{{ error }}</div>
      <p v-if="unknownResult" class="alert info">提交结果未知，已清理本页密码。请关闭弹窗并刷新用户列表核对，不要直接重复创建。</p>
    </form>
    <template #footer><button class="btn" :disabled="busy" @click="close">{{ unknownResult ? '关闭并核对列表' : '取消' }}</button><button class="btn primary" form="platform-create-user" type="submit" :disabled="busy || loading || unknownResult || !organization">{{ busy ? '创建中…' : '创建用户' }}</button></template>
  </ModalDialog>
</template>

<style scoped>
.create-form { display: grid; gap: 13px; }
.create-form label { display: grid; gap: 6px; }
.create-form input, .create-form select { font-size: 16px; }
</style>
