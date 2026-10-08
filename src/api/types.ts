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
}

export interface Organization {
  id: string;
  name: string;
  domains?: string[];
  managed: boolean;
  stats: OrgStats;
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
