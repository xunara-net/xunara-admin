<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as ep from "../api/endpoints";
import { ApiError, errorMessage } from "../api/client";
import { setUserStatus } from "../api/user-status";
import type { PlatformUser } from "../api/types";
import { admin } from "../store";
import PageHeader from "../components/PageHeader.vue";
import DataTable from "../components/DataTable.vue";
import ModalDialog from "../components/ModalDialog.vue";
import { formatTime, relativeTime, roleLabel } from "../utils/format";

const loading = ref(true);
const error = ref("");
const users = ref<PlatformUser[]>([]);
const search = ref("");
const statusFilter = ref("all");
const busy = ref(false);
const selected = ref<PlatformUser | null>(null);
const desiredDisabled = ref(false);
const reason = ref("");
const statusError = ref("");
const needsRefresh = ref(false);

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  return users.value.filter((u) =>
    (statusFilter.value === "all" || (statusFilter.value === "disabled" ? u.disabled === true : u.disabled === false)) &&
    (!term || [u.login, u.displayName, u.email, u.org, u.orgName].some((v) => (v ?? "").toLowerCase().includes(term))),
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
  if (busy.value || loading.value || error.value) return;
  if (!window.confirm(`撤销「${user.displayName || user.login}」的所有浏览器登录？组网设备不会断连。`)) return;
  busy.value = true;
  try {
    const answer = await ep.revokeUserSessions(user.org, user.id);
    admin.toast("success", `已撤销 ${answer.revoked} 个会话`);
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  } finally {
    busy.value = false;
  }
}

async function remove(user: PlatformUser) {
  if (busy.value || loading.value || error.value) return;
  if (!window.confirm(`删除用户「${user.displayName || user.login}」？账号和登录绑定将被移除，此操作不可恢复。`)) return;
  busy.value = true;
  try {
    await ep.deleteUser(user.org, user.id);
    admin.toast("success", "用户已删除");
    await load();
  } catch (err) {
    admin.toast("error", errorMessage(err));
  } finally {
    busy.value = false;
  }
}

function cannotChangeStatus(user: PlatformUser): boolean {
  if (typeof user.disabled !== "boolean" || !user.updatedAt) return true;
  return !user.disabled && user.role === "owner" && users.value.filter((other) => other.org === user.org && other.role === "owner" && other.disabled === false).length <= 1;
}

function openStatus(user: PlatformUser) {
  if (busy.value || loading.value || error.value || cannotChangeStatus(user)) return;
  selected.value = { ...user };
  desiredDisabled.value = !user.disabled;
  reason.value = "";
  statusError.value = "";
  needsRefresh.value = false;
}

function closeStatus() {
  if (busy.value) return;
  selected.value = null;
  reason.value = "";
  statusError.value = "";
}

async function refreshStatus() {
  if (busy.value || !selected.value) return;
  await load();
  if (error.value) return;
  const latest = users.value.find((user) => user.org === selected.value?.org && user.id === selected.value?.id);
  if (!latest) { statusError.value = "账号已不在列表中，请关闭弹窗核对"; return; }
  // 保留原操作意图和原因，不根据刷新后的状态自动反转禁用 / 解禁目标。
  selected.value = { ...latest };
  needsRefresh.value = false;
  statusError.value = latest.disabled === desiredDisabled.value ? "账号已处于目标状态，无需重复提交" : "已刷新实际状态，请核对后再次确认操作";
}

async function saveStatus() {
  if (!selected.value || busy.value || loading.value || error.value || needsRefresh.value || selected.value.disabled === desiredDisabled.value) return;
  busy.value = true;
  statusError.value = "";
  try {
    const answer = await setUserStatus(selected.value, desiredDisabled.value, reason.value);
    admin.toast("success", desiredDisabled.value ? `账号已禁用，撤销 ${answer.revoked} 个会话` : "账号已解禁，需要重新登录");
    selected.value = null;
    reason.value = "";
    await load();
  } catch (err) {
    statusError.value = errorMessage(err);
    needsRefresh.value = !(err instanceof ApiError && err.status === 400);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PageHeader title="用户管理" desc="全平台账号，按租户分组。">
    <template #actions>
      <input v-model="search" class="input user-search" placeholder="搜索用户 / 租户" />
      <select v-model="statusFilter" class="input" aria-label="账号状态筛选"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已禁用</option></select>
      <button class="btn" :disabled="busy || loading" @click="load">刷新</button>
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
      <div class="label">已禁用</div>
      <div class="value">{{ users.filter((user) => user.disabled === true).length }}</div>
      <div class="sub">保留账号，禁止登录</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>用户（{{ filtered.length }}）</h2></div>
    <DataTable :columns="[
      { key: 'login', title: '用户' },
      { key: 'org', title: '租户' },
      { key: 'role', title: '角色' },
      { key: 'status', title: '状态' },
      { key: 'plan', title: '套餐' },
      { key: 'sessions', title: '会话' },
      { key: 'lastSeen', title: '最后活跃' },
      { key: 'actions', title: '操作', align: 'right' },
    ]" :rows="filtered" :row-key="(row) => `${row.org}:${row.id}`" :loading="loading" empty-title="没有匹配的用户">
      <template #cell-login="{ row }">
        <div>{{ row.displayName || row.login }}</div>
        <div class="mono" style="color: var(--text-faint); font-size: 12px">{{ row.login }}<template v-if="row.email"> · {{ row.email }}</template></div>
      </template>
      <template #cell-org="{ row }">{{ row.orgName || row.org }}</template>
      <template #cell-role="{ row }"><span class="badge" :class="row.role === 'owner' ? 'primary' : ''">{{ roleLabel(row.role) }}</span></template>
      <template #cell-status="{ row }">
        <span class="badge" :class="row.disabled === true ? 'danger' : row.disabled === false ? 'success' : ''">{{ row.disabled === true ? '已禁用' : row.disabled === false ? '已启用' : '未知' }}</span>
        <div v-if="row.disabled" class="status-detail">{{ formatTime(row.disabledAt) }}<br />{{ row.disabledReason }}</div>
      </template>
      <template #cell-plan="{ row }"><span class="mono">{{ row.plan || "—" }}</span></template>
      <template #cell-sessions="{ row }">{{ row.sessions }}</template>
      <template #cell-lastSeen="{ row }">{{ row.lastSeen ? relativeTime(row.lastSeen) : "从未" }}</template>
      <template #cell-actions="{ row }">
        <div class="row-actions">
          <button class="btn small" :disabled="busy || loading || !!error || cannotChangeStatus(row)" :title="cannotChangeStatus(row) ? '最后一位启用的所有者或缺少状态版本，不能禁用' : ''" @click="openStatus(row)">{{ row.disabled ? '解禁' : '禁用' }}</button>
          <button class="btn small" :disabled="busy || loading || !!error" @click="forceLogout(row)">强制下线</button>
          <button class="btn small danger" :disabled="busy || loading || !!error" @click="remove(row)">删除</button>
        </div>
      </template>
    </DataTable>
  </div>

  <ModalDialog :open="!!selected" :title="desiredDisabled ? '确认禁用账号' : '确认解禁账号'" @close="closeStatus">
    <div v-if="selected" class="status-form">
      <div><strong>{{ selected.displayName || selected.login }}</strong><div class="status-detail">{{ selected.orgName || selected.org }} · {{ selected.login }}</div></div>
      <p>{{ desiredDisabled ? '禁用会阻止密码、第三方和通行密钥登录，撤销所有浏览器会话，并暂停该账号委托的 API 权限。' : '解禁后可重新登录。已撤销会话不会恢复；未撤销的 API Key 可重新使用。' }}</p>
      <div class="alert">账号禁用不是网络冻结：已连接设备、预授权设备 Key 和独立中继不会被停用；禁用账号仍占成员额度。</div>
      <div class="status-detail">当前状态：{{ selected.disabled ? '已禁用' : '已启用' }}<template v-if="selected.disabledReason"> · {{ selected.disabledReason }}</template></div>
      <label for="account-status-reason">操作原因（必填）</label>
      <input id="account-status-reason" v-model="reason" class="input" maxlength="256" :disabled="busy" placeholder="仅填管理原因，不要输入密码或令牌" />
      <div v-if="statusError" class="alert error" role="alert">{{ statusError }}</div>
    </div>
    <template #footer>
      <button class="btn" :disabled="busy || loading" @click="closeStatus">取消</button>
      <button v-if="needsRefresh" class="btn" :disabled="busy || loading" @click="refreshStatus">刷新核对账号</button>
      <button class="btn primary" :disabled="busy || loading || !!error || needsRefresh || !reason.trim() || selected?.disabled === desiredDisabled" @click="saveStatus">{{ busy ? '提交中…' : desiredDisabled ? '确认禁用' : '确认解禁' }}</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.user-search { width: min(220px, 100%); }
.status-detail { color: var(--text-faint); font-size: 12px; overflow-wrap: anywhere; max-width: 260px; }
.status-form { display: grid; gap: 12px; overflow-wrap: anywhere; }
.status-form p { margin: 0; }
</style>
