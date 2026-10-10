// Typed wrappers over /api/platform/v1.

import { platformApi } from "./client";
import { toOrganization, toPlan } from "./adapters";
import type { AuditEvent, Organization, OrganizationPayload, Plan, PlatformRelay, PlatformUser, RelayConfigUpdate, RelayConfigurationHistory, RelayEnrollment, RelayVisibility } from "./types";
import { relayExecutionContract } from "../utils/relay-execution";

export const listOrganizations = async (): Promise<Organization[]> => {
  const answer = await platformApi<{ organizations: OrganizationPayload[] }>("/api/platform/v1/organizations");
  if (!Array.isArray(answer?.organizations)) throw new Error("租户列表响应格式不正确");
  return answer.organizations.map(toOrganization);
};

export const getOrganization = async (id: string) =>
  toOrganization(await platformApi<OrganizationPayload>(`/api/platform/v1/organizations/${encodeURIComponent(id)}`));

export const updateOrganization = async (id: string, body: { name?: string }) =>
  toOrganization(await platformApi<OrganizationPayload>(`/api/platform/v1/organizations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  }));

export const deleteOrganization = (id: string) =>
  platformApi<void>(`/api/platform/v1/organizations/${encodeURIComponent(id)}`, { method: "DELETE" });

export const setTenantPlan = (orgID: string, planID: string) =>
  platformApi<unknown>(`/api/platform/v1/organizations/${encodeURIComponent(orgID)}/plan`, {
    method: "PATCH",
    body: { plan_id: planID },
  });

export const allocateTenantNetwork = (orgID: string) =>
  platformApi<{ network_prefix?: string }>(
    `/api/platform/v1/organizations/${encodeURIComponent(orgID)}/plan/allocate`,
    { method: "POST", body: {} },
  );

export const listPlans = async (): Promise<{ plans: Plan[]; default: string }> => {
  const answer = await platformApi<{ plans: Plan[]; default: string }>("/api/platform/v1/plans");
  if (!Array.isArray(answer?.plans)) throw new Error("套餐列表响应格式不正确");
  return { plans: answer.plans.map(toPlan), default: answer.default };
};

export const savePlan = (plan: Plan) =>
  platformApi<Plan>("/api/platform/v1/plans", { method: "POST", body: toPlan(plan) });

export const deletePlan = (id: string) =>
  platformApi<void>(`/api/platform/v1/plans/${encodeURIComponent(id)}`, { method: "DELETE" });

export const listUsers = async (): Promise<PlatformUser[]> =>
  (await platformApi<{ users: PlatformUser[] }>("/api/platform/v1/users")).users ?? [];

export const revokeUserSessions = (org: string, userID: number) =>
  platformApi<{ revoked: number }>(
    `/api/platform/v1/organizations/${encodeURIComponent(org)}/users/${userID}/revoke`,
    { method: "POST", body: {} },
  );

export const deleteUser = (org: string, userID: number) =>
  platformApi<void>(`/api/platform/v1/organizations/${encodeURIComponent(org)}/users/${userID}`, {
    method: "DELETE",
  });

export const listAudit = async (params: { org?: string; limit?: number } = {}): Promise<AuditEvent[]> => {
  const answer = await platformApi<{ events?: AuditEvent[] }>("/api/platform/v1/audit", {
    query: { org: params.org, limit: params.limit ? String(params.limit) : undefined },
  });
  return answer.events ?? [];
};

export const listRelays = async (): Promise<PlatformRelay[]> => {
  const answer = await platformApi<{ relays: PlatformRelay[] }>("/api/platform/v1/relays");
  if (!Array.isArray(answer?.relays) || !answer.relays.every((relay) => relay && relayExecutionContract(relay))) throw new Error("中继列表响应格式不正确");
  return answer.relays;
};

export const createRelayEnrollment = (organizationID: string, body: {
  name: string;
  visibility: RelayVisibility;
  ttl_seconds: number;
}) => platformApi<RelayEnrollment>(
  `/api/platform/v1/organizations/${encodeURIComponent(organizationID)}/relays/enroll-tokens`,
  { method: "POST", body },
);

export async function getRelay(organizationID: string, relayID: string) {
  const relay = await platformApi<PlatformRelay>(`/api/platform/v1/organizations/${encodeURIComponent(organizationID)}/relays/${encodeURIComponent(relayID)}`);
  if (!relay || relay.id !== relayID || relay.organizationId !== organizationID || !Number.isSafeInteger(relay.configVersion) || relay.configVersion < 1 || !relayExecutionContract(relay)) throw new Error("中继配置响应格式不正确");
  return relay;
}

export async function listRelayHistory(organizationID: string, relayID: string) {
  const payload = await platformApi<{ items: RelayConfigurationHistory[] }>(`/api/platform/v1/organizations/${encodeURIComponent(organizationID)}/relays/${encodeURIComponent(relayID)}/history`);
  if (!Array.isArray(payload?.items) || payload.items.length > 50 || !payload.items.every((item, index) => item && Number.isSafeInteger(item.config_version) && item.config_version > 0 && ["online", "maintenance", "disabled", "revoked"].includes(item.desired_state) && Number.isSafeInteger(item.bandwidth_limit) && item.bandwidth_limit >= -1 && typeof item.region_name === "string" && typeof item.actor === "string" && typeof item.created === "string" && Number.isFinite(Date.parse(item.created)) && (index === 0 || item.config_version < payload.items[index - 1]!.config_version))) throw new Error("中继历史响应格式不正确");
  return payload.items;
}

export async function updateRelay(organizationID: string, relayID: string, body: RelayConfigUpdate) {
  const relay = await platformApi<PlatformRelay>(
    `/api/platform/v1/organizations/${encodeURIComponent(organizationID)}/relays/${encodeURIComponent(relayID)}`,
    { method: "PATCH", body },
  );
  if (!relay || relay.id !== relayID || relay.organizationId !== organizationID || relay.configVersion !== body.config_version + 1 || !relayExecutionContract(relay)) throw new Error("中继配置响应格式不正确，请刷新确认实际结果");
  return relay;
}

export const deleteRelay = (organizationID: string, relayID: string, version: number) =>
  platformApi<void>(
    `/api/platform/v1/organizations/${encodeURIComponent(organizationID)}/relays/${encodeURIComponent(relayID)}`,
    { method: "DELETE", headers: { "If-Match": String(version) } },
  );
