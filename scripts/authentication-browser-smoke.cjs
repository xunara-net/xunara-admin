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
  const log = fs.openSync(path.join(state, 'daemon.log'), 'a', 0o600);
  // 全部凭据只在临时内存、环境或请求正文；不连接真实 IdP，也不使用线上数据库。
  daemon = spawn(binary, ['-listen', `127.0.0.1:${controlPort}`, '-grpc-listen', '127.0.0.1:0', '-org-config', orgConfig,
    '-platform-state-dir', state, '-plans', 'builtin', '-network-pool', '100.100.0.0/16', '-log-level', 'error'],
    { env: { ...process.env, XUNARA_PLATFORM_ADMIN_TOKEN: platformToken }, stdio: ['ignore', log, log] });
  fs.closeSync(log);
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
