import { platformApi, platformAuthApi } from "./client";

export interface PlatformAuthStatus { enabled: boolean; origin: string; token_login_enabled: boolean }
export interface AdministratorPasskey { id: string; name: string; created_at: string; last_used_at?: string }
export interface AdministratorPasskeys { passkeys: AdministratorPasskey[]; recovery_available: boolean; auth_method: string; expires_at: string }
export type CreationOptions = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string; user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: (Omit<PublicKeyCredentialDescriptor, "id"> & { id: string })[];
};
export type RequestOptions = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string; allowCredentials?: (Omit<PublicKeyCredentialDescriptor, "id"> & { id: string })[];
};
const root = "/api/platform/v1/auth";

export async function authStatus(): Promise<PlatformAuthStatus> {
  const result = await platformAuthApi<PlatformAuthStatus>(`${root}/status`);
  if (typeof result?.enabled !== "boolean" || typeof result.origin !== "string" || typeof result.token_login_enabled !== "boolean") throw new Error("管理员登录配置响应无效");
  return result;
}

async function sessionResult(result: { token: string; expires_at: string }) {
  if (typeof result?.token !== "string" || !result.token || !Number.isFinite(Date.parse(result.expires_at))) throw new Error("管理员登录结果无效，请重新登录");
  return result.token;
}

export async function tokenLogin(token: string) {
  return sessionResult(await platformAuthApi<{ token: string; expires_at: string }>(`${root}/token`, { method: "POST", body: {} }, token.trim()));
}
export const beginLogin = () => platformAuthApi<{ options: { publicKey: RequestOptions } }>(`${root}/passkey/begin`, { method: "POST", body: {} });
export async function finishLogin(credential: unknown) {
  return sessionResult(await platformAuthApi<{ token: string; expires_at: string }>(`${root}/passkey/finish`, { method: "POST", body: credential }));
}
export async function listPasskeys(): Promise<AdministratorPasskeys> {
  const result = await platformApi<AdministratorPasskeys>(`${root}/passkeys`);
  if (!Array.isArray(result?.passkeys) || !result.passkeys.every(key => key && typeof key.id === "string" && typeof key.name === "string" && Number.isFinite(Date.parse(key.created_at))) || typeof result.recovery_available !== "boolean" || !Number.isFinite(Date.parse(result.expires_at))) throw new Error("管理员通行密钥列表响应无效");
  return result;
}
export const beginRegistration = () => platformApi<{ options: { publicKey: CreationOptions } }>(`${root}/passkeys/begin`, { method: "POST", body: {} });
export async function finishRegistration(name: string, credential: unknown) {
  const result = await platformApi<{ passkey: AdministratorPasskey }>(`${root}/passkeys/finish`, { method: "POST", body: { name, credential } });
  if (typeof result?.passkey?.id !== "string" || !result.passkey.id || result.passkey.name !== name || !Number.isFinite(Date.parse(result.passkey.created_at))) throw new Error("绑定确认响应无效，请刷新凭据列表核对实际结果");
  return result;
}
export async function unbindPasskey(id: string) {
  const result = await platformApi<{ signed_out: boolean }>(`${root}/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (typeof result?.signed_out !== "boolean") throw new Error("解绑确认响应无效，请重新登录并核对实际结果");
  return result;
}
export const logout = () => platformApi<void>(`${root}/logout`, { method: "POST", body: {} });
