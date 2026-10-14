import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformApi } from "./client";
import { canResetPassword, resetRandomPassword } from "./password-reset";
import { parsePlatformUsers } from "./user-status";

vi.mock("./client", () => ({ platformApi: vi.fn() }));
const user = { org: "tenant/id", orgName: "团队", id: 2, login: "member", displayName: "成员", email: "", role: "member", plan: "free", sessions: 1, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T01:00:00.123456789Z", disabled: false, passwordResetAvailable: true, passwordResetMode: "temporary_password" as const };
const result = { org: user.org, id: user.id, updatedAt: "2026-10-14T02:00:00.123456790Z", temporaryPassword: "a".repeat(32), passwordChangeRequired: true, passwordChanged: true, sessionsRevoked: 2 };

describe("platform random password reset", () => {
  beforeEach(() => vi.mocked(platformApi).mockReset());

  it("requires an enabled password account, exact revision, current reset mode and ownership verification", async () => {
    for (const account of [{ ...user, disabled: true }, { ...user, updatedAt: undefined }, { ...user, passwordResetAvailable: false }, { ...user, passwordResetMode: undefined }]) {
      expect(canResetPassword(account)).toBe(false);
      await expect(resetRandomPassword(account, "核实恢复", true)).rejects.toThrow("刷新");
    }
    await expect(resetRandomPassword(user, "核实恢复", false)).rejects.toThrow("核实");
    for (const reason of ["", "\n", "bad\u0000reason", "长".repeat(257)]) await expect(resetRandomPassword(user, reason, true)).rejects.toThrow("操作原因");
    expect(platformApi).not.toHaveBeenCalled();
  });

  it("keeps nanosecond versions and uses the explicit direct reset endpoint without sending a chosen password", async () => {
    vi.mocked(platformApi).mockResolvedValue(result);
    expect(await resetRandomPassword(user, " 核实恢复 ", true)).toEqual(result);
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/organizations/tenant%2Fid/users/2/password-reset/random", {
      method: "POST", body: { reason: "核实恢复", expected_updated_at: user.updatedAt, ownership_verified: true },
    });
  });

  it("rejects wrong tenants, unchanged revisions, malformed passwords, old issuance results and missing forced change", async () => {
    for (const response of [null, { ...result, org: "other" }, { ...result, id: 3 }, { ...result, updatedAt: user.updatedAt },
      { ...result, temporaryPassword: "short" }, { ...result, temporaryPassword: "x".repeat(31) + "!" }, { ...result, passwordChanged: false },
      { ...result, passwordChangeRequired: false }, { ...result, sessionsRevoked: -1 }, { ...result, sessionsRevoked: 1.5 }]) {
      vi.mocked(platformApi).mockResolvedValue(response);
      await expect(resetRandomPassword(user, "核实恢复", true)).rejects.toThrow("结果未知");
    }
    expect(platformApi).toHaveBeenCalledTimes(10);
  });

  it("never invents direct reset capability for old servers or accepts malformed pending change state", () => {
    expect(canResetPassword(parsePlatformUsers({ users: [{ ...user, passwordResetMode: undefined }] })[0]!)).toBe(false);
    for (const account of [{ ...user, passwordResetAvailable: "true" }, { ...user, disabled: undefined },
      { ...user, passwordResetMode: "code" }, { ...user, passwordChangeRequired: "true" }]) {
      expect(() => parsePlatformUsers({ users: [account] })).toThrow("格式不正确");
    }
  });
});
