# Xunara Admin（玄序 · 平台超级管理员后台）

平台运营者的后台：租户与网段、套餐目录、全平台用户、跨租户审计、托管中继管理
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
- 401 清空失效的平台令牌；403 展示权限或配额拒绝，不误清仍有效的身份；
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
| `/relays` | 托管中继列表/筛选、一次性注册令牌、期望状态/限速/区域名、删除 |
| `/system` | 系统信息与安全说明 |

中继页只显示平台注册的托管节点，不包含静态 DERP map 中的公共池；空列表不等于
没有可用 DERP。心跳在线与数据面健康分开显示，缺失统计显示未知，不用于计费。
远程配置在后续心跳获取，不保证离线中继即时应用。中继额度可在套餐编辑器调整。
一次性注册密钥只在当前弹窗内存中展示，关闭/离开页面即清除，不写入浏览器存储。
自动升级、灰度回滚、成本核算及实时地图尚未实现。

## 浏览器集成验收

前置：六仓库同级放置，已构建 `xunara-web` / `xunara-admin`，本机可运行 Chromium，
并安装 `playwright-core`（通过 `PLAYWRIGHT_MODULE` 指向模块，不要求加入运行时依赖）。
以下在 `xunara-admin` 仓库执行，不连接或修改生产环境：

```sh
test_binary="$(mktemp -d)/xunarad"
(cd ../xunara-server && go build -o "$test_binary" ./cmd/xunarad)
SMOKE_XUNARAD="$test_binary" PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
  CHROMIUM_BINARY=/absolute/path/to/chromium node scripts/browser-smoke.cjs
```

脚本使用隔离临时租户、自动生成内存凭据，覆盖登录存储故障与恢复、租户统计及套餐切换、注册令牌不落存储、
中继接入/心跳/配置、危险操作确认、配额拒绝保留身份、删除使长期身份失效、加载重试和
移动端布局；结束时清理临时状态。它验证管理面，不代表双客户端 DERP 转发或全平台兼容。

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
