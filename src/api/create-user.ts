import { platformApi } from "./client";

export interface CreateUserInput { login: string; display_name: string; email: string; password: string; role: "member" | "admin" | "owner" }
export async function createUser(org: string, input: CreateUserInput) {
  if (!org || !input.login.trim() || !["member", "admin", "owner"].includes(input.role)) throw new Error("请选择网络、填写用户名并选择角色");
  const result = await platformApi<{ org: string; id: number; login: string; role: string }>(`/api/platform/v1/organizations/${encodeURIComponent(org)}/users`, { method: "POST", body: input });
  if (result?.org !== org || !Number.isSafeInteger(result.id) || result.id < 1 || result.login !== input.login.trim().toLowerCase() || result.role !== input.role) throw new Error("创建确认响应无效，请刷新用户列表核对实际结果");
  return result;
}
