import type { Organization, OrganizationPayload, Plan } from "./types";

export function toOrganization(payload: OrganizationPayload): Organization {
  const stats = payload?.stats;
  if (!stats || typeof payload.id !== "string" || typeof payload.name !== "string" ||
      typeof payload.managed !== "boolean" || typeof stats.policy_loaded !== "boolean" ||
      ![stats.users, stats.nodes, stats.online, stats.pending_devices, stats.relays, stats.relays_online]
        .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("租户响应格式不正确，请稍后重试");
  }
  return {
    id: payload.id,
    name: payload.name,
    managed: payload.managed,
    domains: payload.domains,
    stats: {
      users: stats.users,
      nodes: stats.nodes,
      online: stats.online,
      pendingDevices: stats.pending_devices,
      policyLoaded: stats.policy_loaded,
      plan: stats.plan,
      planName: stats.plan_name,
      deviceLimit: stats.device_limit,
      networkPrefix: stats.network_prefix,
      relays: stats.relays,
      relaysOnline: stats.relays_online,
    },
  };
}

const planFields = [
  "id", "name", "price_cents", "currency", "billing_cycle", "max_devices", "max_users",
  "max_routes", "max_auth_keys", "max_relays", "allow_custom_cidr", "allow_exit_node",
  "allow_subnet_router", "allow_api", "allow_acl", "allow_grants", "allow_custom_dns",
  "allow_audit_log", "allow_multi_member",
] as const satisfies readonly (keyof Plan)[];

export function toPlan(payload: Plan): Plan {
  if (!payload || ![payload.max_devices, payload.max_users, payload.max_routes, payload.max_auth_keys, payload.max_relays]
    .every((value) => Number.isSafeInteger(value) && value >= -1)) {
    throw new Error("套餐响应缺少有效配额，请升级服务端后再编辑，避免覆盖原有额度");
  }
  // 读接口含展示字段，严格写接口只接受套餐数据；禁止把派生字段或新未知字段原样回写。
  return Object.fromEntries(planFields.map((field) => [field, payload[field]])) as unknown as Plan;
}
