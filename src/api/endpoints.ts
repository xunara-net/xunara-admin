// Typed wrappers over /api/platform/v1.

import { platformApi } from "./client";
import type { AuditEvent, Organization, Plan, PlatformUser } from "./types";

export const listOrganizations = async (): Promise<Organization[]> =>
  (await platformApi<{ organizations: Organization[] }>("/api/platform/v1/organizations")).organizations ?? [];

export const getOrganization = (id: string) =>
  platformApi<Organization>(`/api/platform/v1/organizations/${encodeURIComponent(id)}`);

export const updateOrganization = (id: string, body: { name?: string }) =>
  platformApi<Organization>(`/api/platform/v1/organizations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });

export const deleteOrganization = (id: string) =>
  platformApi<void>(`/api/platform/v1/organizations/${encodeURIComponent(id)}`, { method: "DELETE" });

export const setTenantPlan = (orgID: string, planID: string) =>
  platformApi<unknown>(`/api/platform/v1/organizations/${encodeURIComponent(orgID)}/plan`, {
    method: "PATCH",
    body: { plan: planID },
  });

export const allocateTenantNetwork = (orgID: string) =>
  platformApi<{ network_prefix?: string }>(
    `/api/platform/v1/organizations/${encodeURIComponent(orgID)}/plan/allocate`,
    { method: "POST", body: {} },
  );

export const listPlans = async (): Promise<{ plans: Plan[]; default: string }> =>
  platformApi<{ plans: Plan[]; default: string }>("/api/platform/v1/plans");

export const savePlan = (plan: Plan) =>
  platformApi<Plan>("/api/platform/v1/plans", { method: "POST", body: plan });

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
