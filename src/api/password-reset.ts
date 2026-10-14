import { platformApi } from "./client";
import type { PlatformUser } from "./types";
import { isTimestamp } from "./user-status";

export interface RandomPasswordReset {
  org: string;
  id: number;
  updatedAt: string;
  temporaryPassword: string;
  passwordChangeRequired: true;
  passwordChanged: true;
  sessionsRevoked: number;
}

export function canResetPassword(user: PlatformUser): boolean {
  return !!user.org && Number.isSafeInteger(user.id) && user.id > 0 && user.disabled === false &&
    user.passwordResetAvailable === true && user.passwordResetMode === "temporary_password" && isTimestamp(user.updatedAt);
}

export async function resetRandomPassword(user: PlatformUser, reason: string, ownershipVerified: boolean): Promise<RandomPasswordReset> {
  if (!canResetPassword(user)) throw new Error("账号缺少本地密码、已被禁用或缺少完整版本，请刷新核对");
  const trimmed = reason.trim();
  if (!ownershipVerified) throw new Error("请先通过可靠渠道核实账号持有人，再勾选确认");
  if (!trimmed || [...trimmed].length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) throw new Error("请填写 1～256 字的单行操作原因");
  const payload = await platformApi<RandomPasswordReset>(
    `/api/platform/v1/organizations/${encodeURIComponent(user.org)}/users/${user.id}/password-reset/random`,
    { method: "POST", body: { reason: trimmed, expected_updated_at: user.updatedAt, ownership_verified: true } },
  );
  if (!payload || payload.org !== user.org || payload.id !== user.id || !isTimestamp(payload.updatedAt) || payload.updatedAt === user.updatedAt ||
    typeof payload.temporaryPassword !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(payload.temporaryPassword) ||
    payload.passwordChangeRequired !== true || payload.passwordChanged !== true ||
    !Number.isSafeInteger(payload.sessionsRevoked) || payload.sessionsRevoked < 0) {
    throw new Error("密码重置响应格式不正确，结果未知；请刷新核对，不要直接重复重置");
  }
  return payload;
}
