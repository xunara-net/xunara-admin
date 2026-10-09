import { beforeEach, describe, expect, it, vi } from "vitest";
import { toPlan } from "./adapters";
import { listPlans, savePlan } from "./endpoints";
import { platformApi } from "./client";
import type { Plan } from "./types";

vi.mock("./client", () => ({ platformApi: vi.fn() }));

const plan: Plan = {
  id: "pro", name: "Pro", price_cents: 1990, currency: "CNY", billing_cycle: "month",
  max_devices: 50, max_users: 5, max_routes: 32, max_auth_keys: 25, max_relays: 5,
  allow_custom_cidr: true, allow_exit_node: true, allow_subnet_router: true, allow_api: true,
  allow_acl: true, allow_grants: true, allow_custom_dns: true, allow_audit_log: true, allow_multi_member: true,
};

describe("plan catalog read/write contract", () => {
  beforeEach(() => vi.mocked(platformApi).mockReset());

  it("drops derived read-only fields rather than sending them to the strict write endpoint", async () => {
    const wire = { ...plan, default: false, device_allowance: "50", future_field: "unknown" };
    expect(toPlan(wire)).toEqual(plan);
    await savePlan(wire);
    expect(platformApi).toHaveBeenCalledWith("/api/platform/v1/plans", { method: "POST", body: plan });
  });

  it("normalizes the catalog and preserves explicit zero/unlimited relay limits", async () => {
    vi.mocked(platformApi).mockResolvedValue({ plans: [{ ...plan, default: true, max_relays: 0 }], default: "pro" });
    expect(await listPlans()).toEqual({ plans: [{ ...plan, max_relays: 0 }], default: "pro" });
    expect(toPlan({ ...plan, max_relays: -1 }).max_relays).toBe(-1);
  });

  it("refuses missing or malformed relay quotas instead of silently overwriting them", async () => {
    const incomplete = { ...plan } as Partial<Plan>;
    delete incomplete.max_relays;
    expect(() => toPlan(incomplete as Plan)).toThrow("避免覆盖原有额度");
    expect(() => savePlan(incomplete as Plan)).toThrow("避免覆盖原有额度");
    expect(platformApi).not.toHaveBeenCalled();
    for (const max_relays of [-2, 1.5, NaN]) {
      expect(() => toPlan({ ...plan, max_relays })).toThrow();
    }
  });
});
