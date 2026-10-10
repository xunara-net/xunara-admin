import type { RelayExecution } from "../api/types";

type ReportedRelay = {
  configVersion?: number;
  desiredState?: string;
  lastSeen?: string;
  execution?: RelayExecution;
  executionReportedAt?: string;
};

const states: Record<string, string> = { pending: "等待授权", online: "启用", maintenance: "维护中", disabled: "停用", revoked: "撤销" };
const failures: Record<string, string> = { cache_write_failed: "配置缓存写入失败", apply_failed: "运行时应用失败", config_invalid: "配置无效", version_conflict: "配置版本冲突" };
function version(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }
function timestamp(value: unknown): number { return typeof value === "string" ? Date.parse(value) : NaN; }

// 旧 Relay 可省略回执；一旦提供，就不能用缺省值补出“已执行”。
export function relayExecutionContract(relay: ReportedRelay): boolean {
  const report = relay.execution;
  if (report === undefined) return relay.executionReportedAt === undefined;
  if (!report || !version(report.config_version) || !Number.isSafeInteger(relay.configVersion) || Number(report.config_version) > Number(relay.configVersion)) return false;
  if (!Number.isSafeInteger(report.bandwidth_limit) || report.bandwidth_limit < 0 || !Object.hasOwn(states, report.state)) return false;
  if (report.applied_version !== undefined && (!version(report.applied_version) || Number(report.applied_version) > Number(report.config_version))) return false;
  if (!Number.isFinite(timestamp(relay.executionReportedAt)) || !Number.isFinite(timestamp(relay.lastSeen)) || timestamp(relay.executionReportedAt) > timestamp(relay.lastSeen)) return false;
  if (report.status === "applied") return report.applied_version === report.config_version && report.state !== "pending" && !report.error_code && (Number(report.config_version) !== relay.configVersion || report.state === relay.desiredState);
  return report.status === "failed" && typeof report.error_code === "string" && Object.hasOwn(failures, report.error_code);
}

export function relayExecutionSummary(relay: ReportedRelay, now = Date.now()): { label: string; tone: string; detail: string } {
  if (!relayExecutionContract(relay)) return { label: "执行报告异常", tone: "warning", detail: "无法确认执行结果，请刷新重试。" };
  if (relay.desiredState === "revoked") return { label: "身份已撤销 · 无停机回执", tone: "warning", detail: "控制面已拒绝身份；历史回执不能证明既有连接已断开。" };
  const report = relay.execution;
  if (!report) return { label: "执行状态未知", tone: "", detail: "尚未收到回执；旧版托管中继需升级后才能上报执行结果。" };
  const received = timestamp(relay.executionReportedAt);
  if (now - received > 180_000 || received > now + 30_000) return { label: "旧回执 · 非实时", tone: "warning", detail: `曾上报 v${report.config_version}，当前连接和运行状态未经确认。` };
  const effective = report.bandwidth_limit === 0 ? "不限速" : `${report.bandwidth_limit.toLocaleString("zh-CN")} 字节/秒/连接`;
  const actual = `上报运行状态：${states[report.state]} · ${effective}`;
  if (Number(report.config_version) !== relay.configVersion) return { label: `待应用 v${relay.configVersion}（上报 v${report.config_version}）`, tone: "warning", detail: actual };
  if (report.status === "failed") return { label: "中继上报执行失败", tone: "danger", detail: `${failures[report.error_code!]}；${actual}。上次成功：${report.applied_version ? `v${report.applied_version}` : "未确认"}。` };
  return { label: `中继上报已应用 v${report.applied_version}`, tone: "success", detail: `${actual}；服务身份自报，不替代端到端验证。` };
}
