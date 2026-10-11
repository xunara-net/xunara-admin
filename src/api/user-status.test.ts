import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformApi } from "./client";
import { parsePlatformUsers, setUserStatus } from "./user-status";

vi.mock("./client", () => ({ platformApi: vi.fn() }));

const user = { org: "tenant/id", orgName: "团队", id: 2, login: "member", displayName: "成员", email: "", role: "member", plan: "free", sessions: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T01:00:00.123456789Z", disabled: false, disabledReason: "" };
const saved = { org: user.org, id: 2, disabled: true, updatedAt: "2026-10-11T02:00:00.123456790Z", disabledAt: "2026-10-11T02:00:00.123456790Z", disabledReason: "管理复核", revoked: 1 };

describe("account status contract", () => {
  beforeEach(() => vi.mocked(platformApi).mockReset());

  it("keeps nanosecond CAS revisions intact and uses the target tenant path", async () => {
    vi.mocked(platformApi).mockResolvedValue(saved);
    expect(await setUserStatus(user, true, " 管理复核 ")).toEqual(saved);
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/organizations/tenant%2Fid/users/2/status", { method: "PATCH", body: { disabled: true, reason: "管理复核", expected_updated_at: user.updatedAt } });
  });

  it("does not accept a different tenant or false acknowledgement", async () => {
    for (const answer of [{ ...saved, org: "other" }, { ...saved, id: 3 }, { ...saved, disabled: false }, { ...saved, revoked: -1 }, { ...saved, disabledAt: undefined }, { ...saved, disabledReason: "other" }, { ...saved, updatedAt: "invalid" }, { ...saved, updatedAt: user.updatedAt }]) {
      vi.mocked(platformApi).mockResolvedValue(answer);
      await expect(setUserStatus(user, true, "管理复核")).rejects.toThrow("结果未知");
    }
  });

  it("requires a known account status, revision and a single-line reason before sending", async () => {
    for (const account of [{ ...user, updatedAt: undefined }, { ...user, disabled: undefined }, { ...user, id: 0 }]) {
      await expect(setUserStatus(account, true, "管理复核")).rejects.toThrow("刷新");
    }
    for (const reason of ["", "\n", "two\nlines", "hidden\u0000reason", "长".repeat(257)]) await expect(setUserStatus(user, true, reason)).rejects.toThrow("操作原因");
    expect(platformApi).not.toHaveBeenCalled();
  });

  it("accepts enable only without a restored disabled marker or session count", async () => {
    vi.mocked(platformApi).mockResolvedValue({ org: user.org, id: 2, disabled: false, updatedAt: saved.updatedAt, disabledReason: "", revoked: 0 });
    await expect(setUserStatus({ ...user, disabled: true }, false, "管理复核")).resolves.toMatchObject({ disabled: false });
    vi.mocked(platformApi).mockResolvedValue({ ...saved, disabled: false });
    await expect(setUserStatus({ ...user, disabled: true }, false, "管理复核")).rejects.toThrow("结果未知");
  });

  it("keeps legacy status unknown and rejects malformed or contradictory list states", () => {
    expect(parsePlatformUsers({ users: [{ ...user, updatedAt: undefined, disabled: undefined }] })[0].disabled).toBeUndefined();
    for (const payload of [{ items: [] }, { users: null }, { users: [{ ...user, disabled: "false" }] }, { users: [{ ...user, disabled: true }] }, { users: [{ ...user, disabledAt: saved.disabledAt }] }]) {
      expect(() => parsePlatformUsers(payload)).toThrow("格式不正确");
    }
  });
});
