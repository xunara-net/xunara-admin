// Platform API wire types (mirrors xunara-server's control/platform*.go).

export interface OrgStats {
  users: number;
  nodes: number;
  online: number;
  pendingDevices: number;
  policyLoaded: boolean;
  plan?: string;
  planName?: string;
  deviceLimit?: number;
  networkPrefix?: string;
  relays: number;
  relaysOnline: number;
}

export interface Organization {
  id: string;
  name: string;
  domains?: string[];
  managed: boolean;
  stats: OrgStats;
}

// 线上字段保持服务端的 snake_case；只在适配层转换为页面使用的 camelCase。
export interface OrganizationPayload extends Omit<Organization, "stats"> {
  stats: {
    users: number;
    nodes: number;
    online: number;
    pending_devices: number;
    policy_loaded: boolean;
    plan?: string;
    plan_name?: string;
    device_limit?: number;
    network_prefix?: string;
    relays: number;
    relays_online: number;
  };
}

export interface Plan {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  billing_cycle: string;
  max_devices: number;
  max_users: number;
  max_routes: number;
  max_auth_keys: number;
  max_relays: number;
  allow_custom_cidr: boolean;
  allow_exit_node: boolean;
  allow_subnet_router: boolean;
  allow_api: boolean;
  allow_acl: boolean;
  allow_grants: boolean;
  allow_custom_dns: boolean;
  allow_audit_log: boolean;
  allow_multi_member: boolean;
}

export interface PlatformUser {
  org: string;
  orgName: string;
  id: number;
  login: string;
  displayName: string;
  email: string;
  role: string;
  plan: string;
  sessions: number;
  lastSeen?: string;
  createdAt: string;
}

export interface AuditEvent {
  org?: string;
  orgName?: string;
  action: string;
  actor: string;
  target?: string;
  detail?: string;
  at?: string;
  time?: string;
}

export type RelayVisibility = "private" | "organization" | "public";
export type RelayDesiredState = "online" | "maintenance" | "disabled" | "revoked";

export interface PlatformRelay {
  organizationId: string;
  organizationName?: string;
  id: string;
  name: string;
  hostname?: string;
  regionCode?: string;
  regionName?: string;
  version?: string;
  derpPort?: number;
  stunPort?: number;
  visibility: RelayVisibility;
  desiredState: RelayDesiredState;
  configVersion: number;
  bandwidthLimit: number;
  healthy: boolean;
  online: boolean;
  uptimeSeconds?: number;
  connectedClients?: number;
  bytesIn?: number;
  bytesOut?: number;
  createdAt?: string;
  lastSeen?: string;
}

export interface RelayEnrollment {
  token: string;
  item: {
    id: string;
    name?: string;
    visibility: RelayVisibility;
    expiresAt?: string;
    used: boolean;
    expired: boolean;
  };
}

export type RelayConfigUpdate = { config_version: number } & (
  { desired_state: RelayDesiredState; bandwidth_limit: number; region_name: string; restore_from?: never } |
  { restore_from: number; desired_state?: never; bandwidth_limit?: never; region_name?: never }
);

export interface RelayConfigurationHistory {
  config_version: number;
  desired_state: RelayDesiredState;
  bandwidth_limit: number;
  region_name: string;
  actor: string;
  created: string;
}
