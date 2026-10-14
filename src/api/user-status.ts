import { platformApi } from "./client";
import type { PlatformUser } from "./types";

export interface UserStatusResult {
  org: string;
  id: number;
  disabled: boolean;
  updatedAt: string;
  disabledAt?: string;
  disabledReason: string;
  revoked: number;
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

export function parsePlatformUsers(payload: unknown): PlatformUser[] {
  const users = (payload as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) throw new Error("用户列表响应格式不正确，请刷新核对");
  for (const user of users) {
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.org !== "string" || !user.org ||
      typeof user.login !== "string" || typeof user.role !== "string" || !Number.isSafeInteger(user.sessions) || user.sessions < 0 ||
      (user.disabled !== undefined && typeof user.disabled !== "boolean") ||
      (user.updatedAt !== undefined && !isTimestamp(user.updatedAt)) ||
      (user.disabledReason !== undefined && typeof user.disabledReason !== "string") ||
      (user.disabledAt !== undefined && !isTimestamp(user.disabledAt)) ||
      (user.passwordResetAvailable !== undefined && typeof user.passwordResetAvailable !== "boolean") ||
      (user.passwordResetAvailable === true && user.disabled !== false) ||
      (user.passwordResetMode !== undefined && user.passwordResetMode !== "temporary_password") ||
      (user.passwordChangeRequired !== undefined && typeof user.passwordChangeRequired !== "boolean") ||
      (user.disabled === true && (!user.disabledAt || !user.disabledReason)) ||
      (user.disabled === false && (user.disabledAt || user.disabledReason))) {
      throw new Error("用户状态响应格式不正确，请刷新核对");
    }
  }
  // 旧服务端缺少状态或版本时仍可查看账号，但页面必须显示未知并禁用状态写入。
  return users as PlatformUser[];
}

export async function setUserStatus(user: PlatformUser, disabled: boolean, reason: string): Promise<UserStatusResult> {
  if (!user.org || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.disabled !== "boolean" || !isTimestamp(user.updatedAt)) {
    throw new Error("缺少账号状态或完整版本，请刷新后操作");
  }
  const trimmed = reason.trim();
  if (!trimmed || [...trimmed].length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) throw new Error("请填写 1～256 字的单行操作原因");
  const payload = await platformApi<UserStatusResult>(
    `/api/platform/v1/organizations/${encodeURIComponent(user.org)}/users/${user.id}/status`,
    { method: "PATCH", body: { disabled, reason: trimmed, expected_updated_at: user.updatedAt } },
  );
  if (!payload || payload.org !== user.org || payload.id !== user.id || payload.disabled !== disabled || !isTimestamp(payload.updatedAt) ||
    (user.disabled !== disabled && payload.updatedAt === user.updatedAt) ||
    !Number.isSafeInteger(payload.revoked) || payload.revoked < 0 || typeof payload.disabledReason !== "string" ||
    (disabled && (!isTimestamp(payload.disabledAt) || payload.disabledReason !== trimmed)) ||
    (!disabled && (payload.disabledAt !== undefined || payload.disabledReason !== "" || payload.revoked !== 0))) {
    throw new Error("账号状态保存响应格式不正确，结果未知；请刷新核对，不要直接重复提交");
  }
  return payload;
}
