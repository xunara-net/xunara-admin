# Xunara Admin（玄序 · 平台超级管理员后台）

平台运营者的后台：租户与网段、套餐目录、全平台用户、跨租户审计、托管中继管理
与系统信息。与用户控制台**完全分离**——独立前端、独立管理员身份（恢复令牌/Passkey）、
独立 API 面（`/api/platform/v1`）。

```text
xunara-admin ──Bearer：短期管理员会话──▶ /api/platform/v1 ──▶ xunara-server
```

## 技术栈

Vue 3 + TypeScript + Vite + vue-router + Vitest（无 UI 框架依赖）。

## 安全模型

- 恢复令牌或 Passkey 登录换取四小时平台会话，只保存短期凭据到 **sessionStorage**，
  以 `Authorization: Bearer` 发送；禁用平台身份的旧部署保留明确令牌模式；
- 人类会话不使用 Cookie；WebAuthn 使用隔离的 HttpOnly 挑战 Cookie、固定 origin 和 UV，
  注册绑定发起会话。凭据操作要求最近十五分钟内登录，不接受原始平台令牌代替人类会话；
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
| `/login` | 平台恢复令牌或管理员 Passkey 登录 |
| `/security` | 独立管理员通行密钥列表、多把绑定/解绑、最后登录方式保护 |
| `/dashboard` | 平台总览：租户、用户、设备、套餐分布、最近事件 |
| `/tenants` | 租户与网络：改套餐、重新分配网段、删除托管租户 |
| `/authentication` | 按租户管理成员注册、OAuth2/OIDC 应用、密钥轮换与归档；开户入口额外管理公开开户开关 |

登录应用与个人绑定分开；租户所有者不能改平台公开开户，平台面也不依赖租户 Cookie。
密钥只经请求正文提交，接口不返回明文或密封值，前端不保存应用密钥。部署提供方
来源明确，身份域不可修改；停用最后登录方式、过期配置覆盖由后端拒绝。
详见[服务端登录设置手册](https://github.com/xunara-net/xunara-server/blob/main/docs/authentication-settings.md)。
| `/plans` | 套餐编辑器：配额与能力开关（保存即生效，无需重启） |
| `/users` | 全平台用户：添加到指定已有网络、搜索 / 状态筛选、版本保护的禁用 / 解禁、一次性密码重置码、强制下线、删除；保护最后启用 owner |
| `/audit` | 跨租户审计（按租户与条数筛选） |
| `/relays` | 托管中继列表/筛选、一次性注册令牌、版本保护的期望配置/历史恢复与删除 |
| `/system` | 系统信息与安全说明 |

中继页只显示平台注册的托管节点，不包含静态 DERP map 中的公共池；空列表不等于
没有可用 DERP。心跳在线与数据面健康分开显示，缺失统计显示未知，不用于计费。

账号禁用撤销浏览器会话，阻止新登录及该账号委托的 API 权限；解禁不恢复旧会话。
禁用不是设备 / 网络停服，独立中继、在线机器与设备 Key 不变；禁用账号仍占成员额度。
状态保存失败或冲突保留原因并要求刷新核对，不自动反转操作方向或重试。旧服务端
缺少状态 / 版本时按钮禁用。权限、API 与 Identity v16 升级以
[服务端账号状态手册](https://github.com/xunara-net/xunara-server/blob/main/docs/account-suspension.md) 为准。
远程配置在后续心跳获取；新版托管中继已实际热更并自报执行回执，旧版显示未知。
自报不等于真实客户端端到端验收，不把配置下发视为执行成功。
两个控制台共用配置版本链，冲突时保留草稿、显式确认最新基准后才能再次手动提交。
历史恢复生成新版本，不恢复凭据/遥测；已撤销身份不能重新启用。中继额度可在套餐编辑器调整。
一次性注册密钥只在当前弹窗内存中展示，关闭/离开页面即清除，不写入浏览器存储。
自动升级、灰度回滚、成本核算及实时地图尚未实现。

租户网段弹窗支持保存自定义设备池与首次自动分配；自动分配不替换已有范围。
自定义仅允许官方兼容 CGNAT 子集，服务器检查套餐、平台保留与历史冲突；不静默
修改旧设备 IP。实际/期望收敛与回退边界以服务端 ADR-0022 为准。

套餐编辑只回写套餐数据，不发送读接口的派生展示字段；中继额度缺失或格式错误时
拒绝编辑，避免把旧服务端未返回的额度覆盖为零。服务端与后台应按兼容顺序一并升级。

## 浏览器集成验收

夹具同时覆盖真实 OIDC/JWKS 和无 ID Token 的 GitLab 风格 OAuth2 授权码、S256
及当前用户接口。原生 OAuth2 覆盖邀请门禁、受邀成员、绑定/解绑、同一发起会话、
state 与事务重放、错误资料、最后登录方法和来源会话撤销，并检查手机宽度。
它不使用公网应用或生产状态，不代表第三方提供方已在正式部署启用。

前置：六仓库同级放置，已构建 `xunara-web` / `xunara-admin`，本机可运行 Chromium，
并安装 `playwright-core`（通过 `PLAYWRIGHT_MODULE` 指向模块，不要求加入运行时依赖）。
以下在 `xunara-admin` 仓库执行，不连接或修改生产环境：

```sh
test_binary="$(mktemp -d)/xunarad"
(cd ../xunara-server && go build -o "$test_binary" ./cmd/xunarad)
SMOKE_XUNARAD="$test_binary" PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
  CHROMIUM_BINARY=/absolute/path/to/chromium node scripts/browser-smoke.cjs
SMOKE_XUNARAD="$test_binary" PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
  CHROMIUM_BINARY=/absolute/path/to/chromium node scripts/authentication-browser-smoke.cjs
```

第二个脚本额外需要 `openssl`；生成隔离的一日 HTTPS 证书，只信任本次证书公钥，
不修改系统 CA。覆盖所有者配置邀请、真实受邀注册、公开独立开户、平台开关、
提供方创建/密钥轮换/归档、租户隔离、版本冲突与 320 / 390 / 768px 弹窗。
不连接公网 IdP；临时数据库、密钥和应用凭据在结束时清理。

此脚本还验证密码恢复的核实确认、取消无写入、版本冲突 / 显式刷新、一次性码不
进入持久存储或 URL、生成 / 兑换必需审计的真实故障回滚、重启持久化与新旧密码。
后台生成不改密码、不退出登录；用户在本网络 `/reset-password` 输入码后才兑换。
关闭弹窗清除本页原码，只能读取待用期限；核实身份和交付渠道由平台运营者负责，
不使用未验证邮箱自动找回。流程与 identity v17 升级以
[服务端手册](https://github.com/xunara-net/xunara-server/blob/main/docs/password-recovery.md) 为准。

脚本使用隔离临时租户、自动生成内存凭据，覆盖登录存储故障与恢复、租户统计及套餐切换、注册令牌不落存储、
中继接入/心跳/配置、危险操作确认、配额拒绝保留身份、删除使长期身份失效、加载重试和
移动端布局；另验证用户侧托管中继的数据来源、四类网络读取故障与恢复、成员角色
只允许 owner 编辑、最后 owner 保护、取消/写入失败保留原值，以及成员读取失败不退空值。
角色取消/失败使用标明的注入夹具，不宣称浏览器完成了真实后端改角色。
追加成员邀请真实创建/注册/撤销、Free 配额、角色/CSRF、代码清除、故障恢复与移动布局；
隔离本地 OIDC 发行方真实签发 RSA ID Token，验证同源 SPA 入口、固定回调、PKCE、
签名/nonce、浏览器绑定/state/重放、产品/后端回跳和旧提供方书签。发行方确认页
让测试显式停在回调前，不依赖 Playwright 对 302 链中间请求的拦截。

网络控制台回归复用 `../xunara-web/scripts/network-browser-smoke.cjs`，在 Node 22 的
隔离 SQLite 状态创建设备夹具，验证图形规则、真实编译器模拟、跨页权限矩阵、
自检失败、CAS 冲突保留草稿、历史恢复、DNS 写入/保护/重载、私有中继令牌清理与
成员只读边界；手机抽屉核对焦点、背景滚动及 320 / 390 / 768px 横向布局。
设备夹具不代表浏览器完成官方客户端注册或真实网络发包，协议验收由服务端测试负责。
可选设置 `SMOKE_ARTIFACT_DIR` 保存无凭据的隔离 ACL 页面截图，不截取令牌弹窗。
地址/外部中继回归复用 `../xunara-web/scripts/address-relay-browser-smoke.cjs`，核对
默认地区首屏、七种下载、公共地图持久化/冲突/删除、网段预览与旧设备保持、单设备
IP 冲突保留草稿及成员只读；不使用生产凭据做写入测试。
新增初始化单次认领 / 残留令牌重放，以及登录配置 503、畸形响应、重试恢复验收。
中继历史回归复用 `../xunara-web/scripts/relay-history-browser-smoke.cjs`，验证跨后台并发冲突、
保留草稿/显式新基准、取消与确认恢复、最近 50 项历史、手机长弹窗滚动与键盘焦点。
三十八阶段结束时清理临时状态；不会连公网提供方或修改生产用户，不代表真实设备
审批、双客户端 DERP 转发、生产 HTTPS 或全平台兼容。

## 部署

管理员认证需要可信 HTTPS 域名。首次使用平台恢复令牌登录，到“管理员安全”绑定
手机、电脑或安全密钥。解绑撤销全部管理员 Passkey 会话；恢复令牌仍可登录。
目前只有一个部署运营者身份，不代表多管理员 RBAC 或 TOTP 已完成。
添加用户按所选网络成员额度校验，不开户、不代登录，密码只用于本次提交并在关闭后清理。
配置、独立身份文件备份与 API 以
[服务端手册](https://github.com/xunara-net/xunara-server/blob/main/docs/platform-administrator.md) 为准。

先升级服务端，再升级后台前端；新版后台需要认证状态接口，故障时不盲目降级。

新增浏览器回归 `scripts/platform-account-browser-smoke.cjs` 使用独立临时数据库、
隔离 HTTPS 和 Chromium 虚拟认证器，不使用生产凭据。执行目录为本仓库，前置条件
与“测试”中的浏览器回归一致，设置 `SMOKE_XUNARAD`、`PLAYWRIGHT_MODULE`、
`CHROMIUM_BINARY` 后执行 `node scripts/platform-account-browser-smoke.cjs`。

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
