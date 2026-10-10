// Platform API client: JSON over HTTP with the operator token as a bearer
// credential. The token lives in this module's caller (the store), never in
// the URL, and 401 answers sign the operator out so a stale token cannot look
// like a broken console.

import { admin } from "../store";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type Options = { method?: string; body?: unknown; query?: Record<string, string | undefined>; headers?: Record<string, string> };

const platformErrorMessages: Record<string, string> = {
  "the current plan does not allow another relay": "当前套餐的托管中继额度已用完，请调整所属租户的套餐或清理现有中继。",
};

const platformErrorCodes: Record<string, string> = {
  RELAY_CONFIG_CHANGED: "中继配置已被其他管理员修改，草稿保留，请对照最新版本后继续",
  RELAY_VERSION_REQUIRED: "缺少中继版本，请刷新页面后操作",
  RELAY_CONFIG_INVALID: "中继配置无效，请检查状态、地区名称和整数带宽",
  RELAY_REVOKED: "已撤销的服务身份不能重新启用，请重新接入中继",
  CONFIG_NOT_FOUND: "历史版本不存在，请刷新历史列表",
  NETWORK_CONFIG_UNAVAILABLE: "网络配置暂时无法读取或提交，请稍后重试",
};

export async function platformApi<T>(path: string, options: Options = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: { ...options.headers, Accept: "application/json", Authorization: `Bearer ${admin.state.token}` },
  };
  const controller = new AbortController();
  init.signal = controller.signal;
  if (options.body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }

  const timeout = setTimeout(() => controller.abort(), 30000);
  let resp: Response;
  let text: string;
  try {
    resp = await fetch(url, init);
    text = await resp.text();
  } catch (failure) {
    if (controller.signal.aborted) throw new ApiError(408, "请求超时，提交结果未知；请刷新核对实际结果，不要直接重复提交");
    throw failure;
  } finally { clearTimeout(timeout); }
  if (resp.status === 401) {
    admin.signOut();
    throw new ApiError(resp.status, "平台令牌无效或已过期，请重新登录");
  }
  // 403 可能是套餐配额或权限限制，不代表平台身份失效，不能顺手清掉令牌。
  if (resp.status === 204) return undefined as T;

  let payload: any;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  if (!resp.ok) {
    const message = payload?.message ?? payload?.error ?? (text.trim() || `HTTP ${resp.status}`);
    const code = /^([A-Z_]+):/.exec(message)?.[1] ?? "";
    throw new ApiError(resp.status, platformErrorCodes[code] ?? platformErrorMessages[message] ?? message);
  }
  if (payload === undefined) throw new ApiError(502, "接口响应格式不正确，请刷新核对实际结果");
  return payload as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
