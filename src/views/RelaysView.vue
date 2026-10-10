<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import * as ep from "../api/endpoints";
import { ApiError, errorMessage } from "../api/client";
import type { Organization, PlatformRelay, RelayDesiredState, RelayEnrollment, RelayVisibility, RelayConfigurationHistory } from "../api/types";
import { admin } from "../store";
import PageHeader from "../components/PageHeader.vue";
import DataTable from "../components/DataTable.vue";
import ModalDialog from "../components/ModalDialog.vue";
import { formatTime, relativeTime } from "../utils/format";
import { bandwidthText, bytesText, filterRelays, parseBandwidth, relayStatus, relayStatuses, relayDesiredStateText } from "../utils/relays";
import { relayExecutionSummary } from "../utils/relay-execution";

const loading = ref(true);
const executionNow = ref(Date.now());
const executionTimer = setInterval(() => { executionNow.value = Date.now(); }, 30_000);
onUnmounted(() => clearInterval(executionTimer));
const error = ref("");
const relays = ref<PlatformRelay[]>([]);
const organizations = ref<Organization[]>([]);
const organizationFilter = ref("");
const statusFilter = ref("");
const keyword = ref("");
const busy = ref(false);
const actionError = ref("");
const visibleRelays = computed(() => filterRelays(relays.value, organizationFilter.value, statusFilter.value, keyword.value));

const enrollmentOpen = ref(false);
const enrollmentForm = ref({ organizationID: "", name: "", visibility: "private" as RelayVisibility, hours: 24 });
const enrollment = ref<RelayEnrollment | null>(null);
const editing = ref<PlatformRelay | null>(null);
const configConflict = ref(false);
const latest = ref<PlatformRelay | null>(null);
const historyRelay = ref<PlatformRelay | null>(null);
const history = ref<RelayConfigurationHistory[]>([]);
const historyLoading = ref(false);
const historyError = ref("");
let active = true;
let historyRequest = 0;
const configForm = ref({ desiredState: "online" as RelayDesiredState, bandwidth: "0", regionName: "" });
const visibilityLabels = { private: "私有", organization: "组织内", public: "公共" };

onMounted(load);
onUnmounted(() => { active = false; historyRequest++; enrollment.value = null; });

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [relayList, organizationList] = await Promise.all([ep.listRelays(), ep.listOrganizations()]);
    relays.value = relayList;
    organizations.value = organizationList;
  } catch (failure) {
    error.value = errorMessage(failure);
  } finally {
    loading.value = false;
  }
}

function openEnrollment() {
  enrollmentForm.value = { organizationID: organizationFilter.value || organizations.value[0]?.id || "", name: "", visibility: "private", hours: 24 };
  enrollment.value = null;
  actionError.value = "";
  enrollmentOpen.value = true;
}

function closeEnrollment() {
  if (busy.value) return;
  // 注册密钥只在本次弹窗内存中展示，关闭或离开页面即清除，不进入浏览器存储。
  enrollment.value = null;
  enrollmentOpen.value = false;
}

async function createEnrollment() {
  if (busy.value || enrollment.value) return;
  const form = enrollmentForm.value;
  if (!form.organizationID || !Number.isInteger(form.hours) || form.hours < 1 || form.hours > 720) {
    actionError.value = "请选择租户，有效期须为 1 至 720 小时的整数";
    return;
  }
  busy.value = true;
  actionError.value = "";
  try {
    const answer = await ep.createRelayEnrollment(form.organizationID, {
      name: form.name.trim(), visibility: form.visibility, ttl_seconds: form.hours * 3600,
    });
    if (!answer?.token || !answer.item) throw new Error("注册令牌响应不完整，请联系管理员检查");
    if (!active || !enrollmentOpen.value) return;
    enrollment.value = answer;
  } catch (failure) {
    actionError.value = errorMessage(failure);
  } finally {
    busy.value = false;
  }
}

async function copyEnrollment() {
  if (!enrollment.value) return;
  try {
    if (!navigator.clipboard) throw new Error("当前连接不支持安全剪贴板，请手动复制令牌");
    await navigator.clipboard.writeText(enrollment.value.token);
    admin.toast("success", "已复制，请仅粘贴到受保护的中继配置中");
  } catch {
    actionError.value = "无法访问安全剪贴板，请手动复制令牌";
  }
}

function openConfig(relay: PlatformRelay) {
  editing.value = relay;
  configForm.value = { desiredState: relay.desiredState, bandwidth: String(relay.bandwidthLimit), regionName: relay.regionName ?? "" };
  actionError.value = "";
  configConflict.value = false; latest.value = null;
}

async function readLatest() {
  const relay = editing.value;
  if (!relay || busy.value) return;
  busy.value = true;
  try {
    const current = await ep.getRelay(relay.organizationId, relay.id);
    if (active && editing.value === relay) latest.value = current;
  } catch (failure) { actionError.value = errorMessage(failure); }
  finally { busy.value = false; }
}

function acceptLatest() {
  if (!latest.value) return;
  // 平台与用户中心共享版本链；显式确认最新基准，但不改动操作方的草稿。
  editing.value = latest.value; latest.value = null; configConflict.value = false; actionError.value = "";
}

function closeConfig() {
  if (!busy.value) editing.value = null;
}

async function saveConfig() {
  const relay = editing.value;
  if (!relay || busy.value) return;
  actionError.value = "";
  let bandwidth: number;
  try {
    bandwidth = parseBandwidth(configForm.value.bandwidth);
  } catch (failure) {
    actionError.value = errorMessage(failure);
    return;
  }
  const nextState = configForm.value.desiredState;
  if (nextState !== relay.desiredState && nextState !== "online" &&
      !window.confirm(`将中继「${relay.name}」设为${relayStatuses[nextState].label}？这可能中断使用它的连接。`)) return;
  busy.value = true;
  try {
    const updated = await ep.updateRelay(relay.organizationId, relay.id, {
      config_version: relay.configVersion, desired_state: nextState, bandwidth_limit: bandwidth, region_name: configForm.value.regionName.trim(),
    });
    relays.value = relays.value.map((item) => item.organizationId === relay.organizationId && item.id === relay.id
      ? { ...updated, organizationName: relay.organizationName } : item);
    editing.value = null;
    admin.toast("success", "期望配置已保存，中继在后续心跳获取配置");
  } catch (failure) {
    actionError.value = errorMessage(failure);
    configConflict.value = failure instanceof ApiError && failure.status === 409;
  } finally {
    busy.value = false;
  }
}

async function removeRelay(relay: PlatformRelay) {
  if (busy.value || !window.confirm(`删除中继「${relay.name}」？其长期身份将失效，恢复需要重新注册。`)) return;
  busy.value = true;
  try {
    await ep.deleteRelay(relay.organizationId, relay.id, relay.configVersion);
    relays.value = relays.value.filter((item) => item.organizationId !== relay.organizationId || item.id !== relay.id);
    admin.toast("success", "中继已删除，其后续心跳将被拒绝");
  } catch (failure) {
    admin.toast("error", errorMessage(failure));
  } finally {
    busy.value = false;
  }
}

async function openHistory(relay: PlatformRelay) {
  historyRelay.value = relay; history.value = []; historyError.value = "";
  await loadHistory();
}

async function loadHistory() {
  const relay = historyRelay.value;
  if (!relay) return;
  const request = ++historyRequest;
  historyLoading.value = true; historyError.value = "";
  try {
    const [current, items] = await Promise.all([ep.getRelay(relay.organizationId, relay.id), ep.listRelayHistory(relay.organizationId, relay.id)]);
    if (active && request === historyRequest) { historyRelay.value = { ...current, organizationName: relay.organizationName }; history.value = items; }
  } catch (failure) { if (active && request === historyRequest) historyError.value = errorMessage(failure); }
  finally { if (request === historyRequest) historyLoading.value = false; }
}

function closeHistory() {
  if (busy.value) return;
  historyRequest++; historyRelay.value = null; history.value = []; historyLoading.value = false;
}

async function restore(item: RelayConfigurationHistory) {
  const relay = historyRelay.value;
  if (!relay || busy.value || historyLoading.value || historyError.value) return;
  if (!window.confirm(`恢复 v${item.config_version}（${relayDesiredStateText(item.desired_state)} / ${item.region_name || '未命名地区'} / ${bandwidthText(item.bandwidth_limit)}）？会创建新版本，不恢复已撤销身份或已删除凭据。`)) return;
  busy.value = true;
  try {
    await ep.updateRelay(relay.organizationId, relay.id, { config_version: relay.configVersion, restore_from: item.config_version });
    admin.toast("success", "历史期望配置已发布为新版本，尚未确认节点实际执行");
    await Promise.all([loadHistory(), load()]);
  } catch (failure) { historyError.value = errorMessage(failure); }
  finally { busy.value = false; }
}
</script>

<template>
  <PageHeader title="中继管理" desc="管理各租户注册的中继：一次性接入、心跳状态和远程期望配置。">
    <template #actions>
      <button class="btn" :disabled="loading || busy" @click="load">刷新</button>
      <button class="btn primary" :disabled="loading || !!error || busy || !organizations.length" @click="openEnrollment">创建注册令牌</button>
    </template>
  </PageHeader>

  <div class="alert info relay-notice">此处只列出注册到平台的托管中继。静态 DERP map 中的公共中继不在本列表，列表为空不代表网络没有中继。</div>
  <div v-if="error" class="alert error relay-notice" role="alert">加载失败：{{ error }} <button class="btn small" :disabled="loading" @click="load">重试</button></div>

  <div v-if="!error" class="card">
    <div class="card-head"><h2>托管中继（{{ visibleRelays.length }} / {{ relays.length }}）</h2><span class="hint">状态以最近一次心跳为准</span></div>
    <div class="card-body relay-filters">
      <input v-model="keyword" class="input" aria-label="搜索中继" placeholder="搜索名称、区域、主机或租户" />
      <select v-model="organizationFilter" class="select" aria-label="筛选租户">
        <option value="">全部租户</option>
        <option v-for="organization in organizations" :key="organization.id" :value="organization.id">{{ organization.name }}（{{ organization.id }}）</option>
      </select>
      <select v-model="statusFilter" class="select" aria-label="筛选中继状态">
        <option value="">全部状态</option>
        <option v-for="(status, key) in relayStatuses" :key="key" :value="key">{{ status.label }}</option>
      </select>
    </div>
    <DataTable :columns="[
      { key: 'name', title: '中继 / 区域' }, { key: 'organizationId', title: '租户' },
      { key: 'status', title: '状态' }, { key: 'metrics', title: '心跳报告' },
      { key: 'lastSeen', title: '最近心跳' }, { key: 'actions', title: '操作', align: 'right' },
    ]" :rows="visibleRelays" :loading="loading" :row-key="(row) => `${row.organizationId}:${row.id}`"
      :empty-title="relays.length ? '没有匹配的中继' : '尚未注册托管中继'"
      empty-desc="可调整筛选条件，或创建一次性注册令牌后在服务器启动 xunara-relay。">
      <template #cell-name="{ row }">
        <div>{{ row.name }} <span class="badge">{{ visibilityLabels[row.visibility as RelayVisibility] || row.visibility }}</span></div>
        <div class="hint">{{ row.regionName || row.regionCode || '未设置区域' }} · {{ row.version || '版本未上报' }}</div>
        <div class="mono hint">{{ row.hostname || row.id }}</div>
      </template>
      <template #cell-organizationId="{ row }"><div>{{ row.organizationName || row.organizationId }}</div><div class="mono hint">{{ row.organizationId }}</div></template>
      <template #cell-status="{ row }"><span class="badge" :class="relayStatuses[relayStatus(row)].tone">{{ relayStatuses[relayStatus(row)].label }}</span></template>
      <template #cell-metrics="{ row }">
        <div v-if="row.lastSeen">连接 {{ row.connectedClients ?? '—' }} · 接收 {{ bytesText(row.bytesIn) }} / 发送 {{ bytesText(row.bytesOut) }}</div>
        <div v-else class="hint">尚无心跳报告</div>
        <div class="hint">期望 v{{ row.configVersion }} · {{ bandwidthText(row.bandwidthLimit) }}</div>
        <span class="badge" :class="relayExecutionSummary(row, executionNow).tone">{{ relayExecutionSummary(row, executionNow).label }}</span>
        <div class="hint">{{ relayExecutionSummary(row, executionNow).detail }}</div>
        <div v-if="row.executionReportedAt" class="hint">回执 {{ formatTime(row.executionReportedAt) }}</div>
      </template>
      <template #cell-lastSeen="{ row }"><span :title="formatTime(row.lastSeen)">{{ relativeTime(row.lastSeen) }}</span></template>
      <template #cell-actions="{ row }"><div class="row-actions">
        <button class="btn small" :disabled="busy || loading" @click="openHistory(row)">历史</button>
        <button class="btn small" :disabled="busy || loading" @click="openConfig(row)">配置</button>
        <button class="btn small danger" :disabled="busy || loading" @click="removeRelay(row)">删除</button>
      </div></template>
    </DataTable>
  </div>

  <ModalDialog title="创建中继注册令牌" :open="enrollmentOpen" @close="closeEnrollment">
    <div v-if="actionError" class="alert error relay-notice" role="alert">{{ actionError }}</div>
    <template v-if="enrollment">
      <div class="alert warning relay-notice">令牌只显示本次、只能注册一台中继。关闭后不能再次查看；不要放入网址、命令参数、日志或公开仓库。</div>
      <div class="field"><label for="relay-enrollment-secret">一次性注册令牌</label><textarea id="relay-enrollment-secret" class="input mono" :value="enrollment.token" readonly spellcheck="false" autocomplete="off" rows="3" /></div>
      <p class="hint">到期：{{ formatTime(enrollment.item.expiresAt) }}。请写入权限为 0600 的配置文件，通过环境变量读取。</p>
      <p class="hint">启动参数使用 <code>-enroll-token-env XUNARA_RELAY_TOKEN</code>，不要把实际令牌填进参数。</p>
    </template>
    <template v-else>
      <div class="field"><label for="relay-enrollment-org">所属租户</label><select id="relay-enrollment-org" v-model="enrollmentForm.organizationID" class="select" :disabled="busy"><option v-for="organization in organizations" :key="organization.id" :value="organization.id">{{ organization.name }}（{{ organization.id }}）</option></select></div>
      <div class="field"><label for="relay-enrollment-name">中继名称</label><input id="relay-enrollment-name" v-model="enrollmentForm.name" class="input" :disabled="busy" placeholder="例如：上海电信 01" maxlength="128" /></div>
      <div class="grid cols-2">
        <div class="field"><label for="relay-enrollment-visibility">可见范围</label><select id="relay-enrollment-visibility" v-model="enrollmentForm.visibility" class="select" :disabled="busy"><option v-for="(label, visibility) in visibilityLabels" :key="visibility" :value="visibility">{{ label }}</option></select></div>
        <div class="field"><label for="relay-enrollment-hours">有效期（小时）</label><input id="relay-enrollment-hours" v-model.number="enrollmentForm.hours" class="input" :disabled="busy" type="number" min="1" max="720" step="1" /></div>
      </div>
      <div class="alert info">实际接入仍受所属租户的中继额度限制。创建令牌本身不代表中继已经在线。</div>
    </template>
    <template #footer>
      <button class="btn" :disabled="busy" @click="closeEnrollment">{{ enrollment ? '完成并清除令牌' : '取消' }}</button>
      <button v-if="enrollment" class="btn primary" @click="copyEnrollment">复制令牌</button>
      <button v-else class="btn primary" :disabled="busy || !enrollmentForm.organizationID" @click="createEnrollment">{{ busy ? '正在创建…' : '生成一次性令牌' }}</button>
    </template>
  </ModalDialog>

  <ModalDialog :title="`配置中继：${editing?.name || ''}`" :open="!!editing" @close="closeConfig">
    <div v-if="actionError" class="alert error relay-notice" role="alert">{{ actionError }}</div>
    <p class="hint relay-notice">所属租户：{{ editing?.organizationId }} · 当前配置版本：{{ editing?.configVersion }}</p>
    <button v-if="configConflict && !latest" class="btn relay-notice" :disabled="busy" @click="readLatest">查看最新配置（保留草稿）</button>
    <div v-if="latest" class="alert info relay-notice"><p>最新 v{{ latest.configVersion }}：{{ relayDesiredStateText(latest.desiredState) }} · {{ latest.regionName || '未命名地区' }} · {{ bandwidthText(latest.bandwidthLimit) }}</p><p>确认最新基准不会改动草稿，仍需手动保存。</p><button class="btn" :disabled="busy" @click="acceptLatest">确认最新基准，保留草稿</button></div>
    <div class="field"><label for="relay-config-state">期望状态</label><select id="relay-config-state" v-model="configForm.desiredState" class="select" :disabled="busy || editing?.desiredState === 'revoked'"><option value="online">正常服务</option><option value="maintenance">维护中</option><option value="disabled">停用</option><option value="revoked">撤销（不可恢复身份）</option></select></div>
    <div class="field"><label for="relay-config-region">区域显示名</label><input id="relay-config-region" v-model="configForm.regionName" class="input" :disabled="busy" maxlength="128" /></div>
    <div class="field"><label for="relay-config-bandwidth">每连接限速（字节/秒）</label><input id="relay-config-bandwidth" v-model="configForm.bandwidth" class="input" :disabled="busy" type="number" min="-1" step="1" /><div class="help">-1：不限速；0：使用中继本地配置；正数：每连接的字节速率。</div></div>
    <div class="alert warning">维护拒绝新连接但保留既有连接；停用或撤销将断开既有连接。保存后请查看执行回执；撤销身份不能恢复启用，地图和心跳不等于实时连接或账单。</div>
    <template #footer><button class="btn" :disabled="busy" @click="closeConfig">取消</button><button class="btn primary" :disabled="busy || configConflict" @click="saveConfig">{{ busy ? '正在保存…' : '保存配置' }}</button></template>
  </ModalDialog>
  <ModalDialog title="中继配置历史" :open="!!historyRelay" @close="closeHistory">
    <p class="hint relay-notice">{{ historyRelay?.organizationId }} · {{ historyRelay?.name }} · 当前 v{{ historyRelay?.configVersion }}</p>
    <div v-if="historyError" class="alert error relay-notice" role="alert">{{ historyError }}</div>
    <p v-if="historyLoading" class="hint" role="status">正在读取配置历史…</p>
    <p v-else-if="!historyError && !history.length" class="hint">首次保存后记录原始配置与后续版本，旧部署的更早变更无法追溯。</p>
    <article v-for="item in history" :key="item.config_version" class="relay-history-item">
      <div class="row-actions"><strong>v{{ item.config_version }}</strong><span v-if="item.config_version === historyRelay?.configVersion" class="badge">当前版本</span><button v-else-if="historyRelay?.desiredState !== 'revoked'" class="btn small" :disabled="busy || historyLoading || !!historyError" @click="restore(item)">恢复此配置</button></div>
      <p>{{ relayDesiredStateText(item.desired_state) }} · {{ item.region_name || '未命名地区' }} · {{ bandwidthText(item.bandwidth_limit) }}</p>
      <p class="hint">{{ item.actor }} · {{ formatTime(item.created) }}</p>
    </article>
    <p class="hint">最多显示最近 50 项；恢复发布为新版本，不恢复凭据、证书、遥测或已撤销身份。</p>
    <template #footer><button class="btn" :disabled="busy || historyLoading" @click="loadHistory">刷新历史与基准</button><button class="btn" :disabled="busy" @click="closeHistory">关闭</button></template>
  </ModalDialog>
</template>

<style scoped>
.relay-notice { margin-bottom: 16px; }
.relay-filters { display: grid; grid-template-columns: minmax(200px, 2fr) repeat(2, minmax(160px, 1fr)); gap: 12px; }
.relay-history-item { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin: 12px 0; overflow-wrap: anywhere; }
textarea.input { height: auto; resize: vertical; }
@media (max-width: 1000px) { .relay-filters { grid-template-columns: 1fr; } }
</style>
