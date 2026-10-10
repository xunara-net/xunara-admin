import type { PlatformRelay } from "../api/types";

export function relayDesiredStateText(state: string): string {
  const labels: Record<string, string> = { online: "启用", maintenance: "维护中", disabled: "已停用", revoked: "已撤销（不可恢复身份）" };
  return labels[state] ?? "未知期望状态";
}

export const relayStatuses = {
  online: { label: "在线", tone: "success" },
  degraded: { label: "降级", tone: "warning" },
  offline: { label: "离线", tone: "" },
  maintenance: { label: "维护中", tone: "warning" },
  disabled: { label: "已停用", tone: "danger" },
  revoked: { label: "已撤销", tone: "danger" },
  unknown: { label: "未知状态", tone: "warning" },
} as const;

export type RelayStatus = keyof typeof relayStatuses;

export function relayStatus(relay: PlatformRelay): RelayStatus {
  if (relay.desiredState === "maintenance" || relay.desiredState === "disabled" || relay.desiredState === "revoked") {
    return relay.desiredState;
  }
  if (relay.desiredState !== "online") return "unknown";
  // 心跳新鲜并不等于数据面健康；维护、停用状态也不能被旧的 healthy 标记覆盖。
  if (!relay.online) return "offline";
  return relay.healthy ? "online" : "degraded";
}

export function filterRelays(relays: PlatformRelay[], organizationID: string, status: string, keyword: string): PlatformRelay[] {
  const query = keyword.trim().toLocaleLowerCase();
  return relays.filter((relay) => {
    if (organizationID && relay.organizationId !== organizationID) return false;
    if (status && relayStatus(relay) !== status) return false;
    return !query || [relay.id, relay.name, relay.hostname, relay.regionCode, relay.regionName,
      relay.organizationId, relay.organizationName].some((value) => value?.toLocaleLowerCase().includes(query));
  });
}

export function bandwidthText(value: number): string {
  if (value === -1) return "不限速";
  if (value === 0) return "使用中继本地配置";
  return `${value.toLocaleString("zh-CN")} 字节/秒/连接`;
}

export function parseBandwidth(value: string | number): number {
  // Vue 的 number 输入会自动把 v-model 转为数值，校验不能只接受文本。
  if (!/^-?\d+$/.test(String(value).trim())) throw new Error("带宽必须是整数：-1、0 或正数字节数");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -1) throw new Error("带宽必须是 -1、0 或可安全表示的正整数");
  return parsed;
}

export function bytesText(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
