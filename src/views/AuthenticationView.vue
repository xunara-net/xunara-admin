<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listOrganizations } from "../api/endpoints";
import { errorMessage } from "../api/client";
import { createAuthenticationAPI } from "../api/authentication-settings";
import type { Organization } from "../api/types";
import AuthenticationEditor from "../components/AuthenticationEditor.vue";
import PageHeader from "../components/PageHeader.vue";

const route = useRoute();
const router = useRouter();
const organizations = ref<Organization[]>([]);
const organizationID = ref("");
const error = ref("");
const loading = ref(true);
const api = computed(() => createAuthenticationAPI(`/api/platform/v1/organizations/${encodeURIComponent(organizationID.value)}/authentication`, false));
onMounted(load);
watch(organizationID, (value) => {
  if (value) void router.replace({ name: "authentication", query: { org: value } });
});
async function load() {
  loading.value = true; error.value = "";
  try {
    organizations.value = await listOrganizations();
    const selected = typeof route.query.org === "string" ? route.query.org : "";
    organizationID.value = organizations.value.some((organization) => organization.id === selected) ? selected : organizations.value[0]?.id ?? "";
  } catch (failure) { organizations.value = []; organizationID.value = ""; error.value = errorMessage(failure); }
  finally { loading.value = false; }
}
</script>

<template>
  <PageHeader title="登录与注册" desc="按租户管理成员注册与第三方登录；独立网络公开开户开关仅在开户入口租户显示。" />
  <p v-if="loading" role="status">正在读取租户…</p>
  <div v-else-if="error" class="alert error" role="alert">{{ error }}<button class="btn small" @click="load">重新读取</button></div>
  <div v-else-if="!organizations.length" class="alert info">目前没有可配置的租户。</div>
  <template v-else>
    <div class="card" style="margin-bottom: 18px"><div class="card-body field"><label for="authentication-tenant">选择租户</label><select id="authentication-tenant" v-model="organizationID" class="input" style="max-width: 100%"><option v-for="organization in organizations" :key="organization.id" :value="organization.id">{{ organization.name || organization.id }} · {{ organization.id }}</option></select></div></div>
    <AuthenticationEditor v-if="organizationID" :key="organizationID" :api="api" />
  </template>
</template>
