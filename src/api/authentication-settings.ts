import { platformApi as api } from "./client";

export type MemberRegistration = "closed" | "invite" | "open";
export type IdentityProviderType = "oidc" | "github" | "gitlab" | "gitea" | "generic";

export interface AuthenticationProvider {
  id: string;
  type: IdentityProviderType | "external";
  protocol: string;
  display_name: string;
  client_id: string;
  issuer: string;
  base_url: string;
  auth_url: string;
  token_url: string;
  userinfo_url: string;
  subject_field: string;
  name_field: string;
  username_field: string;
  email_field: string;
  auth_style: string;
  scopes: string[] | null;
  enabled: boolean;
  archived: boolean;
  source: "deployment" | "runtime";
  secret_configured: boolean;
  callback_url: string;
}

export interface AuthenticationSettings {
  control_url: string;
  revision: number;
  registration: MemberRegistration;
  self_service: boolean;
  public_signup_enabled: boolean;
  can_manage_public_signup: boolean;
  local_login: boolean;
  providers: AuthenticationProvider[];
  csrf_token?: string;
}

export interface NewIdentityProvider {
  id: string;
  type: IdentityProviderType;
  display_name: string;
  client_id: string;
  client_secret: string;
  enabled: boolean;
  issuer?: string;
  base_url?: string;
  auth_url?: string;
  token_url?: string;
  userinfo_url?: string;
  subject_field?: string;
  name_field?: string;
  username_field?: string;
  email_field?: string;
  auth_style?: string;
  scopes?: string[];
}

export interface AuthenticationAPI {
  get(): Promise<AuthenticationSettings>;
  policy(data: AuthenticationSettings, registration: MemberRegistration, publicSignup?: boolean): Promise<AuthenticationSettings>;
  create(data: AuthenticationSettings, provider: NewIdentityProvider): Promise<AuthenticationSettings>;
  update(data: AuthenticationSettings, id: string, patch: { display_name?: string; enabled?: boolean; client_secret?: string }): Promise<AuthenticationSettings>;
  archive(data: AuthenticationSettings, id: string): Promise<AuthenticationSettings>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 每个仓库各自验证同一服务端契约；畸形响应不能被当成未配置，尤其不能启用写操作。
export function authenticationSettings(value: unknown, requireCSRF: boolean): AuthenticationSettings {
  if (!object(value) || typeof value.control_url !== "string" || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      !["closed", "invite", "open"].includes(String(value.registration)) ||
      ![value.self_service, value.public_signup_enabled, value.can_manage_public_signup, value.local_login].every((item) => typeof item === "boolean") ||
      requireCSRF && (typeof value.csrf_token !== "string" || !value.csrf_token) ||
      !Array.isArray(value.providers) || !value.providers.every((provider) => object(provider) &&
        ["id", "display_name", "client_id", "issuer", "base_url", "auth_url", "token_url", "userinfo_url", "subject_field", "name_field", "username_field", "email_field", "auth_style", "protocol", "callback_url"].every((key) => typeof provider[key] === "string") &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(provider.id)) &&
        ["oidc", "github", "gitlab", "gitea", "generic", "external"].includes(String(provider.type)) &&
        ["deployment", "runtime"].includes(String(provider.source)) &&
        [provider.enabled, provider.archived, provider.secret_configured].every((item) => typeof item === "boolean") &&
        (provider.scopes === null || Array.isArray(provider.scopes) && provider.scopes.every((scope) => typeof scope === "string")) &&
        !("client_secret" in provider) && !("sealed_secret" in provider))) {
    throw new Error("登录设置响应格式异常，请刷新核对，不会自动启用注册或覆盖原配置");
  }
  return value as unknown as AuthenticationSettings;
}

export function createAuthenticationAPI(base: string, requireCSRF: boolean): AuthenticationAPI {
  const checked = async (path: string, method = "GET", body?: unknown, data?: AuthenticationSettings, archive = false) => {
    const headers: Record<string, string> = {};
    if (requireCSRF && data?.csrf_token) headers["X-CSRF-Token"] = data.csrf_token;
    if (archive && data) headers["If-Match"] = String(data.revision);
    return authenticationSettings(await api<unknown>(base + path, { method, body, headers }), requireCSRF);
  };
  return {
    get: () => checked("/settings"),
    policy: (data, registration, publicSignup) => checked("/settings", "PATCH", {
      revision: data.revision, registration, ...(publicSignup === undefined ? {} : { public_signup_enabled: publicSignup }),
    }, data),
    create: (data, provider) => checked("/providers", "POST", { ...provider, revision: data.revision }, data),
    update: (data, id, patch) => checked("/providers/" + encodeURIComponent(id), "PATCH", { ...patch, revision: data.revision }, data),
    archive: (data, id) => checked("/providers/" + encodeURIComponent(id), "DELETE", undefined, data, true),
  };
}
