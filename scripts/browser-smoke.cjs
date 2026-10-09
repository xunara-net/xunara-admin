const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const adminDist = path.resolve(__dirname, '../dist');
const webDist = path.resolve(__dirname, '../../xunara-web/dist');
const binary = process.env.SMOKE_XUNARAD;
if (!binary || !fs.existsSync(binary) || !fs.existsSync(path.join(adminDist, 'index.html')) || !fs.existsSync(path.join(webDist, 'index.html'))) {
  throw new Error('Build server, web and admin first; set SMOKE_XUNARAD to the test binary');
}
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'xunara-console-smoke-'));
fs.chmodSync(state, 0o700);
const platformToken = crypto.randomBytes(32).toString('base64url');
const password = crypto.randomBytes(24).toString('base64url');
const pageErrors = [];
const completed = [];
let daemon, browser, proxy, origin, control;
let stage = 'startup';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function mark(value) {
  stage = value;
  completed.push(value);
  console.log(JSON.stringify({ stage: value }));
}

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function serve(request, response) {
  const pathname = new URL(request.url, origin).pathname;
  if (/^\/(api|health|console|setup)(\/|$)/.test(pathname)) {
    const upstream = http.request(control + request.url, {
      method: request.method, headers: { ...request.headers, host: new URL(origin).host },
    }, (result) => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
    return;
  }
  const isAdmin = pathname.startsWith('/admin/');
  const dist = isAdmin ? adminDist : webDist;
  const assetPath = isAdmin ? pathname.slice('/admin'.length) : pathname;
  const asset = assetPath.startsWith('/assets/') ? path.resolve(dist, '.' + assetPath) : path.join(dist, 'index.html');
  if (!asset.startsWith(dist + path.sep) || !fs.existsSync(asset)) { response.writeHead(404); response.end(); return; }
  const extension = path.extname(asset);
  response.writeHead(200, { 'Content-Type': extension === '.js' ? 'application/javascript' : extension === '.css' ? 'text/css' : 'text/html; charset=utf-8' });
  fs.createReadStream(asset).pipe(response);
}

async function api(endpoint, credential, body, method = 'POST') {
  const response = await fetch(control + endpoint, {
    method, signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}

async function assertSecretNotStored(page, secret) {
  const stored = await page.evaluate(() => [localStorage, sessionStorage].flatMap((storage) => Object.values(storage)));
  assert.equal(stored.some((value) => value.includes(secret)), false);
  assert.equal(page.url().includes(secret), false);
}

async function main() {
  proxy = http.createServer(serve);
  await new Promise((resolve) => proxy.listen(0, 'localhost', resolve));
  origin = `http://localhost:${proxy.address().port}`;
  const controlPort = await unusedPort();
  control = `http://127.0.0.1:${controlPort}`;
  const log = fs.openSync(path.join(state, 'daemon.log'), 'a', 0o600);
  // 只创建隔离的临时租户；凭据在进程内生成，经请求正文或环境传递，不出现在参数或输出。
  daemon = spawn(binary, ['-listen', `127.0.0.1:${controlPort}`, '-grpc-listen', '127.0.0.1:0',
    '-server-url', origin, '-state-dir', state, '-plans', 'builtin', '-network-pool', '100.100.0.0/16', '-log-level', 'error'], {
    env: { ...process.env, XUNARA_PLATFORM_ADMIN_TOKEN: platformToken }, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(control + '/health', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    if (daemon.exitCode !== null) throw new Error('isolated server exited');
    await sleep(100);
  }
  assert.equal(ready, true);
  const markup = await fetch(control + '/setup').then((response) => response.text());
  const formToken = /name="_csrf" value="([^"]+)"/.exec(markup)[1];
  const initialized = await fetch(control + '/setup', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: fs.readFileSync(path.join(state, 'setup-token'), 'utf8').trim(),
      _csrf: formToken, login: 'consolesmoke', display_name: '浏览器验收', email: '', password, confirm: password }),
  });
  assert.equal(initialized.status, 302);
  const allocation = await api('/api/platform/v1/organizations/default/plan/allocate', platformToken, {});
  assert.equal(allocation.status, 200);

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BINARY || undefined, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  userPage.on('pageerror', (error) => pageErrors.push(error.name));
  await userPage.goto(origin + '/login');
  await userPage.getByLabel('登录名', { exact: true }).fill('consolesmoke');
  await userPage.getByLabel('密码', { exact: true }).fill(password);
  await userPage.getByRole('button', { name: '登录', exact: true }).click();
  await userPage.waitForURL('**/dashboard');

  mark('authentication-outage-preserves-cookie-and-target');
  const beforeCookies = await userContext.cookies();
  const snapshotPattern = '**/api/v1/auth/session';
  await userPage.route(snapshotPattern, (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: 'AUTH_UNAVAILABLE: injected outage' }) }));
  let accountRequests = 0;
  userPage.on('request', (request) => { if (request.url().includes('/api/v1/account/')) accountRequests++; });
  await userPage.goto(origin + '/security?tab=login');
  await userPage.getByRole('heading', { name: '暂时无法确认登录' }).waitFor();
  assert.equal(userPage.url(), origin + '/security?tab=login');
  assert.equal(await userPage.locator('.sidebar').count(), 0);
  assert.equal(accountRequests, 0);
  assert.deepEqual(await userContext.cookies(), beforeCookies);
  await userPage.unroute(snapshotPattern);
  await userPage.getByRole('button', { name: '重新尝试', exact: true }).click();
  await userPage.getByRole('heading', { name: '安全中心', exact: true }).waitFor();
  assert.equal(userPage.url(), origin + '/security?tab=login');

  mark('malformed-authentication-response-is-not-anonymous');
  await userPage.route(snapshotPattern, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await userPage.reload();
  await userPage.getByRole('heading', { name: '暂时无法确认登录' }).waitFor();
  assert.equal(userPage.url(), origin + '/security?tab=login');
  await userPage.unroute(snapshotPattern);
  await userPage.getByRole('button', { name: '重新尝试', exact: true }).click();
  await userPage.getByRole('heading', { name: '安全中心', exact: true }).waitFor();

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const adminPage = await adminContext.newPage();
  adminPage.on('pageerror', (error) => pageErrors.push(error.name));
  await adminPage.goto(origin + '/admin/login');
  await adminPage.getByLabel('平台管理令牌', { exact: true }).fill(platformToken);
  await adminPage.getByRole('button', { name: '进入后台', exact: true }).click();
  await adminPage.waitForURL('**/admin/dashboard');

  mark('tenant-stats-and-plan-change-use-real-server-contract');
  await adminPage.goto(origin + '/admin/tenants');
  const tenantResponse = await api('/api/platform/v1/organizations/default', platformToken, undefined, 'GET');
  assert.equal(tenantResponse.status, 200);
  const tenant = await tenantResponse.json();
  await adminPage.locator('tbody').getByText(tenant.stats.network_prefix, { exact: true }).waitFor();
  for (const plan of ['pro', 'free']) {
    await adminPage.getByRole('button', { name: '套餐', exact: true }).click();
    await adminPage.locator('.modal-mask select').selectOption(plan);
    const changed = adminPage.waitForResponse((response) => response.url().endsWith('/organizations/default/plan') && response.request().method() === 'PATCH');
    await adminPage.getByRole('button', { name: '保存', exact: true }).click();
    const answer = await changed;
    assert.equal(answer.status(), 200);
    assert.equal((await answer.json()).plan, plan);
    await adminPage.locator('tbody').getByText(plan === 'pro' ? 'Pro' : 'Free', { exact: true }).waitFor();
  }

  mark('plan-editor-retains-quota-and-removes-read-only-fields');
  await adminPage.goto(origin + '/admin/plans');
  for (const relayLimit of [6, 5]) {
    await adminPage.locator('tbody tr').filter({ hasText: 'Pro' }).getByRole('button', { name: '编辑', exact: true }).click();
    await adminPage.getByLabel('托管中继上限（-1 不限）', { exact: true }).fill(String(relayLimit));
    const saved = adminPage.waitForResponse((response) => response.url().endsWith('/api/platform/v1/plans') && response.request().method() === 'POST');
    await adminPage.getByRole('button', { name: '保存', exact: true }).click();
    const answer = await saved;
    assert.equal(answer.status(), 200);
    assert.equal((await answer.json()).max_relays, relayLimit);
    const payload = answer.request().postDataJSON();
    assert.equal(Object.hasOwn(payload, 'default'), false);
    assert.equal(Object.hasOwn(payload, 'device_allowance'), false);
    await adminPage.locator('.modal-mask').waitFor({ state: 'hidden' });
    const catalog = await api('/api/platform/v1/plans', platformToken, undefined, 'GET').then((response) => response.json());
    assert.equal(catalog.plans.find((entry) => entry.id === 'pro').max_relays, relayLimit);
  }
  await adminPage.goto(origin + '/admin/relays');
  await adminPage.getByText('尚未注册托管中继', { exact: true }).waitFor();

  mark('one-time-relay-enrollment-and-secret-cleanup');
  await adminPage.getByRole('button', { name: '创建注册令牌', exact: true }).click();
  await adminPage.getByLabel('中继名称', { exact: true }).fill('上海验收中继');
  await adminPage.getByLabel('有效期（小时）', { exact: true }).fill('2');
  await adminPage.getByRole('button', { name: '生成一次性令牌', exact: true }).click();
  const secretField = adminPage.getByLabel('一次性注册令牌', { exact: true });
  await secretField.waitFor();
  const enrollmentSecret = await secretField.inputValue();
  assert.ok(enrollmentSecret.length > 32);
  await assertSecretNotStored(adminPage, enrollmentSecret);
  const enrolled = await api('/api/relay/v1/enroll', enrollmentSecret, {
    name: '上海验收中继', hostname: 'sh.relay.test', region_code: 'sh', region_name: '上海',
    node_key: 'nodekey:' + crypto.randomBytes(32).toString('hex'), version: 'browser-smoke', derp_port: 443,
  });
  assert.equal(enrolled.status, 200);
  const relayIdentity = await enrolled.json();
  await adminPage.getByRole('button', { name: '完成并清除令牌', exact: true }).click();
  assert.equal(await secretField.count(), 0);
  await assertSecretNotStored(adminPage, enrollmentSecret);
  const heartbeatBody = { healthy: false, version: 'browser-smoke', uptime_seconds: 30, connected_clients: 2, bytes_in: 2048, bytes_out: 4096 };
  assert.equal((await api('/api/relay/v1/heartbeat', relayIdentity.relay_token, heartbeatBody)).status, 200);
  await adminPage.getByRole('button', { name: '刷新', exact: true }).click();
  await adminPage.locator('tbody').getByText('降级', { exact: true }).waitFor();
  await adminPage.locator('tbody tr').filter({ hasText: '上海验收中继' }).waitFor();
  assert.ok((await adminPage.locator('tbody').innerText()).includes('2.0 KiB'));

  mark('configuration-validation-confirmation-and-heartbeat');
  await adminPage.getByRole('button', { name: '配置', exact: true }).click();
  await adminPage.getByLabel('每连接限速（字节/秒）', { exact: true }).fill('1.5');
  await adminPage.getByRole('button', { name: '保存配置', exact: true }).click();
  await adminPage.getByRole('alert').filter({ hasText: '带宽必须是整数' }).waitFor();
  await adminPage.getByLabel('每连接限速（字节/秒）', { exact: true }).fill('1024');
  await adminPage.getByLabel('区域显示名', { exact: true }).fill('上海维护区');
  await adminPage.getByLabel('期望状态', { exact: true }).selectOption('maintenance');
  adminPage.once('dialog', (dialog) => dialog.dismiss());
  await adminPage.getByRole('button', { name: '保存配置', exact: true }).click();
  assert.equal(await adminPage.locator('.modal-mask').count(), 1);
  adminPage.once('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: '保存配置', exact: true }).click();
  await adminPage.locator('tbody').getByText('维护中', { exact: true }).waitFor();
  const configured = await api('/api/relay/v1/heartbeat', relayIdentity.relay_token, heartbeatBody);
  assert.equal(configured.status, 200);
  const configuration = await configured.json();
  assert.equal(configuration.desired_state, 'maintenance');
  assert.equal(configuration.bandwidth_limit, 1024);
  assert.equal(configuration.region_name, '上海维护区');
  assert.equal(configuration.config_version, '2');

  mark('quota-denial-keeps-platform-login');
  await adminPage.getByRole('button', { name: '创建注册令牌', exact: true }).click();
  const quotaDenial = adminPage.waitForResponse((response) => response.url().endsWith('/relays/enroll-tokens') && response.status() === 403);
  await adminPage.getByRole('button', { name: '生成一次性令牌', exact: true }).click();
  await quotaDenial;
  await adminPage.getByRole('alert').filter({ hasText: '托管中继额度已用完' }).waitFor();
  assert.equal(await adminPage.evaluate(() => sessionStorage.getItem('xunara.admin.token') !== null), true);
  assert.equal(adminPage.url(), origin + '/admin/relays');
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();

  mark('relay-filtering-and-mobile-layout');
  await adminPage.getByLabel('筛选中继状态', { exact: true }).selectOption('online');
  await adminPage.getByText('没有匹配的中继', { exact: true }).waitFor();
  await adminPage.getByLabel('筛选中继状态', { exact: true }).selectOption('maintenance');
  await adminPage.locator('tbody tr').filter({ hasText: '上海验收中继' }).waitFor();
  await adminPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await adminPage.setViewportSize({ width: 1440, height: 1000 });

  mark('relay-deletion-invalidates-long-term-identity');
  adminPage.once('dialog', (dialog) => dialog.dismiss());
  await adminPage.getByRole('button', { name: '删除', exact: true }).click();
  assert.equal(await adminPage.locator('tbody tr').count(), 1);
  adminPage.once('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: '删除', exact: true }).click();
  await adminPage.getByText('尚未注册托管中继', { exact: true }).waitFor();
  assert.equal((await api('/api/relay/v1/heartbeat', relayIdentity.relay_token, heartbeatBody)).status, 401);

  mark('relay-list-outage-and-retry');
  await adminPage.route('**/api/platform/v1/relays', (route) => route.fulfill({ status: 503, body: 'injected relay lookup failure' }));
  await adminPage.getByRole('button', { name: '刷新', exact: true }).click();
  await adminPage.getByRole('alert').filter({ hasText: '加载失败' }).waitFor();
  assert.equal(await adminPage.getByText('尚未注册托管中继', { exact: true }).count(), 0);
  await adminPage.unroute('**/api/platform/v1/relays');
  await adminPage.getByRole('button', { name: '重试', exact: true }).click();
  await adminPage.getByText('尚未注册托管中继', { exact: true }).waitFor();
  assert.equal(pageErrors.length, 0);
  console.log(JSON.stringify({ passed: true, stages: completed, javascript_errors: pageErrors.length, fixture: 'isolated ephemeral tenant' }));
}

// 失败输出只有阶段与错误类型，不能把断言中的请求正文或凭据顺带打印。
main().catch((error) => {
  const locations = error.stack?.split('\n').filter((line) => line.includes(__filename));
  console.error(JSON.stringify({ failed_stage: stage, error_type: error.name, locations }));
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((resolve) => daemon.once('exit', resolve));
    daemon.kill('SIGTERM');
    await exited;
  }
  fs.rmSync(state, { recursive: true, force: true });
});
