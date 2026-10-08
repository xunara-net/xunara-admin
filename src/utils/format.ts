// Formatting helpers shared by the views. Everything here is pure, which is
// what the unit tests cover.

/** formatTime renders an ISO timestamp in the browser's locale, or "—". */
export function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** relativeTime renders "3 分钟前" style text. */
export function relativeTime(value?: string | null, now = Date.now()): string {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "从未";
  const diff = Math.floor((now - date.getTime()) / 1000);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`;
  return formatTime(value);
}

/**
 * quotaText renders a quota: the plan uses -1 for "unlimited".
 */
export function quotaText(value: number | undefined): string {
  if (value === undefined || value === null) return "—";
  return value < 0 ? "不限" : String(value);
}

/** quotaPercent is the used/limit ratio, or null when unlimited. */
export function quotaPercent(used: number, limit: number | undefined): number | null {
  if (limit === undefined || limit === null || limit < 0 || limit === 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

/** priceText renders the plan price, which the API reports in minor units. */
export function priceText(cents: number, currency: string): string {
  if (!cents) return "免费";
  const amount = (cents / 100).toFixed(2).replace(/\.00$/, "");
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${amount}`;
}

/** roleLabel translates the platform roles. */
export function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    owner: "所有者",
    admin: "管理员",
    member: "成员",
    viewer: "只读",
  };
  return labels[role] ?? role;
}
