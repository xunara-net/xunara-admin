import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformApi } from "./client";
import { createUser, type CreateUserInput } from "./create-user";

vi.mock("./client", () => ({ platformApi: vi.fn() }));
const input: CreateUserInput = { login: "alice", role: "member", display_name: "用户", email: "", password: "test-only-password" };
describe("platform user creation", () => {
  beforeEach(() => vi.mocked(platformApi).mockReset());
  it("creates only in the explicitly chosen tenant", async () => {
    vi.mocked(platformApi).mockResolvedValue({ org: "tenant/id", id: 2, login: "alice", role: "member" });
    await createUser("tenant/id", input);
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/organizations/tenant%2Fid/users", { method: "POST", body: input });
  });
  it("rejects empty tenants and mismatched acknowledgements", async () => {
    await expect(createUser("", input)).rejects.toThrow("请选择网络");
    expect(platformApi).not.toHaveBeenCalled();
    vi.mocked(platformApi).mockResolvedValue({ org: "other", id: 2, login: "alice", role: "member" });
    await expect(createUser("tenant", input)).rejects.toThrow("刷新用户列表");
  });
});
