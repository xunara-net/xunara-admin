import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticationSettings, createAuthenticationAPI, type AuthenticationSettings } from "./authentication-settings";
import { platformApi as api } from "./client";

vi.mock("./client", () => ({ api: vi.fn(), platformApi: vi.fn() }));

const settings: AuthenticationSettings = {
  control_url: "https://app.example.test", revision: 0, registration: "invite", self_service: false,
  public_signup_enabled: false, can_manage_public_signup: false, local_login: true, providers: [], csrf_token: "session-bound-csrf",
};
const provider = {
  id: "company", type: "oidc", protocol: "oidc", display_name: "公司账号", client_id: "client",
  issuer: "https://id.example.test", base_url: "", auth_url: "", token_url: "", userinfo_url: "", subject_field: "",
  name_field: "", username_field: "", email_field: "", auth_style: "", scopes: ["openid"],
  enabled: false, archived: false, source: "runtime", secret_configured: true,
  callback_url: "https://app.example.test/oidc/callback/company",
};
beforeEach(() => { vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue(settings); });

describe("authentication management contracts", () => {
  it("requires a verified policy, persistent version and CSRF for human writes", () => {
    expect(authenticationSettings(settings, true)).toEqual(settings);
    for (const invalid of [
      { ...settings, revision: -1 }, { ...settings, revision: 0.5 }, { ...settings, registration: "unknown" },
      { ...settings, csrf_token: "" }, { ...settings, local_login: "true" }, { ...settings, providers: {} },
    ]) expect(() => authenticationSettings(invalid, true)).toThrow("响应格式异常");
    expect(authenticationSettings({ ...settings, csrf_token: undefined }, false).revision).toBe(0);
  });
  it("rejects response secrets and malformed providers instead of exposing or enabling them", () => {
    expect(authenticationSettings({ ...settings, providers: [provider] }, true).providers).toHaveLength(1);
    for (const invalid of [
      { ...provider, client_secret: "never-return" }, { ...provider, sealed_secret: "v1:opaque" },
      { ...provider, enabled: "true" }, { ...provider, source: "browser" }, { ...provider, callback_url: null },
    ]) expect(() => authenticationSettings({ ...settings, providers: [invalid] }, false)).toThrow("响应格式异常");
  });
  it("submits secrets only in a single creation body, not URL or server file references", async () => {
    const client = createAuthenticationAPI("/api/v1/authentication", true);
    await client.create(settings, { id: "github-main", type: "github", display_name: "GitHub", client_id: "client", client_secret: "one-use-input", enabled: false });
    const [endpoint, options] = vi.mocked(api).mock.calls[0]!;
    expect(endpoint).toBe("/api/v1/authentication/providers");
    expect(options).toMatchObject({ method: "POST", headers: { "X-CSRF-Token": "session-bound-csrf" },
      body: { revision: 0, client_secret: "one-use-input", enabled: false } });
    expect(String(endpoint)).not.toContain("one-use-input");
    expect(JSON.stringify(options)).not.toContain("client_secret_file");
  });
  it("keeps public tenant creation independent and omits its switch from owner requests", async () => {
    const client = createAuthenticationAPI("/api/v1/authentication", true);
    await client.policy(settings, "invite");
    expect(vi.mocked(api).mock.calls[0]?.[1]?.body).toEqual({ revision: 0, registration: "invite" });
    await client.policy(settings, "closed", false);
    expect(vi.mocked(api).mock.calls[1]?.[1]?.body).toEqual({ revision: 0, registration: "closed", public_signup_enabled: false });
  });
  it("supports platform-scoped URLs and CAS archive without copying human cookies", async () => {
    const client = createAuthenticationAPI("/api/platform/v1/organizations/team/authentication", false);
    await client.update(settings, "company", { enabled: false });
    expect(vi.mocked(api).mock.calls[0]).toEqual(["/api/platform/v1/organizations/team/authentication/providers/company",
      { method: "PATCH", body: { revision: 0, enabled: false }, headers: {} }]);
    await client.archive(settings, "company");
    expect(vi.mocked(api).mock.calls[1]).toEqual(["/api/platform/v1/organizations/team/authentication/providers/company",
      { method: "DELETE", body: undefined, headers: { "If-Match": "0" } }]);
  });
});
