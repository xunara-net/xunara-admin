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

type Options = { method?: string; body?: unknown; query?: Record<string, string | undefined> };

const platformErrorMessages: Record<string, string> = {
  "the current plan does not allow another relay": "当前套餐的托管中继额度已用完，请调整所属租户的套餐或清理现有中继。",
};

export async function platformApi<T>(path: string, options: Options = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${admin.state.token}` },
  };
  if (options.body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }

  const resp = await fetch(url, init);
  if (resp.status === 401) {
    admin.signOut();
    throw new ApiError(resp.status, "平台令牌无效或已过期，请重新登录");
  }
  // 403 可能是套餐配额或权限限制，不代表平台身份失效，不能顺手清掉令牌。
  if (resp.status === 204) return undefined as T;

  const text = await resp.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  if (!resp.ok) {
    const message = payload?.message ?? payload?.error ?? (text.trim() || `HTTP ${resp.status}`);
    throw new ApiError(resp.status, platformErrorMessages[message] ?? message);
  }
  return payload as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
