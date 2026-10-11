const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const binary = process.env.SMOKE_XUNARAD;
const webDist = path.resolve(__dirname, '../../xunara-web/dist');
const adminDist = path.resolve(__dirname, '../dist');
if (!binary || !fs.existsSync(binary) || !fs.existsSync(path.join(webDist, 'index.html')) || !fs.existsSync(path.join(adminDist, 'index.html'))) throw new Error('Build all three repositories and set SMOKE_XUNARAD');
process.umask(0o077);
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'xunara-authentication-smoke-'));
const platformToken = crypto.randomBytes(32).toString('base64url');
const password = crypto.randomBytes(24).toString('base64url');
const providerSecret = crypto.randomBytes(32).toString('base64url');
const rotatedSecret = crypto.randomBytes(32).toString('base64url');
const errors = [];
const completed = [];
let daemon, browser, proxy, origin, control;
let stage = 'startup';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function mark(value) { stage = value; completed.push(value); console.log(JSON.stringify({ stage: value })); }
async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
function launchDaemon(daemonArguments) {
	const log = fs.openSync(path.join(state, 'daemon.log'), 'a', 0o600);
	const child = spawn(binary, daemonArguments, { env: { ...process.env, XUNARA_PLATFORM_ADMIN_TOKEN: platformToken }, stdio: ['ignore', log, log] });
	fs.closeSync(log);
	return child;
}
function serve(request, response) {
  const pathname = new URL(request.url, origin).pathname;
  if (/^\/(api|health|console|setup|oidc|oauth2)(\/|$)/.test(pathname) || pathname.startsWith('/register/')) {
    const upstream = http.request(control + request.url, { method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
    });
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream); return;
  }
  const admin = pathname.startsWith('/admin/');
  const dist = admin ? adminDist : webDist;
  const assetPath = admin ? pathname.slice('/admin'.length) : pathname;
  const asset = assetPath.startsWith('/assets/') ? path.resolve(dist, '.' + assetPath) : path.join(dist, 'index.html');
  if (!asset.startsWith(dist + path.sep) || !fs.existsSync(asset)) { response.writeHead(404); response.end(); return; }
  const extension = path.extname(asset);
  response.writeHead(200, { 'Content-Type': extension === '.js' ? 'application/javascript' : extension === '.css' ? 'text/css' : 'text/html; charset=utf-8' });
  fs.createReadStream(asset).pipe(response);
}
async function api(endpoint, body, method = 'GET') {
  return backend(endpoint, { method,
    headers: { Authorization: 'Bearer ' + platformToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
function backend(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(control + endpoint, { method: options.method || 'GET', headers: { ...options.headers, Host: new URL(origin).host } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; if (text.length > 1 << 20) request.destroy(new Error('oversized test response')); });
      response.on('end', () => resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        text: async () => text, json: async () => JSON.parse(text) }));
      response.on('error', reject);
    });
    request.setTimeout(15000, () => request.destroy(new Error('test request timed out')));
    request.on('error', reject); request.end(options.body);
  });
}
async function browserAPI(page, endpoint, options = {}) {
  const result = await page.evaluate(async ({ endpoint, options }) => {
    const response = await fetch(endpoint, { method: options.method || 'GET', credentials: 'same-origin',
      headers: { ...options.headers, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    return { status: response.status, text: await response.text() };
  }, { endpoint, options });
  return { status: () => result.status, text: async () => result.text, json: async () => JSON.parse(result.text) };
}
async function assertPrivateInputNotStored(page) {
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(storage.includes(providerSecret), false);
  assert.equal(storage.includes(rotatedSecret), false);
  assert.equal(page.url().includes(providerSecret), false);
  assert.equal((await page.locator('body').innerText()).includes(providerSecret), false);
  assert.equal((await page.locator('body').innerText()).includes(rotatedSecret), false);
}
function privateDatabaseSnapshot() {
  const database = new DatabaseSync(path.join(state, 'portal/state.db'), { readOnly: true });
  try {
    const row = database.prepare('SELECT payload FROM authentication_config WHERE id = 1').get();
    const payload = Buffer.from(row.payload).toString('utf8');
    assert.equal(payload.includes(providerSecret), false);
    assert.equal(payload.includes(rotatedSecret), false);
    return JSON.parse(payload);
  } finally { database.close(); }
}
async function main() {
  const keyFile = path.join(state, 'test-key.pem');
  const certFile = path.join(state, 'test-cert.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyFile, '-out', certFile,
    '-subj', '/CN=control.example.test', '-addext', 'subjectAltName=DNS:control.example.test,DNS:*.example.test'], { stdio: 'ignore' });
  assert.equal(generated.status, 0);
  fs.chmodSync(keyFile, 0o600);
  const certificate = fs.readFileSync(certFile);
  const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  proxy = https.createServer({ key: fs.readFileSync(keyFile), cert: certificate }, serve);
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  origin = `https://control.example.test:${proxy.address().port}`;
  const controlPort = await unusedPort();
  control = `http://127.0.0.1:${controlPort}`;
  const orgConfig = path.join(state, 'organizations.json');
  fs.writeFileSync(orgConfig, JSON.stringify({ organizations: [{ id: 'portal', name: '认证管理验收', domains: ['control.example.test'],
    server_url: origin, state_dir: path.join(state, 'portal'), registration: 'open', allow_local_login: true }],
    self_service: { site: 'portal', domain_suffix: 'example.test', scheme: 'https', port: String(proxy.address().port), cookie_domain: 'example.test', plan: 'free' } }), { mode: 0o600 });
  // 全部凭据只在临时内存、环境或请求正文；不连接真实 IdP，也不使用线上数据库。
  const daemonArguments = ['-listen', `127.0.0.1:${controlPort}`, '-grpc-listen', '127.0.0.1:0', '-org-config', orgConfig,
    '-platform-state-dir', state, '-plans', 'builtin', '-network-pool', '100.100.0.0/16', '-log-level', 'error'];
  daemon = launchDaemon(daemonArguments);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
    if (daemon.exitCode !== null) throw new Error('isolated daemon exited');
    await sleep(100);
  }
  assert.equal(ready, true);
  await new Promise((resolve, reject) => {
    https.get(origin + '/health', { ca: certificate, lookup: (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4) }, (response) => {
      assert.equal(response.statusCode, 200); response.resume(); response.once('end', resolve);
    }).once('error', reject);
  });
  const setupPage = await api('/setup');
  const markup = await setupPage.text();
  const formMatch = /name="_csrf" value="([^"]+)"/.exec(markup);
  console.log(JSON.stringify({ setupStatus: setupPage.status, csrfFormPresent: !!formMatch }));
  assert.equal(setupPage.status, 200); assert.equal(!!formMatch, true);
  const initialized = await backend('/setup', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: fs.readFileSync(path.join(state, 'portal/setup-token'), 'utf8').trim(),
      _csrf: formMatch[1], login: 'authentication-owner', password, confirm: password }).toString() });
  assert.equal(initialized.status, 302);
  assert.equal((await api('/api/platform/v1/organizations/portal/plan', { plan_id: 'pro' }, 'PATCH')).status, 200);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BINARY || undefined, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--host-resolver-rules=MAP *.example.test 127.0.0.1', '--ignore-certificate-errors-spki-list=' + spki] });
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  ownerPage.on('pageerror', (error) => errors.push(error.name));
  await ownerPage.goto(origin + '/login');
  await ownerPage.getByLabel('登录名', { exact: true }).fill('authentication-owner');
  await ownerPage.getByLabel('密码', { exact: true }).fill(password);
  await ownerPage.getByRole('button', { name: '登录', exact: true }).click();
  await ownerPage.waitForURL('**/dashboard');

  mark('owner-configures-invites-without-changing-public-tenant-signup');
  await ownerPage.goto(origin + '/members');
  await ownerPage.getByText('当前网络未开启成员邀请', { exact: false }).waitFor();
  await ownerPage.getByRole('link', { name: '注册设置', exact: true }).click();
  await ownerPage.getByLabel('当前网络注册策略', { exact: true }).selectOption('invite');
  await ownerPage.getByRole('button', { name: '保存注册设置', exact: true }).click();
  await ownerPage.getByText('注册设置已生效', { exact: false }).waitFor();
  const providerInfo = await api('/api/v1/auth/providers').then((response) => response.json());
  assert.equal(providerInfo.registration, 'open'); assert.equal(providerInfo.member_registration, 'invite');
  await ownerPage.goto(origin + '/members');
  await ownerPage.getByRole('button', { name: '创建成员邀请', exact: true }).click();
  await ownerPage.getByRole('button', { name: '生成一次性邀请码', exact: true }).click();
  const inviteCode = await ownerPage.getByLabel('一次性邀请码', { exact: true }).inputValue();
  const inviteURL = await ownerPage.getByLabel('注册页面（不含邀请码）', { exact: true }).inputValue();
  assert.equal(inviteURL, origin + '/register?mode=invite'); assert.equal(inviteURL.includes(inviteCode), false);
  await ownerPage.getByRole('button', { name: '关闭并清除代码', exact: true }).click();
  const invitedContext = await browser.newContext();
  const invitedPage = await invitedContext.newPage();
  invitedPage.on('pageerror', (error) => errors.push(error.name));
  await invitedPage.goto(inviteURL);
  await invitedPage.getByLabel('邀请码', { exact: true }).fill(inviteCode);
  await invitedPage.getByLabel('登录名', { exact: true }).fill('invited-member');
  await invitedPage.getByLabel('密码', { exact: true }).fill(password);
  await invitedPage.getByRole('button', { name: '注册并登录', exact: true }).click();
  await invitedPage.waitForURL('**/dashboard');
  assert.equal((await api('/api/platform/v1/organizations').then((response) => response.json())).organizations.length, 1);
  await invitedPage.goto(origin + '/authentication');
  await invitedPage.getByText('只有网络所有者可以修改', { exact: false }).waitFor();

  mark('public-signup-still-provisions-an-independent-network');
  const newContext = await browser.newContext();
  const newPage = await newContext.newPage();
  newPage.on('pageerror', (error) => errors.push(error.name));
  await newPage.goto(origin + '/register');
  assert.equal(await newPage.getByLabel('邀请码', { exact: true }).count(), 0);
  await newPage.getByLabel('登录名', { exact: true }).fill('separate-network');
  await newPage.getByLabel('密码', { exact: true }).fill(password);
  await newPage.getByRole('button', { name: '免费创建账户', exact: true }).click();
  await newPage.waitForURL((url) => url.hostname === 'separate-network.example.test' && url.pathname === '/dashboard');
  assert.equal((await api('/api/platform/v1/organizations').then((response) => response.json())).organizations.length, 2);

  mark('runtime-provider-create-callback-encryption-and-mobile-modal');
  await ownerPage.goto(origin + '/authentication');
  await ownerPage.getByRole('button', { name: '添加登录提供方', exact: true }).click();
  await ownerPage.locator('#provider-id').fill('github-browser');
  await ownerPage.locator('#provider-name').fill('GitHub 验收');
  await ownerPage.locator('#provider-client-id').fill('application-fixture-id');
  await ownerPage.locator('#provider-client-secret').fill(providerSecret);
  assert.equal(await ownerPage.locator('#provider-callback').inputValue(), origin + '/oauth2/callback/github-browser');
  for (const width of [320, 390, 768]) {
    await ownerPage.setViewportSize({ width, height: 844 });
    assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await ownerPage.getByRole('button', { name: '保存登录提供方', exact: true }).click();
  await ownerPage.getByRole('dialog').waitFor({ state: 'detached' });
  await assertPrivateInputNotStored(ownerPage);
  assert.equal(fs.statSync(path.join(state, 'portal/authentication_secret.key')).mode & 0o777, 0o600);
  assert.equal(privateDatabaseSnapshot().providers[0].enabled, false);
  await ownerPage.getByRole('button', { name: '启用', exact: true }).click();
  await ownerPage.getByText('登录提供方已启用。', { exact: true }).waitFor();
  const loggedOut = await browser.newPage();
  await loggedOut.goto(origin + '/login');
  await loggedOut.getByRole('link', { name: '使用 GitHub 验收 登录', exact: true }).waitFor();
  // 只验收真实配置入口；没有伪造公共应用凭据，也不向公网 IdP 发起登录。
  await loggedOut.close();
  await ownerPage.getByRole('button', { name: '名称 / 密钥轮换', exact: true }).click();
  await ownerPage.locator('#provider-name').fill('GitHub 已轮换');
  await ownerPage.locator('#provider-client-secret').fill(rotatedSecret);
  await ownerPage.getByRole('button', { name: '保存登录提供方', exact: true }).click();
  await ownerPage.getByRole('dialog').waitFor({ state: 'detached' });
  await assertPrivateInputNotStored(ownerPage);
  assert.equal(privateDatabaseSnapshot().providers[0].display_name, 'GitHub 已轮换');
  await ownerPage.getByRole('button', { name: '添加登录提供方', exact: true }).click();
  await ownerPage.locator('#provider-type').selectOption('oidc');
  await ownerPage.locator('#provider-id').fill('blocked-private-issuer');
  await ownerPage.locator('#provider-name').fill('禁止的内网发行方');
  await ownerPage.locator('#provider-issuer').fill('https://127.0.0.1');
  await ownerPage.locator('#provider-client-id').fill('fixture-id');
  await ownerPage.locator('#provider-client-secret').fill(providerSecret);
  const blocked = ownerPage.waitForResponse((response) => response.url().endsWith('/authentication/providers') && response.request().method() === 'POST');
  await ownerPage.getByRole('button', { name: '保存登录提供方', exact: true }).click();
  assert.equal((await blocked).status(), 400);
  await ownerPage.getByRole('dialog').getByRole('alert').waitFor();
  assert.equal(await ownerPage.locator('#provider-client-secret').inputValue(), '');
  await ownerPage.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(privateDatabaseSnapshot().providers.length, 1);

  mark('platform-public-signup-switch-and-per-tenant-provider-isolation');
  const adminPage = await browser.newPage();
  adminPage.on('pageerror', (error) => errors.push(error.name));
  await adminPage.goto(origin + '/admin/login');
  await adminPage.getByLabel('平台管理令牌', { exact: true }).fill(platformToken);
  await adminPage.getByRole('button', { name: '进入后台', exact: true }).click();
  await adminPage.waitForURL('**/admin/dashboard');
  await adminPage.goto(origin + '/admin/authentication?org=portal');
  await adminPage.getByLabel('允许访客注册账户并创建独立网络', { exact: true }).uncheck();
  await adminPage.getByRole('button', { name: '保存注册设置', exact: true }).click();
  await adminPage.getByText('注册设置已生效', { exact: false }).waitFor();
  const closedInfo = await api('/api/v1/auth/providers').then((response) => response.json());
  assert.equal(closedInfo.registration, 'closed'); assert.equal(closedInfo.member_invitations, true);
  await adminPage.getByLabel('选择租户', { exact: true }).selectOption('separate-network');
  await adminPage.getByText('还没有配置第三方登录。', { exact: false }).waitFor();
  assert.equal(await adminPage.getByLabel('允许访客注册账户并创建独立网络', { exact: true }).count(), 0);
  await adminPage.getByLabel('选择租户', { exact: true }).selectOption('portal');
  await adminPage.getByText('GitHub 已轮换', { exact: true }).waitFor();
  await ownerPage.reload();
  await ownerPage.getByRole('button', { name: '名称 / 密钥轮换', exact: true }).click();
  await ownerPage.locator('#provider-name').fill('GitHub 最新版本');
  await ownerPage.getByRole('button', { name: '保存登录提供方', exact: true }).click();
  await ownerPage.getByRole('dialog').waitFor({ state: 'detached' });
  adminPage.once('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: '停用', exact: true }).click();
  await adminPage.getByRole('alert').filter({ hasText: '已被其他管理员修改' }).waitFor();
  await adminPage.getByRole('button', { name: '刷新设置', exact: true }).click();
  await adminPage.getByText('GitHub 最新版本', { exact: true }).waitFor();
  adminPage.once('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: '停用', exact: true }).click();
  await adminPage.getByText('登录提供方已停用', { exact: false }).waitFor();
  adminPage.once('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: '归档', exact: true }).click();
  await adminPage.getByText('提供方已归档，身份记录保留。', { exact: true }).waitFor();
  const archived = privateDatabaseSnapshot().providers[0];
  assert.equal(archived.archived, true); assert.equal(archived.sealed_secret, undefined);
  for (const width of [320, 390, 768]) {
    await adminPage.setViewportSize({ width, height: 844 });
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  mark('oidc-public-client-runtime-without-an-application-secret');
  await adminPage.getByRole('button', { name: '添加登录提供方', exact: true }).click();
  await adminPage.locator('#provider-type').selectOption('oidc');
  await adminPage.locator('#provider-id').fill('public-oidc');
  await adminPage.locator('#provider-name').fill('企业 OIDC 公共客户端');
  await adminPage.locator('#provider-issuer').fill('https://1.1.1.1');
  await adminPage.locator('#provider-client-id').fill('public-client-id');
  assert.equal(await adminPage.locator('#provider-client-secret').inputValue(), '');
  assert.equal(await adminPage.locator('#provider-client-secret').evaluate((input) => input.required), false);
  assert.equal(await adminPage.locator('#provider-callback').inputValue(), origin + '/oidc/callback/public-oidc');
  await adminPage.getByLabel('保存后立即启用', { exact: false }).check();
  const publicClientCreation = adminPage.waitForResponse((response) => response.url().endsWith('/authentication/providers') && response.request().method() === 'POST');
  await adminPage.getByRole('button', { name: '保存登录提供方', exact: true }).click();
  const publicClientResponse = await publicClientCreation;
  assert.equal(publicClientResponse.status(), 201);
  const publicClient = (await publicClientResponse.json()).providers.find((provider) => provider.id === 'public-oidc');
  assert.equal(publicClient.secret_configured, false);
  assert.equal(publicClient.enabled, true);
  await adminPage.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(privateDatabaseSnapshot().providers.find((provider) => provider.id === 'public-oidc').sealed_secret, undefined);
  adminPage.once('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: '归档', exact: true }).click();
  await adminPage.getByText('提供方已归档，身份记录保留。', { exact: true }).waitFor();
  await ownerPage.goto(origin + '/authentication');
  await ownerPage.getByText('已归档的提供方', { exact: false }).waitFor();
  await assertPrivateInputNotStored(adminPage);

  mark('platform-account-status-cancellation-version-conflict-and-mobile');
  await adminPage.goto(origin + '/admin/users');
  const memberRow = () => adminPage.locator('tbody tr').filter({ hasText: 'invited-member' });
  const ownerRow = adminPage.locator('tbody tr').filter({ hasText: 'authentication-owner' });
  await ownerRow.waitFor();
  assert.equal(await ownerRow.getByRole('button', { name: '禁用', exact: true }).isDisabled(), true);
  const list = await api('/api/platform/v1/users').then((response) => response.json());
  const member = list.users.find((user) => user.org === 'portal' && user.login === 'invited-member');
  const owner = list.users.find((user) => user.org === 'portal' && user.login === 'authentication-owner');
  assert.equal(typeof member.updatedAt, 'string');
  const statusPath = `/api/platform/v1/organizations/portal/users/${member.id}/status`;
  await memberRow().getByRole('button', { name: '禁用', exact: true }).click();
  await adminPage.getByLabel('操作原因（必填）', { exact: true }).fill('核对注册资料');
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await api('/api/platform/v1/users').then((response) => response.json())).users.find((user) => user.org === 'portal' && user.id === member.id).disabled, false);
  await memberRow().getByRole('button', { name: '禁用', exact: true }).click();
  await adminPage.getByLabel('操作原因（必填）', { exact: true }).fill('核对注册资料');
  for (const width of [320, 390, 768]) {
    await adminPage.setViewportSize({ width, height: 844 });
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const box = await adminPage.getByRole('dialog').boundingBox();
    assert.equal(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 845, true);
  }
  const account = await browserAPI(ownerPage, '/api/v1/account').then((response) => response.json());
  const profile = await browserAPI(ownerPage, `/api/v1/users/${member.id}`, {
    method: 'PATCH', headers: { 'X-CSRF-Token': account.csrf_token }, body: { displayName: '注册资料待复核', expectedUpdatedAt: member.updatedAt },
  });
  assert.equal(profile.status(), 200);
  const conflicted = adminPage.waitForResponse((response) => response.url().endsWith('/status') && response.request().method() === 'PATCH');
  await adminPage.getByRole('button', { name: '确认禁用', exact: true }).click();
  assert.equal((await conflicted).status(), 409);
  await adminPage.getByRole('alert').filter({ hasText: '账号已被其他操作修改' }).waitFor();
  assert.equal(await adminPage.getByLabel('操作原因（必填）', { exact: true }).inputValue(), '核对注册资料');
  assert.equal(await adminPage.getByRole('button', { name: '确认禁用', exact: true }).isDisabled(), true);
  await adminPage.getByRole('button', { name: '刷新核对账号', exact: true }).click();
  await adminPage.getByText('已刷新实际状态，请核对后再次确认操作', { exact: true }).waitFor();
  const disabledResponse = adminPage.waitForResponse((response) => response.url().endsWith('/status') && response.request().method() === 'PATCH');
  await adminPage.getByRole('button', { name: '确认禁用', exact: true }).click();
  const disabled = await disabledResponse;
  assert.equal(disabled.status(), 200); assert.equal((await disabled.json()).revoked, 1);
  await adminPage.getByRole('dialog').waitFor({ state: 'detached' });
  await memberRow().getByText('已禁用', { exact: true }).waitFor();
  await adminPage.getByLabel('账号状态筛选', { exact: true }).selectOption('disabled');
  assert.equal(await adminPage.locator('tbody tr').count(), 1);
  await adminPage.getByLabel('账号状态筛选', { exact: true }).selectOption('all');

  mark('disabled-account-cookie-password-and-last-active-owner-boundaries');
  await ownerPage.goto(origin + '/members');
  await ownerPage.locator('tbody tr').filter({ hasText: 'invited-member' }).getByText('已禁用', { exact: true }).waitFor();
  assert.equal((await ownerPage.locator('tbody tr').filter({ hasText: 'invited-member' }).innerText()).includes('核对注册资料'), false);
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 401);
  const rejected = await browserAPI(invitedPage, '/api/v1/auth/login', { method: 'POST', body: { login: 'invited-member', password } });
  assert.equal(rejected.status(), 401); assert.equal((await rejected.text()).includes('disabled'), false);
  assert.equal((await browserAPI(ownerPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(newPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(ownerPage, statusPath, { method: 'PATCH', body: { disabled: false, reason: '不允许的租户调用', expected_updated_at: member.updatedAt } })).status(), 401);
  const lastOwner = await api(`/api/platform/v1/organizations/portal/users/${owner.id}/status`, { disabled: true, reason: '检查最后所有者保护', expected_updated_at: owner.updatedAt }, 'PATCH');
  assert.equal(lastOwner.status, 409); assert.equal((await lastOwner.text()).includes('LAST_ACTIVE_OWNER'), true);

  mark('account-status-required-audit-failure-rolls-back-and-keeps-the-draft');
  const database = new DatabaseSync(path.join(state, 'portal/state.db'));
  let disabledFact;
  try {
    disabledFact = database.prepare('SELECT CAST(updated_at AS TEXT) AS revision, disabled_reason, CAST(disabled_at AS TEXT) AS disabled_at FROM users WHERE id = ?').get(member.id);
    database.exec("CREATE TRIGGER status_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action = 'user.enabled' BEGIN SELECT RAISE(ABORT, 'isolated status audit unavailable'); END");
  } finally { database.close(); }
  await memberRow().getByRole('button', { name: '解禁', exact: true }).click();
  await adminPage.getByLabel('操作原因（必填）', { exact: true }).fill('复核通过');
  const failed = adminPage.waitForResponse((response) => response.url().endsWith('/status') && response.request().method() === 'PATCH');
  await adminPage.getByRole('button', { name: '确认解禁', exact: true }).click();
  assert.equal((await failed).status(), 503);
  await adminPage.getByRole('alert').filter({ hasText: '提交结果需刷新核对' }).waitFor();
  assert.equal(await adminPage.getByLabel('操作原因（必填）', { exact: true }).inputValue(), '复核通过');
  assert.equal(await adminPage.getByRole('button', { name: '确认解禁', exact: true }).isDisabled(), true);
  const checked = new DatabaseSync(path.join(state, 'portal/state.db'));
  try {
    assert.deepEqual(checked.prepare('SELECT CAST(updated_at AS TEXT) AS revision, disabled_reason, CAST(disabled_at AS TEXT) AS disabled_at FROM users WHERE id = ?').get(member.id), disabledFact);
    checked.exec('DROP TRIGGER status_audit_failure');
  } finally { checked.close(); }

  mark('account-suspension-survives-a-real-daemon-restart');
  const exited = new Promise((resolve) => daemon.once('exit', resolve));
  daemon.kill('SIGTERM'); await exited;
  daemon = launchDaemon(daemonArguments);
  ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
    if (daemon.exitCode !== null) throw new Error('restarted daemon exited');
    await sleep(100);
  }
  assert.equal(ready, true);
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 401);
  await adminPage.getByRole('button', { name: '刷新核对账号', exact: true }).click();
  await adminPage.getByText('已刷新实际状态，请核对后再次确认操作', { exact: true }).waitFor();
  const enabled = adminPage.waitForResponse((response) => response.url().endsWith('/status') && response.request().method() === 'PATCH');
  await adminPage.getByRole('button', { name: '确认解禁', exact: true }).click();
  assert.equal((await enabled).status(), 200);
  await adminPage.getByRole('dialog').waitFor({ state: 'detached' });
  await memberRow().getByText('已启用', { exact: true }).waitFor();
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 401);
  await invitedPage.goto(origin + '/login');
  await invitedPage.getByLabel('登录名', { exact: true }).fill('invited-member');
  await invitedPage.getByLabel('密码', { exact: true }).fill(password);
  await invitedPage.getByRole('button', { name: '登录', exact: true }).click();
  await invitedPage.waitForURL('**/dashboard');
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 200);
  mark('password-recovery-platform-ownership-cancellation-cas-and-mobile');
  const resetPath = `/api/platform/v1/organizations/portal/users/${member.id}/password-reset`;
  let generations = 0;
  adminPage.on('request', (request) => { if (new URL(request.url()).pathname === resetPath && request.method() === 'POST') generations++; });
  const resetRow = () => adminPage.locator('tbody tr').filter({ hasText: 'invited-member' });
  for (const width of [320, 390, 768]) {
    await adminPage.setViewportSize({ width, height: 844 });
    await resetRow().getByRole('button', { name: '重置密码', exact: true }).click();
    await adminPage.getByRole('dialog').waitFor();
    assert.equal(await adminPage.getByRole('button', { name: '确认生成重置码', exact: true }).isDisabled(), true);
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const box = await adminPage.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 845);
    await adminPage.getByLabel('重置原因（必填）', { exact: true }).fill('取消不生成');
    await adminPage.getByLabel('我已通过可靠渠道核实账号持有人', { exact: true }).check();
    await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  }
  assert.equal(generations, 0);
  await resetRow().getByRole('button', { name: '重置密码', exact: true }).click();
  assert.equal(await adminPage.getByLabel('重置原因（必填）', { exact: true }).inputValue(), '');
  await adminPage.getByLabel('重置原因（必填）', { exact: true }).fill('已独立核实持有人');
  await adminPage.getByLabel('我已通过可靠渠道核实账号持有人', { exact: true }).check();
  const beforeReset = (await api('/api/platform/v1/users').then((response) => response.json())).users.find((user) => user.org === 'portal' && user.id === member.id);
  const ownerAccount = await browserAPI(ownerPage, '/api/v1/account').then((response) => response.json());
  assert.equal((await browserAPI(ownerPage, `/api/v1/users/${member.id}`, { method: 'PATCH', headers: { 'X-CSRF-Token': ownerAccount.csrf_token },
    body: { displayName: '恢复前已复核', expectedUpdatedAt: beforeReset.updatedAt } })).status(), 200);
  const resetConflict = adminPage.waitForResponse((response) => response.url().endsWith('/password-reset') && response.request().method() === 'POST');
  await adminPage.getByRole('button', { name: '确认生成重置码', exact: true }).click();
  assert.equal((await resetConflict).status(), 409);
  assert.equal(await adminPage.getByLabel('重置原因（必填）', { exact: true }).inputValue(), '已独立核实持有人');
  assert.equal(await adminPage.getByRole('button', { name: '确认生成重置码', exact: true }).isDisabled(), true);
  await adminPage.getByRole('button', { name: '刷新核对账号', exact: true }).click();
  await adminPage.getByText('已刷新真实状态，请重新核实持有人并确认；再次生成会使此前的码失效', { exact: true }).waitFor();
  assert.equal(await adminPage.getByLabel('我已通过可靠渠道核实账号持有人', { exact: true }).isChecked(), false);
  await adminPage.getByLabel('我已通过可靠渠道核实账号持有人', { exact: true }).check();
  const firstResetResponse = adminPage.waitForResponse((response) => response.url().endsWith('/password-reset') && response.request().method() === 'POST');
  await adminPage.getByRole('button', { name: '确认生成重置码', exact: true }).click();
  const firstReset = await firstResetResponse;
  assert.equal(firstReset.status(), 201);
  const firstCode = (await firstReset.json()).code;
  assert.equal(await adminPage.getByLabel('一次性密码重置码', { exact: true }).inputValue(), firstCode);
  const stored = new DatabaseSync(path.join(state, 'portal/state.db'), { readOnly: true });
  let originalCredential;
  try {
    originalCredential = stored.prepare('SELECT password_hash, CAST(updated_at AS TEXT) AS revision FROM local_credentials WHERE user_id = ?').get(member.id);
    assert.equal(stored.prepare('SELECT token_hash FROM password_reset_tickets WHERE user_id = ?').get(member.id).token_hash, crypto.createHash('sha256').update(firstCode).digest('hex'));
  } finally { stored.close(); }
  for (const width of [320, 390, 768]) {
    await adminPage.setViewportSize({ width, height: 844 });
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(ownerPage, resetPath, { method: 'POST', body: { reason: '无平台权限', expected_updated_at: beforeReset.updatedAt, ownership_verified: true } })).status(), 401);
  await adminPage.getByRole('button', { name: '关闭并清除本页重置码', exact: true }).click();
  assert.equal((await adminPage.locator('body').innerText()).includes(firstCode), false);

  mark('password-recovery-public-form-keeps-secrets-out-of-storage-and-failed-audit-rolls-back');
  const replacementPassword = crypto.randomBytes(24).toString('base64url');
  await invitedPage.goto(origin + '/login');
  await invitedPage.getByRole('link', { name: '忘记密码', exact: true }).click();
  await invitedPage.getByLabel('一次性重置码', { exact: true }).fill(firstCode);
  await invitedPage.getByLabel('新密码', { exact: true }).fill(replacementPassword);
  await invitedPage.getByLabel('确认新密码', { exact: true }).fill('different confirmation');
  let redemptions = 0;
  invitedPage.on('request', (request) => {
    assert.equal(request.url().includes(firstCode), false);
    assert.equal(request.url().includes(replacementPassword), false);
    if (new URL(request.url()).pathname === '/api/v1/auth/password-reset' && request.method() === 'POST') redemptions++;
  });
  await invitedPage.getByRole('button', { name: '确认重置密码', exact: true }).click();
  await invitedPage.getByRole('alert').filter({ hasText: '两次输入的新密码不一致' }).waitFor();
  assert.equal(redemptions, 0);
  for (const width of [320, 390, 768]) {
    await invitedPage.setViewportSize({ width, height: 844 });
    assert.equal(await invitedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await invitedPage.getByLabel('确认新密码', { exact: true }).fill(replacementPassword);
  const auditFault = new DatabaseSync(path.join(state, 'portal/state.db'));
  try { auditFault.exec("CREATE TRIGGER password_reset_audit_fault BEFORE INSERT ON audit_events WHEN NEW.action = 'user.password_reset_used' BEGIN SELECT RAISE(ABORT, 'isolated reset audit failure'); END"); }
  finally { auditFault.close(); }
  const failedReset = invitedPage.waitForResponse((response) => response.url().endsWith('/auth/password-reset') && response.request().method() === 'POST');
  await invitedPage.getByRole('button', { name: '确认重置密码', exact: true }).click();
  assert.equal((await failedReset).status(), 503);
  await invitedPage.getByText('尚未确认提交结果。请先尝试使用新密码登录；若不能登录，再联系管理员核对并重新生成。不会自动重试。', { exact: true }).waitFor();
  assert.equal(await invitedPage.getByRole('button', { name: '确认重置密码', exact: true }).isDisabled(), true);
  assert.equal(await invitedPage.getByLabel('一次性重置码', { exact: true }).inputValue(), firstCode);
  const checkedReset = new DatabaseSync(path.join(state, 'portal/state.db'));
  try {
    assert.deepEqual(checkedReset.prepare('SELECT password_hash, CAST(updated_at AS TEXT) AS revision FROM local_credentials WHERE user_id = ?').get(member.id), originalCredential);
    assert.equal(checkedReset.prepare('SELECT COUNT(*) AS count FROM password_reset_tickets WHERE user_id = ?').get(member.id).count, 1);
    checkedReset.exec('DROP TRIGGER password_reset_audit_fault');
  } finally { checkedReset.close(); }
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 200);

  mark('password-recovery-issuance-audit-failure-preserves-the-existing-code-and-draft');
  await resetRow().getByRole('button', { name: '重置密码', exact: true }).click();
  await adminPage.getByLabel('重置原因（必填）', { exact: true }).fill('核对失败结果后重新生成');
  await adminPage.getByLabel('我已通过可靠渠道核实账号持有人', { exact: true }).check();
  const issuanceFault = new DatabaseSync(path.join(state, 'portal/state.db'));
  let oldResetHash;
  try {
    oldResetHash = issuanceFault.prepare('SELECT token_hash FROM password_reset_tickets WHERE user_id = ?').get(member.id).token_hash;
    issuanceFault.exec("CREATE TRIGGER password_reset_issuance_fault BEFORE INSERT ON audit_events WHEN NEW.action = 'user.password_reset_issued' BEGIN SELECT RAISE(ABORT, 'isolated issuance audit failure'); END");
  } finally { issuanceFault.close(); }
  const failedIssuance = adminPage.waitForResponse((response) => response.url().endsWith('/password-reset') && response.request().method() === 'POST');
  await adminPage.getByRole('button', { name: '确认生成重置码', exact: true }).click();
  assert.equal((await failedIssuance).status(), 503);
  assert.equal(await adminPage.getByLabel('重置原因（必填）', { exact: true }).inputValue(), '核对失败结果后重新生成');
  assert.equal(await adminPage.getByRole('button', { name: '确认生成重置码', exact: true }).isDisabled(), true);
  const checkedIssuance = new DatabaseSync(path.join(state, 'portal/state.db'));
  try {
    assert.equal(checkedIssuance.prepare('SELECT token_hash FROM password_reset_tickets WHERE user_id = ?').get(member.id).token_hash, oldResetHash);
    checkedIssuance.exec('DROP TRIGGER password_reset_issuance_fault');
  } finally { checkedIssuance.close(); }
  await adminPage.getByRole('button', { name: '刷新核对账号', exact: true }).click();
  await adminPage.getByText('已刷新真实状态，请重新核实持有人并确认；再次生成会使此前的码失效', { exact: true }).waitFor();
  await adminPage.getByLabel('我已通过可靠渠道核实账号持有人', { exact: true }).check();
  const secondResetResponse = adminPage.waitForResponse((response) => response.url().endsWith('/password-reset') && response.request().method() === 'POST');
  await adminPage.getByRole('button', { name: '确认生成重置码', exact: true }).click();
  const secondReset = await secondResetResponse;
  assert.equal(secondReset.status(), 201);
  const secondCode = (await secondReset.json()).code;
  assert.notEqual(secondCode, firstCode);
  await adminPage.getByRole('button', { name: '关闭并清除本页重置码', exact: true }).click();

  mark('password-recovery-pending-code-survives-a-real-daemon-restart-and-rejects-previous-code');
  const resetExit = new Promise((resolve) => daemon.once('exit', resolve));
  daemon.kill('SIGTERM'); await resetExit;
  daemon = launchDaemon(daemonArguments);
  ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
    if (daemon.exitCode !== null) throw new Error('reset daemon restart failed');
    await sleep(100);
  }
  assert.equal(ready, true);
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(invitedPage, '/api/v1/auth/password-reset', { method: 'POST', body: { code: firstCode, new_password: replacementPassword, confirm_password: replacementPassword } })).status(), 400);
  await invitedPage.goto(origin + '/reset-password?code=not-a-secret');
  await invitedPage.waitForURL((url) => url.pathname === '/reset-password' && url.search === '');
  await invitedPage.getByLabel('一次性重置码', { exact: true }).waitFor();
  assert.equal(await invitedPage.getByLabel('一次性重置码', { exact: true }).inputValue(), '');

  mark('password-recovery-atomic-redemption-signs-out-only-the-account-and-requires-normal-login');
  await invitedPage.getByLabel('一次性重置码', { exact: true }).fill(secondCode);
  await invitedPage.getByLabel('新密码', { exact: true }).fill(replacementPassword);
  await invitedPage.getByLabel('确认新密码', { exact: true }).fill(replacementPassword);
  const completedReset = invitedPage.waitForResponse((response) => response.url().endsWith('/auth/password-reset') && response.request().method() === 'POST');
  await invitedPage.getByRole('button', { name: '确认重置密码', exact: true }).click();
  assert.equal((await completedReset).status(), 200);
  await invitedPage.getByText('密码已重置，原浏览器登录已退出。请使用新密码重新登录。', { exact: true }).waitFor();
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 401);
  assert.equal((await browserAPI(ownerPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(newPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(invitedPage, '/api/v1/auth/password-reset', { method: 'POST', body: { code: secondCode, new_password: replacementPassword, confirm_password: replacementPassword } })).status(), 400);
  assert.equal((await browserAPI(invitedPage, '/api/v1/auth/login', { method: 'POST', body: { login: 'invited-member', password } })).status(), 401);
  await invitedPage.getByRole('link', { name: '返回登录', exact: true }).click();
  await invitedPage.getByLabel('登录名', { exact: true }).fill('invited-member');
  await invitedPage.getByLabel('密码', { exact: true }).fill(replacementPassword);
  await invitedPage.getByRole('button', { name: '登录', exact: true }).click();
  await invitedPage.waitForURL('**/dashboard');
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 200);
  for (const page of [adminPage, invitedPage]) {
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of [firstCode, secondCode, replacementPassword]) {
      assert.equal(storage.includes(secret), false);
      assert.equal(page.url().includes(secret), false);
    }
  }
  const daemonLog = fs.readFileSync(path.join(state, 'daemon.log'), 'utf8');
  assert.equal(daemonLog.includes(firstCode) || daemonLog.includes(secondCode) || daemonLog.includes(replacementPassword), false);
  assert.deepEqual(errors, []);
  mark('authentication-management-real-https-complete');
  console.log(JSON.stringify({ result: 'passed', stages: completed.length, pageErrors: 0, publicProvidersContacted: false }));
}
main().catch((error) => {
  console.error(JSON.stringify({ result: 'failed', stage, errorType: error.name,
    locations: error.stack?.split('\n').filter((line) => line.includes(__filename)) }));
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((resolve) => daemon.once('exit', resolve)); daemon.kill('SIGTERM'); await exited;
  }
  fs.rmSync(state, { recursive: true, force: true });
});
