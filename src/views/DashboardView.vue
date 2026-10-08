<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as ep from "../api/endpoints";
import { errorMessage } from "../api/client";
import type { AuditEvent, Organization, Plan } from "../api/types";
import PageHeader from "../components/PageHeader.vue";
import StatCard from "../components/StatCard.vue";
import DataTable from "../components/DataTable.vue";
import { formatTime } from "../utils/format";

const loading = ref(true);
const error = ref("");
const orgs = ref<Organization[]>([]);
const plans = ref<Plan[]>([]);
const events = ref<AuditEvent[]>([]);

const totals = computed(() => {
  const t = { users: 0, nodes: 0, online: 0, pending: 0 };
  for (const org of orgs.value) {
    t.users += org.stats.users;
    t.nodes += org.stats.nodes;
    t.online += org.stats.online;
    t.pending += org.stats.pendingDevices;
  }
  return t;
});

const planCounts = computed(() => {
  const counts: Record<string, number> = {};
  for (const org of orgs.value) {
    const id = org.stats.plan ?? "未分配";
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
});

onMounted(async () => {
  try {
    const [o, p, a] = await Promise.all([
      ep.listOrganizations(),
      ep.listPlans().catch(() => ({ plans: [], default: "" })),
      ep.listAudit({ limit: 12 }).catch(() => []),
    ]);
    orgs.value = o;
    plans.value = p.plans;
    events.value = a;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PageHeader title="平台总览" desc="租户、用户、设备与套餐分布。">
    <template #actions><router-link class="btn" to="/tenants">管理租户</router-link></template>
  </PageHeader>

  <div v-if="error" class="alert error" style="margin-bottom: 16px">{{ error }}</div>

  <div class="grid cols-4">
    <StatCard label="租户" :value="orgs.length" sub="独立网络空间" />
    <StatCard label="用户" :value="totals.users" sub="全部租户合计" />
    <StatCard label="设备" :value="totals.nodes" :sub="`在线 ${totals.online} 台`" />
    <StatCard label="待审批设备" :value="totals.pending" :tone="totals.pending ? 'warning' : 'default'" />
  </div>

  <div class="grid cols-2">
    <div class="card">
      <div class="card-head"><h2>套餐分布</h2><router-link to="/plans" class="hint">套餐管理 →</router-link></div>
      <div class="card-body">
        <div v-if="plans.length === 0" class="empty" style="padding: 18px"><div class="title">未启用套餐</div></div>
        <div v-for="plan in plans" :key="plan.id" style="display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--border)">
          <span>{{ plan.name }}</span>
          <span style="color: var(--text-muted)">{{ planCounts[plan.id] ?? 0 }} 个租户</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>租户概览</h2><router-link to="/tenants" class="hint">全部租户 →</router-link></div>
      <DataTable :columns="[
        { key: 'name', title: '租户' },
        { key: 'plan', title: '套餐' },
        { key: 'nodes', title: '设备', align: 'right' },
      ]" :rows="orgs.slice(0, 8)" :loading="loading" row-key="id" empty-title="还没有租户">
        <template #cell-name="{ row }">
          <div>{{ row.name }}</div>
          <div class="mono" style="color: var(--text-faint); font-size: 12px">{{ row.id }}</div>
        </template>
        <template #cell-plan="{ row }"><span class="badge primary">{{ row.stats.planName || row.stats.plan || "—" }}</span></template>
        <template #cell-nodes="{ row }">{{ row.stats.nodes }}</template>
      </DataTable>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>最近平台事件</h2><router-link to="/audit" class="hint">平台审计 →</router-link></div>
    <DataTable :columns="[
      { key: 'at', title: '时间' },
      { key: 'org', title: '租户' },
      { key: 'action', title: '操作' },
      { key: 'actor', title: '操作者' },
      { key: 'detail', title: '说明' },
    ]" :rows="events" :loading="loading" empty-title="暂无事件">
      <template #cell-at="{ row }">{{ formatTime(row.at ?? row.time) }}</template>
      <template #cell-org="{ row }">{{ row.orgName || row.org || "—" }}</template>
      <template #cell-action="{ row }"><span class="mono">{{ row.action }}</span></template>
      <template #cell-detail="{ row }"><span style="color: var(--text-muted)">{{ row.detail || "—" }}</span></template>
    </DataTable>
  </div>
</template>
