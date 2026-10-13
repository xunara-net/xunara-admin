<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { admin } from "../store";
import { logout } from "../api/platform-auth";

const nav = [
  { to: "/dashboard", label: "平台总览", icon: "📊" },
  { to: "/tenants", label: "租户与网络", icon: "🏢" },
  { to: "/authentication", label: "登录与注册", icon: "🔐" },
  { to: "/plans", label: "套餐管理", icon: "💎" },
  { to: "/users", label: "用户管理", icon: "👥" },
  { to: "/relays", label: "中继管理", icon: "📡" },
  { to: "/audit", label: "平台审计", icon: "📜" },
  { to: "/system", label: "系统信息", icon: "⚙️" },
  { to: "/security", label: "管理员安全", icon: "🛡️" },
];

const route = useRoute();
const router = useRouter();
const menuOpen = ref(false);

const titles: Record<string, string> = {
  dashboard: "平台总览",
  tenants: "租户与网络",
  authentication: "登录与注册",
  plans: "套餐管理",
  users: "用户管理",
  relays: "中继管理",
  audit: "平台审计",
  system: "系统信息",
  "administrator-security": "管理员安全",
  "not-found": "页面不存在",
};
const title = computed(() => (route.meta.title as string) ?? titles[String(route.name)] ?? "平台后台");

async function signOut() {
  try { await logout(); }
  catch { admin.toast("info", "本地已退出；未确认服务端撤销，请勿在不可信设备保留凭据"); }
  admin.signOut();
  router.push({ name: "login" });
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar" style="--primary: #7c3aed; --primary-soft: #f1e9ff; --primary-strong: #6d28d9">
      <div class="sidebar-brand">
        <span class="brand-mark" style="background: linear-gradient(135deg, #7c3aed, #ec4899)">序</span>
        <span>玄序平台后台</span>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-group">
          <div class="nav-group-title">运营</div>
          <router-link v-for="item in nav" :key="item.to" :to="item.to" class="nav-item">
            <span class="nav-icon">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </router-link>
        </div>
      </nav>
      <div style="padding: 14px 18px; border-top: 1px solid var(--border); color: var(--text-faint); font-size: 12px">
        独立平台身份 · 退出后台撤销会话
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="crumbs"><span>平台后台</span><span>/</span><strong>{{ title }}</strong></div>
        <div style="position: relative">
          <button class="btn ghost" @click="menuOpen = !menuOpen">
            <span class="brand-mark" style="width: 22px; height: 22px; font-size: 12px; border-radius: 6px; background: linear-gradient(135deg, #7c3aed, #ec4899)">管</span>
            <span>平台管理员</span>
          </button>
          <div v-if="menuOpen" class="menu" @mouseleave="menuOpen = false">
            <button @click="menuOpen = false; router.push({ name: 'administrator-security' })">管理员安全</button>
            <button style="color: var(--danger)" @click="signOut">退出后台</button>
          </div>
        </div>
      </header>
      <main class="content"><router-view /></main>
    </div>
  </div>
</template>
