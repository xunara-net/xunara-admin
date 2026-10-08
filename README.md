# Xunara Admin（玄序 · 平台超级管理员后台）

平台运营者的后台：租户与网段、套餐目录、全平台用户、跨租户审计、中继路线图
与系统信息。与用户控制台**完全分离**——独立前端、独立凭据（平台管理令牌）、
独立 API 面（`/api/platform/v1`）。

```text
xunara-admin ──Bearer：平台管理令牌──▶ /api/platform/v1 ──▶ xunara-server
```

## 技术栈

Vue 3 + TypeScript + Vite + vue-router + Vitest（无 UI 框架依赖）。

## 安全模型

- 平台令牌由运营者在登录页输入，只保存在 **sessionStorage**（关闭标签页即失效），
  以 `Authorization: Bearer` 发送；
- 不使用 Cookie，因此没有 CSRF 面；令牌不写入 URL、不写入日志；
- 任何 401/403 都会立即清空本地令牌，避免“看起来能用”的陈旧会话；
- 平台面与租户面互不信任：租户会话在平台 API 上无效，平台令牌也进不了租户控制台。

## 开发 / 构建

```bash
npm install
npm run dev        # http://localhost:5174，代理 /api 到 http://127.0.0.1:8080
npm run typecheck
npm run test
npm run build      # 产物在 dist/（base=/admin/），由 xunara-deploy 的 nginx 托管
```

## 页面

| 路由 | 页面 |
| --- | --- |
| `/login` | 平台令牌登录 |
| `/dashboard` | 平台总览：租户、用户、设备、套餐分布、最近事件 |
| `/tenants` | 租户与网络：改套餐、重新分配网段、删除托管租户 |
| `/plans` | 套餐编辑器：配额与能力开关（保存即生效，无需重启） |
| `/users` | 全平台用户：搜索、强制下线、删除（含最后一名所有者保护） |
| `/audit` | 跨租户审计（按租户与条数筛选） |
| `/relays` | 中继平台路线与部署指引（服务端接口实现中） |
| `/system` | 系统信息与安全说明 |

## 部署

`xunara-deploy` 的 nginx 把 `/admin/` 映射到本仓库的 `dist/`，并保证
`/api/platform/v1` 同源反代到 `xunara-server`。

## 仓库关系

| 仓库 | 职责 |
| --- | --- |
| `xunara-admin` | 平台超级管理员后台（本仓库） |
| `xunara-web` | 用户控制台 |
| `xunara-server` | 控制面 + 产品后端 + Core API |
| `xunara-relay` | 中继（DERP/STUN） |
| `xunara-deploy` | 部署与编排 |
| `xunara-docs` | 规范与文档 |
