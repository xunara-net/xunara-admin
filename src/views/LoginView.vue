<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listOrganizations } from "../api/endpoints";
import { errorMessage } from "../api/client";
import { admin } from "../store";
import * as auth from "../api/platform-auth";
import { authenticate, availability, failureMessage } from "../utils/passkey";

const route = useRoute();
const router = useRouter();

const token = ref("");
const busy = ref(false);
const error = ref("");
const settings = ref<auth.PlatformAuthStatus | null>(null);
const ready = ref(false);
const currentOrigin = window.location.origin;
const passkeyReason = ref("");
let controller: AbortController | null = null;
let disposed = false;
onMounted(async () => {
  passkeyReason.value = availability();
  try { settings.value = await auth.authStatus(); }
  catch (failure) { error.value = errorMessage(failure); }
  finally { ready.value = true; }
});
onUnmounted(() => { disposed = true; controller?.abort(); token.value = ""; });

function destination(): string {
  const value = route.query.return_to;
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/[\u0000-\u001f]/.test(value) ? value : "/dashboard";
}

async function submit() {
  if (busy.value || !ready.value || !settings.value) return;
  error.value = "";
  busy.value = true;
  try {
    const sessionToken = settings.value.enabled ? await auth.tokenLogin(token.value) : token.value;
    if (disposed) return;
    admin.signIn(sessionToken);
    token.value = "";
    // Probe the platform API before letting the operator in, so a typo is
    // answered here instead of by an empty dashboard.
    await listOrganizations();
    router.push(destination());
  } catch (err) {
    admin.signOut();
    error.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

async function signInWithPasskey() {
  if (busy.value || !settings.value?.enabled || passkeyReason.value) return;
  busy.value = true; error.value = "";
  controller = new AbortController();
  try {
    const challenge = await auth.beginLogin();
    if (disposed) return;
    const credential = await authenticate(challenge.options.publicKey, controller.signal);
    const sessionToken = await auth.finishLogin(credential);
    if (disposed) return;
    admin.signIn(sessionToken);
    await listOrganizations();
    if (!disposed) router.push(destination());
  } catch (failure) { if (!disposed) { admin.signOut(); error.value = failureMessage(failure); } }
  finally { controller = null; busy.value = false; }
}
</script>

<template>
  <div class="auth-wrap">
    <div class="card auth-card">
      <div style="display: flex; align-items: center; gap: 10px">
        <span class="brand-mark" style="background: linear-gradient(135deg, #7c3aed, #ec4899)">序</span>
        <div>
          <div class="auth-title">玄序平台后台</div>
          <div class="auth-sub">部署运营者的控制台 · 租户账号无法在此登录</div>
        </div>
      </div>

      <div v-if="error" class="alert error" style="margin-top: 18px">{{ error }}</div>

      <div v-if="settings?.enabled" class="passkey-login">
        <button class="btn primary" :disabled="busy || !!passkeyReason || settings.origin !== currentOrigin" @click="signInWithPasskey">{{ busy ? '验证中…' : '使用通行密钥登录' }}</button>
        <div class="help">首次使用请先用平台令牌登录，在“管理员安全”中绑定；可绑定手机、电脑及安全密钥。</div>
        <div v-if="passkeyReason" class="help">{{ passkeyReason }}</div>
        <div v-if="settings.origin !== currentOrigin" class="alert info">请使用管理员入口：<a :href="`${settings.origin}/admin/login`">{{ settings.origin }}/admin/login</a></div>
      </div>

      <form style="margin-top: 20px" @submit.prevent="submit">
        <div class="field">
          <label for="token">平台管理令牌</label>
          <input id="token" v-model="token" class="input mono" type="password" autocomplete="off" placeholder="XUNARA_PLATFORM_ADMIN_TOKEN" />
          <div class="help">{{ settings?.enabled ? '用于首次登录或恢复。验证后换取 4 小时会话，永久令牌不保存。' : '此部署未开启管理员通行密钥，令牌仅保存在本标签页。' }}</div>
        </div>
        <button class="btn primary" style="width: 100%; height: 36px; background: #7c3aed; border-color: #7c3aed" :disabled="busy || !token || !ready || !settings?.token_login_enabled">
          {{ busy ? "验证中…" : "进入后台" }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.passkey-login { display: grid; gap: 10px; margin-top: 22px; }
.passkey-login a { overflow-wrap: anywhere; }
</style>
