import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformApi } from "./client";
import { createRelayEnrollment, deleteRelay, getRelay, listRelayHistory, listRelays, setTenantPlan, updateRelay } from "./endpoints";

vi.mock("./client", () => ({ platformApi: vi.fn() }));

describe("relay platform API contract", () => {
  beforeEach(() => vi.mocked(platformApi).mockReset());

  it("reads the server's relays envelope", async () => {
    const relays = [{ id: "relay-1", organizationId: "acme" }];
    vi.mocked(platformApi).mockResolvedValue({ relays, count: 1 });
    expect(await listRelays()).toBe(relays);
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/relays");
  });

  it("does not turn malformed list responses into an empty network", async () => {
    vi.mocked(platformApi).mockResolvedValue({ items: [] });
    await expect(listRelays()).rejects.toThrow("中继列表响应格式不正确");
  });

  it("creates a one-time token with the tenant path and snake_case request fields", async () => {
    const answer = { token: "one-time-test-credential", item: { id: "enroll-1" } };
    vi.mocked(platformApi).mockResolvedValue(answer);
    const body = { name: "上海 01", visibility: "private" as const, ttl_seconds: 3600 };
    expect(await createRelayEnrollment("tenant/id", body)).toBe(answer);
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/organizations/tenant%2Fid/relays/enroll-tokens", { method: "POST", body });
  });

  it("keeps zero bandwidth updates and escapes both tenant and relay IDs", async () => {
    const body = { config_version: 2, desired_state: "maintenance" as const, bandwidth_limit: 0, region_name: "" };
    vi.mocked(platformApi).mockResolvedValue({ id: "relay?other", organizationId: "tenant/id", configVersion: 3 });
    await updateRelay("tenant/id", "relay?other", body);
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/organizations/tenant%2Fid/relays/relay%3Fother", { method: "PATCH", body });
    await deleteRelay("acme", "relay/id", 3);
    expect(platformApi).toHaveBeenLastCalledWith("/api/platform/v1/organizations/acme/relays/relay%2Fid", { method: "DELETE", headers: { "If-Match": "3" } });
  });

  it("uses a new monotonic version when restoring history", async () => {
    vi.mocked(platformApi).mockResolvedValue({ id: "relay-1", organizationId: "acme", configVersion: 4 });
    await updateRelay("acme", "relay-1", { config_version: 3, restore_from: 1 });
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/organizations/acme/relays/relay-1", { method: "PATCH", body: { config_version: 3, restore_from: 1 } });
  });

  it("rejects a configuration from a different tenant or a false save acknowledgement", async () => {
    vi.mocked(platformApi).mockResolvedValue({ id: "relay-1", organizationId: "other", configVersion: 2 });
    await expect(getRelay("acme", "relay-1")).rejects.toThrow("格式不正确");
    vi.mocked(platformApi).mockResolvedValue({ id: "relay-1", organizationId: "acme", configVersion: 3 });
    await expect(updateRelay("acme", "relay-1", { config_version: 3, restore_from: 1 })).rejects.toThrow("格式不正确");
  });

  it("validates historical configuration fields and descending unique versions", async () => {
    const item = { config_version: 1, desired_state: "online", bandwidth_limit: 0, region_name: "原始地区", actor: "system:import", created: "2026-10-10T00:00:00Z" };
    vi.mocked(platformApi).mockResolvedValue({ items: [item] });
    expect(await listRelayHistory("acme", "relay-1")).toEqual([item]);
    for (const items of [[item, item], [item, { ...item, config_version: 2 }], [{ ...item, desired_state: "unknown" }], [{ ...item, bandwidth_limit: -2 }]]) {
      vi.mocked(platformApi).mockResolvedValue({ items });
      await expect(listRelayHistory("acme", "relay-1")).rejects.toThrow("格式不正确");
    }
  });

  it("changes the tenant plan with the server's plan_id field, not a silently ignored label", async () => {
    await setTenantPlan("acme", "pro");
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/organizations/acme/plan", { method: "PATCH", body: { plan_id: "pro" } });
  });
});
