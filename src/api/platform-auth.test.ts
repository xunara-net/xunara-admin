import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformApi, platformAuthApi } from "./client";
import { authStatus, tokenLogin, finishLogin, finishRegistration, listPasskeys, unbindPasskey } from "./platform-auth";

vi.mock("./client", () => ({ platformApi: vi.fn(), platformAuthApi: vi.fn() }));
describe("independent administrator credentials", () => {
  beforeEach(() => { vi.mocked(platformApi).mockReset(); vi.mocked(platformAuthApi).mockReset(); });
  it("exchanges recovery in a header, not the body or URL", async () => {
    vi.mocked(platformAuthApi).mockResolvedValue({ token: "short-session", expires_at: "2026-10-13T14:00:00Z" });
    expect(await tokenLogin(" recovery-secret ")).toBe("short-session");
    expect(platformAuthApi).toHaveBeenCalledWith("/api/platform/v1/auth/token", { method: "POST", body: {} }, "recovery-secret");
  });
  it("rejects invalid login results and malformed configuration", async () => {
    vi.mocked(platformAuthApi).mockResolvedValue({ token: "", expires_at: "invalid" });
    await expect(finishLogin({})).rejects.toThrow("登录结果无效");
    vi.mocked(platformAuthApi).mockResolvedValue({ enabled: "yes" });
    await expect(authStatus()).rejects.toThrow("配置响应无效");
  });
  it("supports multiple keys and escapes the unbinding path", async () => {
    const result = { passkeys: [{ id: "first", name: "手机", created_at: "2026-10-13T00:00:00Z" }, { id: "second", name: "电脑", created_at: "2026-10-13T00:00:00Z" }], recovery_available: true, auth_method: "passkey", expires_at: "2026-10-13T14:00:00Z" };
    vi.mocked(platformApi).mockResolvedValue(result);
    expect(await listPasskeys()).toEqual(result);
    vi.mocked(platformApi).mockResolvedValue({ signed_out: true });
    await unbindPasskey("key/id?");
    expect(platformApi).toHaveBeenLastCalledWith("/api/platform/v1/auth/passkeys/key%2Fid%3F", { method: "DELETE" });
    vi.mocked(platformApi).mockResolvedValue({ ...result, passkeys: [{ id: "first" }] });
    await expect(listPasskeys()).rejects.toThrow("列表响应无效");
  });
  it("does not report a false binding or unbinding acknowledgement as success", async () => {
    vi.mocked(platformApi).mockResolvedValue({ passkey: { id: "key", name: "other", created_at: "2026-10-13T00:00:00Z" } });
    await expect(finishRegistration("手机", {})).rejects.toThrow("绑定确认响应无效");
    vi.mocked(platformApi).mockResolvedValue({});
    await expect(unbindPasskey("key")).rejects.toThrow("解绑确认响应无效");
  });
});
