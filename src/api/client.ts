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
  PLATFORM_AUTH_DISABLED: "管理员通行密钥未启用，请使用平台令牌登录或配置可信 HTTPS 入口",
  PLATFORM_AUTH_UNAVAILABLE: "管理员认证服务暂时不可用，请刷新核对，不要重复提交",
  PLATFORM_AUTH_RATE_LIMITED: "登录尝试过多，请稍后重试",
  PLATFORM_LOGIN_FAILED: "平台恢复令牌无效，请核对后重试",
  PLATFORM_PASSKEY_FAILED: "通行密钥验证未完成，请刷新核对并重新开始",
  PLATFORM_ORIGIN_INVALID: "请从配置的管理员 HTTPS 入口登录或管理通行密钥",
  PLATFORM_SESSION_REQUIRED: "请重新登录后台后管理通行密钥",
  PLATFORM_REAUTH_REQUIRED: "修改管理员凭据前需要重新登录（最近验证须在 15 分钟内）",
  USER_CREATE_INVALID: "请检查用户名、资料、角色及密码强度",
  USER_CREATE_UNAVAILABLE: "创建结果未知，请刷新用户列表核对，不要直接重复创建",
  LOGIN_NAME_TAKEN: "该网络内已存在相同用户名，请更换用户名",
  USER_LIMIT_REACHED: "该网络成员额度已满，请先调整套餐或清理成员",
  LOCAL_LOGIN_DISABLED: "此网络未启用本地密码登录，请使用邀请或第三方登录加入",
  PASSKEY_NOT_FOUND: "通行密钥已不存在，请刷新列表",
  PASSWORD_RESET_CHANGED: "账号已被其他操作修改，请刷新核对后重新确认；不会自动重新生成",
  PASSWORD_RESET_VERSION_REQUIRED: "缺少完整账号版本，请刷新后生成重置码",
  PASSWORD_RESET_REQUEST_INVALID: "请核实持有人并填写 1～256 字的单行重置原因",
  PASSWORD_RESET_NOT_AVAILABLE: "账号未启用本地密码或已被禁用，不能生成重置码",
  PASSWORD_RESET_UNAVAILABLE: "恢复服务暂时不可用，结果需刷新核对；不要连续重复生成",
  USER_STATUS_CHANGED: "账号已被其他操作修改，请刷新核对后重新确认",
  USER_VERSION_REQUIRED: "缺少账号版本，请刷新后操作",
  USER_STATUS_INVALID: "账号状态无效，请填写 1～256 字的单行操作原因",
  USER_STATUS_UNAVAILABLE: "账号状态暂时不可用，提交结果需刷新核对，请勿直接重复提交",
  USER_NOT_FOUND: "账号或租户不存在，请刷新列表",
  LAST_ACTIVE_OWNER: "不能禁用最后一位启用的所有者，请先指定另一位可登录的所有者",
  AUTH_CONFIG_CHANGED: "登录设置已被其他管理员修改，请刷新核对，不能直接覆盖",
  AUTH_CONFIG_VERSION_REQUIRED: "缺少登录配置版本，请刷新后保存",
  AUTH_CONFIG_INVALID: "登录配置无效，请核对应用凭据和公网 HTTPS 地址",
  AUTH_CONFIG_UNAVAILABLE: "登录配置暂时不可用，请刷新核对实际结果",
  PROVIDER_ID_RESERVED: "提供方 ID 已被使用或归档，请选择新 ID",
  PROVIDER_ARCHIVED: "提供方已归档，不能复用其 ID",
  PROVIDER_NOT_FOUND: "登录提供方不存在，请刷新租户配置",
  LAST_LOGIN_METHOD: "部分账户只依赖此提供方登录，停用会锁死账户；请先为它们配置其他登录方式",
  DEPLOYMENT_PROVIDER: "此提供方来自部署配置，只能在页面启停；更换身份域请创建新 ID",
  RELAY_CONFIG_CHANGED: "中继配置已被其他管理员修改，草稿保留，请对照最新版本后继续",
  RELAY_VERSION_REQUIRED: "缺少中继版本，请刷新页面后操作",
  RELAY_CONFIG_INVALID: "中继配置无效，请检查状态、地区名称和整数带宽",
  RELAY_REVOKED: "已撤销的服务身份不能重新启用，请重新接入中继",
  CONFIG_NOT_FOUND: "历史版本不存在，请刷新历史列表",
  NETWORK_CONFIG_UNAVAILABLE: "网络配置暂时无法读取或提交，请稍后重试",
};

export async function platformApi<T>(path: string, options: Options = {}): Promise<T> {
  return platformRequest<T>(path, options, admin.state.token, true);
}

// 登录接口不借用/保存永久令牌；只在本次请求头使用，然后换取可撤销的短期会话。
export async function platformAuthApi<T>(path: string, options: Options = {}, token = ""): Promise<T> {
  return platformRequest<T>(path, options, token, false);
}

async function platformRequest<T>(path: string, options: Options, token: string, clearOnUnauthorized: boolean): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: { ...options.headers, Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
    if (clearOnUnauthorized) admin.signOut();
    throw new ApiError(resp.status, "平台身份无效或会话已过期，请重新登录");
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
