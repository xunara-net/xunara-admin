import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformApi } from "./client";
import { canResetPassword, issuePasswordReset } from "./password-reset";
import { parsePlatformUsers } from "./user-status";

vi.mock("./client", () => ({ platformApi: vi.fn() }));
const user = { org: "tenant/id", orgName: "团队", id: 2, login: "member", displayName: "成员", email: "", role: "member", plan: "free", sessions: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T01:00:00.123456789Z", disabled: false, passwordResetAvailable: true };
const issued = { org: user.org, id: user.id, updatedAt: "2026-10-11T02:00:00.123456790Z", resetId: "pr_" + "a".repeat(32), code: "reset-" + "a".repeat(43), createdAt: "2026-10-11T02:00:00.123456789Z", expiresAt: "2026-10-11T02:15:00.123456789Z", passwordChanged: false, sessionsRevoked: 0 };

describe("platform password recovery", () => {
  beforeEach(() => vi.mocked(platformApi).mockReset());

  it("requires an enabled password account, exact revision and ownership verification before sending", async () => {
    for (const account of [{ ...user, disabled: true }, { ...user, updatedAt: undefined }, { ...user, passwordResetAvailable: undefined }, { ...user, passwordResetAvailable: false }]) {
      expect(canResetPassword(account)).toBe(false);
      await expect(issuePasswordReset(account, "核实恢复", true)).rejects.toThrow("刷新");
    }
    await expect(issuePasswordReset(user, "核实恢复", false)).rejects.toThrow("核实");
    for (const reason of ["", "\n", "secret\u0000reason", "长".repeat(257)]) await expect(issuePasswordReset(user, reason, true)).rejects.toThrow("操作原因");
    expect(platformApi).not.toHaveBeenCalled();
  });

  it("keeps nanosecond versions and sends only a private POST body", async () => {
    vi.mocked(platformApi).mockResolvedValue(issued);
    expect(await issuePasswordReset(user, " 核实恢复 ", true)).toEqual(issued);
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/organizations/tenant%2Fid/users/2/password-reset", {
      method: "POST", body: { reason: "核实恢复", expected_updated_at: user.updatedAt, ownership_verified: true },
    });
  });

  it("rejects wrong tenants, restored revisions, malformed secrets or an acknowledgement that already changed credentials", async () => {
    for (const response of [{ ...issued, org: "other" }, { ...issued, id: 3 }, { ...issued, updatedAt: user.updatedAt },
      { ...issued, code: "short" }, { ...issued, resetId: "invalid" }, { ...issued, passwordChanged: true },
      { ...issued, sessionsRevoked: 1 }, { ...issued, expiresAt: issued.createdAt }, { ...issued, expiresAt: "2026-10-11T03:00:00Z" }]) {
      vi.mocked(platformApi).mockResolvedValue(response);
      await expect(issuePasswordReset(user, "核实恢复", true)).rejects.toThrow("结果未知");
    }
  });

  it("does not invent availability for old servers or accept contradictory pending status", () => {
    expect(parsePlatformUsers({ users: [{ ...user, passwordResetAvailable: undefined }] })[0].passwordResetAvailable).toBeUndefined();
    for (const account of [{ ...user, passwordResetAvailable: "true" }, { ...user, disabled: undefined },
      { ...user, passwordResetExpiresAt: "invalid" }, { ...user, passwordResetAvailable: false, passwordResetExpiresAt: issued.expiresAt }]) {
      expect(() => parsePlatformUsers({ users: [account] })).toThrow("格式不正确");
    }
  });
});
