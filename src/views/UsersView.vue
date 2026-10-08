<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as ep from "../api/endpoints";
import { errorMessage } from "../api/client";
import type { PlatformUser } from "../api/types";
import { admin } from "../store";
import PageHeader from "../components/PageHeader.vue";
import DataTable from "../components/DataTable.vue";
import { formatTime, relativeTime, roleLabel } from "../utils/format";

const loading = ref(true);
const error = ref("");
const users = ref<PlatformUser[]>([]);
const search = ref("");

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return users.value;
  return users.value.filter((u) =>
    [u.login, u.displayName, u.email, u.org, u.orgName].some((v) => (v ?? "").toLowerCase().includes(term)),
  );
});

const byOrg = computed(() => {
  const counts: Record<string, number> = {};
  for (const user of users.value) counts[user.org] = (counts[user.org] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
});

onMounted(load);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    users.value = await ep.listUsers();
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

async function forceLogout(user: PlatformUser) {
  if (!window.confirm(`强制「${user.displayName || user.login}」退出所有设备？`)) return;
  try {
    const answer = await ep.revokeUserSessions(user.org, user.id);
    admin.toast("success", `已撤销 ${answer.revoked} 个会话`);
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  }
}

async function remove(user: PlatformUser) {
  if (!window.confirm(`删除用户「${user.displayName || user.login}」？账号与设备绑定将被移除。`)) return;
  try {
    await ep.deleteUser(user.org, user.id);
    admin.toast("success", "用户已删除");
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  }
}
</script>

<template>
  <PageHeader title="用户管理" desc="全平台账号，按租户分组。">
    <template #actions>
      <input v-model="search" class="input" style="width: 220px" placeholder="搜索用户 / 租户" />
      <button class="btn" @click="load">刷新</button>
    </template>
  </PageHeader>

  <div v-if="error" class="alert error" style="margin-bottom: 16px">{{ error }}</div>

  <div class="grid cols-4">
    <div class="card stat">
      <div class="label">用户总数</div>
      <div class="value">{{ users.length }}</div>
      <div class="sub">覆盖 {{ byOrg.length }} 个租户</div>
    </div>
    <div class="card stat">
      <div class="label">活跃会话</div>
      <div class="value">{{ users.reduce((sum, u) => sum + u.sessions, 0) }}</div>
      <div class="sub">未过期且未撤销</div>
    </div>
    <div class="card stat">
      <div class="label">管理员</div>
      <div class="value">{{ users.filter((u) => u.role === "owner" || u.role === "admin").length }}</div>
      <div class="sub">所有者与管理员</div>
    </div>
    <div class="card stat">
      <div class="label">最近活跃</div>
      <div class="value" style="font-size: 18px">
        {{ relativeTime(users.map((u) => u.lastSeen).filter(Boolean).sort().pop() as string | undefined) }}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>用户（{{ filtered.length }}）</h2></div>
    <DataTable :columns="[
      { key: 'login', title: '用户' },
      { key: 'org', title: '租户' },
      { key: 'role', title: '角色' },
      { key: 'plan', title: '套餐' },
      { key: 'sessions', title: '会话' },
      { key: 'lastSeen', title: '最后活跃' },
      { key: 'actions', title: '操作', align: 'right' },
    ]" :rows="filtered" :loading="loading" empty-title="没有匹配的用户">
      <template #cell-login="{ row }">
        <div>{{ row.displayName || row.login }}</div>
        <div class="mono" style="color: var(--text-faint); font-size: 12px">{{ row.login }}<template v-if="row.email"> · {{ row.email }}</template></div>
      </template>
      <template #cell-org="{ row }">{{ row.orgName || row.org }}</template>
      <template #cell-role="{ row }"><span class="badge" :class="row.role === 'owner' ? 'primary' : ''">{{ roleLabel(row.role) }}</span></template>
      <template #cell-plan="{ row }"><span class="mono">{{ row.plan || "—" }}</span></template>
      <template #cell-sessions="{ row }">{{ row.sessions }}</template>
      <template #cell-lastSeen="{ row }">{{ row.lastSeen ? relativeTime(row.lastSeen) : "从未" }}</template>
      <template #cell-actions="{ row }">
        <div class="row-actions">
          <button class="btn small" @click="forceLogout(row)">强制下线</button>
          <button class="btn small danger" @click="remove(row)">删除</button>
        </div>
      </template>
    </DataTable>
  </div>
</template>
