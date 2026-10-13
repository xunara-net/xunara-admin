<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import * as auth from "../api/platform-auth";
import { availability, failureMessage, register } from "../utils/passkey";
import { admin } from "../store";
import { ApiError } from "../api/client";
import { formatTime } from "../utils/format";
import PageHeader from "../components/PageHeader.vue";
import ModalDialog from "../components/ModalDialog.vue";

const router = useRouter();
const data = ref<auth.AdministratorPasskeys | null>(null);
const loading = ref(true), busy = ref(false), error = ref("");
const addOpen = ref(false), name = ref(""), formError = ref("");
const verifying = ref(false), needsReview = ref(false);
const reason = ref("");
let controller: AbortController | null = null;
let disposed = false;
onMounted(() => { reason.value = availability(); load(); });
onUnmounted(() => { disposed = true; controller?.abort(); name.value = ""; });
async function load() {
  loading.value = true; error.value = "";
  try { const result = await auth.listPasskeys(); if (!disposed) data.value = result; }
  catch (failure) { if (!disposed) error.value = failureMessage(failure); }
  finally { loading.value = false; }
}
function closeAdd() {
  if (busy.value) return;
  addOpen.value = false; name.value = ""; formError.value = ""; needsReview.value = false;
}
async function add() {
  if (busy.value || needsReview.value || reason.value || !name.value.trim()) return;
  busy.value = true; formError.value = ""; controller = new AbortController();
  let finishAttempted = false;
  try {
    const challenge = await auth.beginRegistration();
    if (disposed) return;
    verifying.value = true;
    const credential = await register(challenge.options.publicKey, controller.signal);
    verifying.value = false;
    finishAttempted = true;
    await auth.finishRegistration(name.value.trim(), credential);
    if (disposed) return;
    addOpen.value = false; name.value = "";
    admin.toast("success", "管理员通行密钥已绑定");
    await load();
  } catch (failure) {
    if (!disposed) {
      formError.value = failureMessage(failure);
      needsReview.value = finishAttempted && !(failure instanceof ApiError && [400, 401, 403].includes(failure.status));
    }
  }
  finally { busy.value = false; verifying.value = false; controller = null; }
}
async function reviewRegistration() { closeAdd(); await load(); }
async function remove(key: auth.AdministratorPasskey) {
  if (busy.value || loading.value || error.value || !data.value) return;
  if (!data.value.recovery_available && data.value.passkeys.length <= 1) return;
  if (!window.confirm(`解绑「${key.name}」？所有通过管理员通行密钥建立的后台会话都会退出；租户账号、设备和中继不受影响。`)) return;
  busy.value = true; error.value = "";
  try {
    const result = await auth.unbindPasskey(key.id);
    if (disposed) return;
    if (result.signed_out) {
      admin.signOut(); await router.replace({ name: "login" }); return;
    }
    admin.toast("success", "已解绑并撤销管理员 Passkey 会话");
    await load();
  } catch (failure) { if (!disposed) error.value = failureMessage(failure); }
  finally { busy.value = false; }
}
</script>

<template>
  <PageHeader title="管理员安全" desc="仅管理平台管理员的通行密钥，与租户账号完全隔离。">
    <template #actions><button class="btn" :disabled="busy || loading" @click="load">刷新</button><button class="btn primary" :disabled="busy || loading || !!error || !!reason" @click="addOpen = true">绑定通行密钥</button></template>
  </PageHeader>
  <div v-if="error" class="alert error" role="alert">{{ error }} <RouterLink to="/login">重新登录</RouterLink></div>
  <div v-if="reason" class="alert info">{{ reason }}</div>
  <div class="card">
    <div class="card-head"><h2>通行密钥 <span v-if="data">（{{ data.passkeys.length }}）</span></h2></div>
    <div class="card-body security-info">
      <p>支持多把密钥，可分别绑定手机、电脑或硬件安全密钥。首次绑定使用平台恢复令牌登录即可；之后可以直接使用通行密钥登录。</p>
      <p v-if="data">当前会话：{{ data.auth_method === 'passkey' ? '通行密钥' : '平台恢复令牌' }} · {{ formatTime(data.expires_at) }} 到期。修改凭据需要最近 15 分钟内登录。</p>
      <div v-if="data && !data.recovery_available" class="alert info">未配置平台恢复令牌，不能解绑最后一把通行密钥。</div>
      <p v-if="loading">加载中…</p>
      <p v-else-if="data && !data.passkeys.length" class="muted">尚未绑定通行密钥。</p>
      <div v-for="key in data?.passkeys ?? []" :key="key.id" class="key-row">
        <div><strong>{{ key.name }}</strong><div class="key-meta">绑定于 {{ formatTime(key.created_at) }}<br />最近使用：{{ key.last_used_at ? formatTime(key.last_used_at) : '尚未使用' }}</div></div>
        <button class="btn danger small" :disabled="busy || !!error || (!data?.recovery_available && (data?.passkeys.length ?? 0) <= 1)" @click="remove(key)">解绑</button>
      </div>
      <p class="help">解绑会撤销所有管理员 Passkey 会话；可使用其他已绑定密钥或平台恢复令牌重新登录。仅删除这里的绑定，不会删除设备上保存的密钥。</p>
    </div>
  </div>
  <ModalDialog :open="addOpen" title="绑定管理员通行密钥" @close="closeAdd">
    <form id="administrator-passkey-form" class="security-form" @submit.prevent="add">
      <label for="administrator-passkey-name">名称</label><input id="administrator-passkey-name" v-model="name" class="input" maxlength="64" required :disabled="busy" placeholder="例如：手机 / 办公电脑 / 安全密钥" />
      <p class="help">接下来由浏览器或系统完成指纹、人脸、PIN 或安全密钥验证。名称只是标签，不是身份信息。</p>
      <div v-if="formError" class="alert error" role="alert">{{ formError }}</div>
      <p v-if="needsReview" class="alert info">绑定结果未知，请先关闭弹窗并刷新列表核对，不能直接重复提交。</p>
      <button v-if="verifying" type="button" class="btn" @click="controller?.abort()">取消设备验证</button>
    </form>
    <template #footer><button class="btn" :disabled="busy" @click="needsReview ? reviewRegistration() : closeAdd()">{{ needsReview ? '关闭并刷新核对' : '取消' }}</button><button class="btn primary" form="administrator-passkey-form" type="submit" :disabled="busy || needsReview || !name.trim()">{{ busy ? '验证中…' : '开始绑定' }}</button></template>
  </ModalDialog>
</template>

<style scoped>
.security-info p { line-height: 1.7; }
.key-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 0; border-top: 1px solid var(--border); }
.key-row strong { overflow-wrap: anywhere; }
.key-meta { color: var(--text-faint); font-size: 12px; margin-top: 5px; }
.security-form { display: grid; gap: 12px; }
</style>
