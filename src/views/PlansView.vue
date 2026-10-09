<script setup lang="ts">
import { onMounted, ref } from "vue";
import * as ep from "../api/endpoints";
import { errorMessage } from "../api/client";
import type { Plan } from "../api/types";
import { admin } from "../store";
import PageHeader from "../components/PageHeader.vue";
import DataTable from "../components/DataTable.vue";
import ModalDialog from "../components/ModalDialog.vue";
import { priceText, quotaText } from "../utils/format";

const loading = ref(true);
const error = ref("");
const plans = ref<Plan[]>([]);
const defaultPlan = ref("");
const busy = ref(false);

const dialog = ref<{ open: boolean; edit: boolean; plan: Plan }>({
  open: false,
  edit: false,
  plan: emptyPlan(),
});

function emptyPlan(): Plan {
  return {
    id: "",
    name: "",
    price_cents: 0,
    currency: "CNY",
    billing_cycle: "month",
    max_devices: 10,
    max_users: 1,
    max_routes: 4,
    max_auth_keys: 3,
    max_relays: 1,
    allow_custom_cidr: false,
    allow_exit_node: false,
    allow_subnet_router: false,
    allow_api: false,
    allow_acl: true,
    allow_grants: false,
    allow_custom_dns: false,
    allow_audit_log: false,
    allow_multi_member: false,
  };
}

onMounted(load);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const answer = await ep.listPlans();
    plans.value = answer.plans ?? [];
    defaultPlan.value = answer.default;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  dialog.value = { open: true, edit: false, plan: emptyPlan() };
}

function openEdit(plan: Plan) {
  dialog.value = { open: true, edit: true, plan: { ...plan } };
}

async function save() {
  busy.value = true;
  try {
    await ep.savePlan(dialog.value.plan);
    admin.toast("success", `套餐 ${dialog.value.plan.name} 已保存`);
    dialog.value.open = false;
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  } finally {
    busy.value = false;
  }
}

async function remove(plan: Plan) {
  if (!window.confirm(`删除套餐「${plan.name}」？在用租户不会被自动迁移。`)) return;
  try {
    await ep.deletePlan(plan.id);
    admin.toast("success", "套餐已删除");
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  }
}
</script>

<template>
  <PageHeader title="套餐管理" desc="套餐是数据：改动立即对所有租户生效，不需要改代码或重启。">
    <template #actions>
      <button class="btn" @click="load">刷新</button>
      <button class="btn primary" style="background: #7c3aed; border-color: #7c3aed" @click="openCreate">新建套餐</button>
    </template>
  </PageHeader>

  <div v-if="error" class="alert error" style="margin-bottom: 16px">{{ error }}</div>

  <div class="card">
    <div class="card-head"><h2>套餐目录（{{ plans.length }}）</h2><span class="hint">默认套餐：{{ defaultPlan || "—" }}</span></div>
    <DataTable :columns="[
      { key: 'name', title: '套餐' },
      { key: 'price', title: '价格' },
      { key: 'max_devices', title: '设备' },
      { key: 'max_users', title: '成员' },
      { key: 'max_relays', title: '中继' },
      { key: 'capabilities', title: '能力' },
      { key: 'actions', title: '操作', align: 'right' },
    ]" :rows="plans" :loading="loading" row-key="id" empty-title="还没有套餐">
      <template #cell-name="{ row }">
        <div>{{ row.name }} <span v-if="row.id === defaultPlan" class="badge success">默认</span></div>
        <div class="mono" style="color: var(--text-faint); font-size: 12px">{{ row.id }}</div>
      </template>
      <template #cell-price="{ row }">{{ priceText(row.price_cents, row.currency) }}<span v-if="row.billing_cycle" style="color: var(--text-faint)"> / {{ row.billing_cycle === "month" ? "月" : "年" }}</span></template>
      <template #cell-max_devices="{ row }">{{ quotaText(row.max_devices) }}</template>
      <template #cell-max_users="{ row }">{{ quotaText(row.max_users) }}</template>
      <template #cell-max_relays="{ row }">{{ quotaText(row.max_relays) }}</template>
      <template #cell-capabilities="{ row }">
        <span v-if="row.allow_custom_cidr" class="badge">自定义网段</span>
        <span v-if="row.allow_exit_node" class="badge" style="margin-left: 4px">出口节点</span>
        <span v-if="row.allow_subnet_router" class="badge" style="margin-left: 4px">子网路由</span>
        <span v-if="row.allow_api" class="badge" style="margin-left: 4px">API</span>
        <span v-if="row.allow_audit_log" class="badge" style="margin-left: 4px">审计</span>
      </template>
      <template #cell-actions="{ row }">
        <div class="row-actions">
          <button class="btn small" @click="openEdit(row)">编辑</button>
          <button class="btn small danger" :disabled="row.id === defaultPlan" @click="remove(row)">删除</button>
        </div>
      </template>
    </DataTable>
  </div>

  <ModalDialog :title="dialog.edit ? '编辑套餐' : '新建套餐'" :open="dialog.open" @close="dialog.open = false">
    <div class="grid cols-2">
      <div class="field">
        <label>套餐 ID</label>
        <input v-model="dialog.plan.id" class="input mono" :disabled="dialog.edit" placeholder="pro" />
      </div>
      <div class="field">
        <label>名称</label>
        <input v-model="dialog.plan.name" class="input" placeholder="Xunara Pro" />
      </div>
      <div class="field">
        <label>价格（分）</label>
        <input v-model.number="dialog.plan.price_cents" class="input" type="number" min="0" />
      </div>
      <div class="field">
        <label>计费周期</label>
        <select v-model="dialog.plan.billing_cycle" class="select">
          <option value="month">按月</option>
          <option value="year">按年</option>
          <option value="">不出售</option>
        </select>
      </div>
      <div class="field">
        <label>设备上限（-1 不限）</label>
        <input v-model.number="dialog.plan.max_devices" class="input" type="number" />
      </div>
      <div class="field">
        <label>成员上限</label>
        <input v-model.number="dialog.plan.max_users" class="input" type="number" />
      </div>
      <div class="field">
        <label>路由上限</label>
        <input v-model.number="dialog.plan.max_routes" class="input" type="number" />
      </div>
      <div class="field">
        <label>预授权密钥上限</label>
        <input v-model.number="dialog.plan.max_auth_keys" class="input" type="number" />
      </div>
      <div class="field">
        <label for="plan-relay-limit">托管中继上限（-1 不限）</label>
        <input id="plan-relay-limit" v-model.number="dialog.plan.max_relays" class="input" type="number" min="-1" step="1" />
      </div>
    </div>
    <div class="field">
      <label>能力开关</label>
      <label class="checkbox"><input v-model="dialog.plan.allow_custom_cidr" type="checkbox" /> 自定义网段</label>
      <label class="checkbox" style="margin-top: 6px"><input v-model="dialog.plan.allow_subnet_router" type="checkbox" /> 子网路由</label>
      <label class="checkbox" style="margin-top: 6px"><input v-model="dialog.plan.allow_exit_node" type="checkbox" /> 出口节点</label>
      <label class="checkbox" style="margin-top: 6px"><input v-model="dialog.plan.allow_api" type="checkbox" /> API 访问</label>
      <label class="checkbox" style="margin-top: 6px"><input v-model="dialog.plan.allow_acl" type="checkbox" /> ACL 策略</label>
      <label class="checkbox" style="margin-top: 6px"><input v-model="dialog.plan.allow_grants" type="checkbox" /> Grants 策略</label>
      <label class="checkbox" style="margin-top: 6px"><input v-model="dialog.plan.allow_custom_dns" type="checkbox" /> 自定义 DNS</label>
      <label class="checkbox" style="margin-top: 6px"><input v-model="dialog.plan.allow_audit_log" type="checkbox" /> 审计日志</label>
      <label class="checkbox" style="margin-top: 6px"><input v-model="dialog.plan.allow_multi_member" type="checkbox" /> 多成员协作</label>
    </div>
    <template #footer>
      <button class="btn" @click="dialog.open = false">取消</button>
      <button class="btn primary" style="background: #7c3aed; border-color: #7c3aed" :disabled="busy || !dialog.plan.id || !dialog.plan.name" @click="save">保存</button>
    </template>
  </ModalDialog>
</template>
