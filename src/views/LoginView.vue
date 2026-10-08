<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listOrganizations } from "../api/endpoints";
import { errorMessage } from "../api/client";
import { admin } from "../store";

const route = useRoute();
const router = useRouter();

const token = ref("");
const busy = ref(false);
const error = ref("");

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    admin.signIn(token.value);
    // Probe the platform API before letting the operator in, so a typo is
    // answered here instead of by an empty dashboard.
    await listOrganizations();
    const returnTo = typeof route.query.return_to === "string" ? route.query.return_to : "/dashboard";
    router.push(returnTo);
  } catch (err) {
    admin.signOut();
    error.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
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

      <form style="margin-top: 20px" @submit.prevent="submit">
        <div class="field">
          <label for="token">平台管理令牌</label>
          <input id="token" v-model="token" class="input mono" type="password" autocomplete="off" placeholder="XUNARA_PLATFORM_ADMIN_TOKEN" />
          <div class="help">令牌来自服务端环境变量，仅保存在本标签页会话中。</div>
        </div>
        <button class="btn primary" style="width: 100%; height: 36px; background: #7c3aed; border-color: #7c3aed" :disabled="busy || !token">
          {{ busy ? "验证中…" : "进入后台" }}
        </button>
      </form>
    </div>
  </div>
</template>
