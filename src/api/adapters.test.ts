import { describe, expect, it } from "vitest";
import { toOrganization } from "./adapters";
import type { OrganizationPayload } from "./types";

const payload: OrganizationPayload = {
  id: "acme", name: "测试租户", managed: true,
  stats: {
    users: 2, nodes: 8, online: 3, pending_devices: 1, policy_loaded: true,
    plan: "pro", plan_name: "专业版", device_limit: 50, network_prefix: "100.100.1.0/24",
    relays: 2, relays_online: 1,
  },
};

describe("organization wire adapter", () => {
  it("maps the actual server field names without losing quota or relay counts", () => {
    expect(toOrganization(payload).stats).toEqual({
      users: 2, nodes: 8, online: 3, pendingDevices: 1, policyLoaded: true,
      plan: "pro", planName: "专业版", deviceLimit: 50, networkPrefix: "100.100.1.0/24",
      relays: 2, relaysOnline: 1,
    });
  });

  it("preserves explicit zero and unlimited quotas", () => {
    expect(toOrganization({ ...payload, stats: { ...payload.stats, device_limit: 0 } }).stats.deviceLimit).toBe(0);
    expect(toOrganization({ ...payload, stats: { ...payload.stats, device_limit: -1 } }).stats.deviceLimit).toBe(-1);
  });

  it("rejects malformed successful responses instead of displaying an empty tenant", () => {
    expect(() => toOrganization({} as OrganizationPayload)).toThrow("租户响应格式不正确");
    expect(() => toOrganization({ ...payload, stats: {} } as OrganizationPayload)).toThrow("租户响应格式不正确");
    expect(() => toOrganization({ ...payload, stats: { ...payload.stats, users: NaN } })).toThrow("租户响应格式不正确");
  });
});
