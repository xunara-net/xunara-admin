<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as ep from "../api/endpoints";
import { errorMessage } from "../api/client";
import type { Organization, Plan } from "../api/types";
import { admin } from "../store";
import PageHeader from "../components/PageHeader.vue";
import DataTable from "../components/DataTable.vue";
import ModalDialog from "../components/ModalDialog.vue";
import { quotaText } from "../utils/format";

const loading = ref(true);
const error = ref("");
const orgs = ref<Organization[]>([]);
const plans = ref<Plan[]>([]);
const busy = ref(false);

const planDialog = ref<{ open: boolean; org: Organization | null; planID: string }>({
  open: false,
  org: null,
  planID: "",
});

const networkDialog = ref<{ open: boolean; org: Organization | null; prefix: string }>({
  open: false,
  org: null,
  prefix: "",
});

const planNames = computed(() => Object.fromEntries(plans.value.map((p) => [p.id, p.name])));

onMounted(load);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [o, p] = await Promise.all([ep.listOrganizations(), ep.listPlans().catch(() => ({ plans: [], default: "" }))]);
    orgs.value = o;
    plans.value = p.plans;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

function openPlanDialog(org: Organization) {
  planDialog.value = { open: true, org, planID: org.stats.plan ?? plans.value[0]?.id ?? "" };
}

async function savePlan() {
  const org = planDialog.value.org;
  if (!org) return;
  busy.value = true;
  try {
    await ep.setTenantPlan(org.id, planDialog.value.planID);
    admin.toast("success", `租户 ${org.id} 已切换到套餐 ${planNames.value[planDialog.value.planID] ?? planDialog.value.planID}`);
    planDialog.value.open = false;
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  } finally {
    busy.value = false;
  }
}

function openNetworkDialog(org: Organization) {
  networkDialog.value = { open: true, org, prefix: org.stats.networkPrefix ?? "" };
}

async function saveNetwork(custom = false) {
  const org = networkDialog.value.org;
  if (!org) return;
  busy.value = true;
  try {
    const answer = custom ? await ep.setTenantNetwork(org.id, networkDialog.value.prefix.trim()) : await ep.allocateTenantNetwork(org.id);
    admin.toast("success", `已为 ${org.id} 分配网段 ${answer.network_prefix ?? ""}`);
    networkDialog.value.open = false;
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  } finally {
    busy.value = false;
  }
}

async function removeOrg(org: Organization) {
  if (!window.confirm(`删除托管租户「${org.name}」？该租户的配置将被移除，操作不可撤销。`)) return;
  try {
    await ep.deleteOrganization(org.id);
    admin.toast("success", "租户已删除");
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  }
}
</script>

<template>
  <PageHeader title="租户与网络" desc="每个租户是一个独立网络空间：套餐、网段与设备额度。">
    <template #actions><button class="btn" @click="load">刷新</button></template>
  </PageHeader>

  <div v-if="error" class="alert error" style="margin-bottom: 16px">{{ error }}</div>

  <div class="card">
    <div class="card-head">
      <h2>租户（{{ orgs.length }}）</h2>
      <span class="hint">托管租户可在线修改套餐与网段；配置文件声明的租户为只读</span>
    </div>
    <DataTable :columns="[
      { key: 'name', title: '租户' },
      { key: 'plan', title: '套餐' },
      { key: 'networkPrefix', title: '网段' },
      { key: 'devices', title: '设备' },
      { key: 'users', title: '用户' },
      { key: 'actions', title: '操作', align: 'right' },
    ]" :rows="orgs" :loading="loading" row-key="id" empty-title="还没有租户">
      <template #cell-name="{ row }">
        <div>{{ row.name }}</div>
        <div class="mono" style="color: var(--text-faint); font-size: 12px">{{ row.id }}<template v-if="row.domains?.length"> · {{ row.domains.join(", ") }}</template></div>
      </template>
      <template #cell-plan="{ row }">
        <span class="badge primary">{{ row.stats.planName || planNames[row.stats.plan] || "—" }}</span>
      </template>
      <template #cell-networkPrefix="{ row }"><span class="mono">{{ row.stats.networkPrefix || "未分配" }}</span></template>
      <template #cell-devices="{ row }">{{ row.stats.nodes }} / {{ quotaText(row.stats.deviceLimit) }}<span v-if="row.stats.online" style="color: var(--text-faint)">（在线 {{ row.stats.online }}）</span></template>
      <template #cell-users="{ row }">{{ row.stats.users }}</template>
      <template #cell-actions="{ row }">
        <div class="row-actions">
          <button class="btn small" @click="openPlanDialog(row)">套餐</button>
          <button class="btn small" @click="openNetworkDialog(row)">网段</button>
          <button v-if="row.managed" class="btn small danger" @click="removeOrg(row)">删除</button>
        </div>
      </template>
    </DataTable>
  </div>

  <ModalDialog title="修改租户套餐" :open="planDialog.open" @close="planDialog.open = false">
    <div class="field">
      <label>租户</label>
      <div class="mono">{{ planDialog.org?.id }}</div>
    </div>
    <div class="field">
      <label>套餐</label>
      <select v-model="planDialog.planID" class="select">
        <option v-for="plan in plans" :key="plan.id" :value="plan.id">{{ plan.name }}（设备 {{ quotaText(plan.max_devices) }}）</option>
      </select>
    </div>
    <template #footer>
      <button class="btn" @click="planDialog.open = false">取消</button>
      <button class="btn primary" :disabled="busy" @click="savePlan">保存</button>
    </template>
  </ModalDialog>

  <ModalDialog title="租户网段" :open="networkDialog.open" :busy="busy" @close="networkDialog.open = false">
    <div class="field">
      <label>当前网段</label>
      <div class="mono">{{ networkDialog.org?.stats.networkPrefix || "未分配" }}</div>
    </div>
    <div class="alert info">
      自动分配只为尚未分配的租户选择地址池网段，不覆盖已有网段。自定义合法 IPv4 不限于 CGNAT 或 /16～/28；保留系统地址、租户冲突、历史预留及套餐权限检查，已有设备 IP 不自动改写。
    </div>
    <div class="alert warning">非标准网段允许保存，但不能保证官方客户端全部功能兼容；请先实测并避免 LAN / 公网路由冲突。/31 和 /32 只有 2 个和 1 个地址，耗尽后不能注册新设备。</div>
    <label class="field"><span>自定义 IPv4 CIDR</span><input v-model="networkDialog.prefix" class="input mono" aria-label="租户自定义 IPv4 网段" placeholder="192.168.50.0/24" :disabled="busy" /></label>
    <template #footer>
      <button class="btn" :disabled="busy" @click="networkDialog.open = false">取消</button>
      <button class="btn" :disabled="busy" @click="saveNetwork(false)">自动分配（保留已有网段）</button>
      <button class="btn primary" :disabled="busy || !networkDialog.prefix.trim()" @click="saveNetwork(true)">保存自定义网段</button>
    </template>
  </ModalDialog>
</template>
