import type { Organization, OrganizationPayload } from "./types";

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
