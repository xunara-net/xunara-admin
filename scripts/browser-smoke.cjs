const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { runNetworkSmoke } = require('../../xunara-web/scripts/network-browser-smoke.cjs');
const { runRelayHistorySmoke } = require('../../xunara-web/scripts/relay-history-browser-smoke.cjs');
const { runAddressRelaySmoke } = require('../../xunara-web/scripts/address-relay-browser-smoke.cjs');

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
let daemon, browser, proxy, origin, control, issuer;
let issuerOrigin, issuerMode = 'valid', lastAccessToken = '', tokenExchanges = 0;
const authorizationCodes = new Map();
const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const unrelatedKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJWK = { ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'browser-smoke-key', alg: 'RS256', use: 'sig' };
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
  if (/^\/(api|health|console|setup|oidc)(\/|$)/.test(pathname) || pathname.startsWith('/register/')) {
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

// 隔离的 OIDC 提供方真实签发 RSA ID Token，并校验固定回调、PKCE 和一次性授权码。
// 它不是生产身份缓存，不会连接公网提供方，也不输出任何凭据。
async function serveIssuer(request, response) {
  const endpoint = new URL(request.url, issuerOrigin);
  const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
  if (endpoint.pathname === '/.well-known/openid-configuration') {
    json(200, { issuer: issuerOrigin, authorization_endpoint: issuerOrigin + '/authorize', token_endpoint: issuerOrigin + '/token',
      jwks_uri: issuerOrigin + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
    return;
  }
  if (endpoint.pathname === '/jwks') { json(200, { keys: [publicJWK] }); return; }
  if (endpoint.pathname === '/authorize') {
    const query = endpoint.searchParams;
    if (query.get('client_id') !== 'browser-smoke' || query.get('redirect_uri') !== origin + '/oidc/callback/smoke-oidc' || query.get('code_challenge_method') !== 'S256' || !query.get('state') || !query.get('nonce') || !query.get('code_challenge')) { json(400, { error: 'invalid_request' }); return; }
    const code = crypto.randomBytes(32).toString('base64url');
    authorizationCodes.set(code, { nonce: query.get('nonce'), challenge: query.get('code_challenge'),
      redirect: query.get('redirect_uri'), mode: issuerMode, expires: Date.now() + 60000 });
    const callback = new URL(query.get('redirect_uri'));
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', query.get('state'));
    const callbackLink = callback.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<html lang="zh-CN"><body><a href="${callbackLink}">确认登录</a></body></html>`);
    return;
  }
  if (endpoint.pathname === '/token' && request.method === 'POST') {
    request.setTimeout(5000, () => request.destroy());
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 8192) { json(413, { error: 'invalid_request' }); return; } }
    const values = new URLSearchParams(body);
    const code = values.get('code');
    const authorization = authorizationCodes.get(code);
    const challenge = crypto.createHash('sha256').update(values.get('code_verifier') || '').digest('base64url');
    if (!authorization || authorization.expires <= Date.now() || values.get('grant_type') !== 'authorization_code' ||
      authorization.redirect !== values.get('redirect_uri') || authorization.challenge !== challenge) { json(400, { error: 'invalid_grant' }); return; }
    authorizationCodes.delete(code);
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuerOrigin, aud: 'browser-smoke', sub: 'browser-smoke-subject', iat: now, exp: now + 120,
      nonce: authorization.mode === 'nonce' ? 'wrong-nonce' : authorization.nonce, email: 'same-email@example.invalid', name: 'OIDC 验收成员' };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: publicJWK.kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const key = authorization.mode === 'signature' ? unrelatedKey.privateKey : signingKey.privateKey;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
    lastAccessToken = crypto.randomBytes(32).toString('base64url');
    tokenExchanges++;
    json(200, { token_type: 'Bearer', access_token: lastAccessToken, expires_in: 120, id_token: `${unsigned}.${signature}` });
    return;
  }
  json(404, { error: 'not_found' });
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
  issuer = http.createServer((request, response) => {
    serveIssuer(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve) => issuer.listen(0, '127.0.0.1', resolve));
  issuerOrigin = `http://127.0.0.1:${issuer.address().port}`;
  const controlPort = await unusedPort();
  control = `http://127.0.0.1:${controlPort}`;
  const log = fs.openSync(path.join(state, 'daemon.log'), 'a', 0o600);
  const defaultRelayMap = path.join(state, 'derp-map.json');
  fs.writeFileSync(defaultRelayMap, JSON.stringify({ Regions: { '990': { RegionID: 990, RegionCode: 'default', RegionName: '默认验收中继', Nodes: [{ Name: 'default-smoke', RegionID: 990, HostName: 'default.example.test' }] } } }), { mode: 0o600 });
  // 只创建隔离的临时租户；凭据在进程内生成，经请求正文或环境传递，不出现在参数或输出。
  daemon = spawn(binary, ['-listen', `127.0.0.1:${controlPort}`, '-grpc-listen', '127.0.0.1:0',
    '-server-url', origin, '-state-dir', state, '-plans', 'builtin', '-network-pool', '100.100.0.0/16', '-domain', 'smoke.xunara.test', '-derp-map', defaultRelayMap, '-log-level', 'error',
    '-oidc-issuer', issuerOrigin, '-oidc-client-id', 'browser-smoke', '-oidc-id', 'smoke-oidc', '-allow-local-login'], {
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
  mark('owner-bootstrap-claims-once-and-disarms-stale-proof');
  const freshMethods = await fetch(control + '/api/v1/auth/providers').then((response) => response.json());
  assert.equal(freshMethods.setup_required, true);
  const markup = await fetch(control + '/setup').then((response) => response.text());
  const formToken = /name="_csrf" value="([^"]+)"/.exec(markup)[1];
  const setupProof = fs.readFileSync(path.join(state, 'setup-token'), 'utf8').trim();
  const initialized = await fetch(control + '/setup', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: setupProof,
      _csrf: formToken, login: 'consolesmoke', display_name: '浏览器验收', email: 'same-email@example.invalid', password, confirm: password }),
  });
  assert.equal(initialized.status, 302);
  assert.equal(initialized.headers.get('location'), '/console/');
  const ownerCookie = initialized.headers.get('set-cookie').split(';', 1)[0];
  const ownerBefore = await fetch(control + '/api/v1/auth/session', { headers: { Cookie: ownerCookie } }).then((response) => response.json());
  assert.equal(ownerBefore.authenticated, true);
  assert.equal(ownerBefore.user.id, 1);
  assert.equal(ownerBefore.user.role, 'owner');
  assert.equal(fs.existsSync(path.join(state, 'setup-token')), false);
  // 残留文件不是认领权限；重放只去登录，不能覆盖 owner 或签发第二个初始化会话。
  fs.writeFileSync(path.join(state, 'setup-token'), setupProof + '\n', { mode: 0o600 });
  const repeatedSetup = await fetch(control + '/setup', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: setupProof, _csrf: formToken, login: 'replacement-owner', password, confirm: password }),
  });
  assert.equal(repeatedSetup.status, 302);
  assert.equal(repeatedSetup.headers.get('location'), '/login');
  assert.equal(repeatedSetup.headers.has('set-cookie'), false);
  const ownerAfter = await fetch(control + '/api/v1/auth/session', { headers: { Cookie: ownerCookie } }).then((response) => response.json());
  assert.deepEqual(ownerAfter.user, ownerBefore.user);
  assert.equal(ownerAfter.session.id, ownerBefore.session.id);
  assert.equal((await fetch(control + '/api/v1/auth/providers').then((response) => response.json())).setup_required, false);
  fs.unlinkSync(path.join(state, 'setup-token'));
  const allocation = await api('/api/platform/v1/organizations/default/plan/allocate', platformToken, {});
  assert.equal(allocation.status, 200);

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BINARY || undefined, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  userPage.on('pageerror', (error) => pageErrors.push(error.name));
  mark('login-policy-outage-malformed-response-and-recovery');
  const methodsPattern = '**/api/v1/auth/providers';
  const loginTarget = origin + '/login?return_to=' + encodeURIComponent('/security?metadata=1');
  let prematureLogins = 0;
  userPage.on('request', (request) => { if (new URL(request.url()).pathname === '/api/v1/auth/login') prematureLogins++; });
  await userPage.route(methodsPattern, (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: 'AUTH_UNAVAILABLE: injected metadata outage' }) }));
  await userPage.goto(loginTarget);
  await userPage.getByRole('button', { name: '重试登录配置', exact: true }).waitFor();
  assert.equal(await userPage.getByLabel('登录名', { exact: true }).count(), 0);
  assert.equal(await userPage.getByRole('link', { name: '使用邀请码注册', exact: true }).count(), 0);
  assert.equal(await userPage.getByRole('link', { name: '使用 smoke-oidc 登录', exact: true }).count(), 0);
  assert.equal(userPage.url(), loginTarget);
  const anonymousCookies = await userContext.cookies();
  await userPage.unroute(methodsPattern);
  await userPage.route(methodsPattern, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers: [] }) }));
  await userPage.getByRole('button', { name: '重试登录配置', exact: true }).click();
  await userPage.getByText('登录方式响应格式无效，请稍后重试或联系管理员。', { exact: true }).waitFor();
  assert.equal(await userPage.getByLabel('登录名', { exact: true }).count(), 0);
  assert.equal(prematureLogins, 0);
  assert.equal(userPage.url(), loginTarget);
  assert.deepEqual(await userContext.cookies(), anonymousCookies);
  await userPage.unroute(methodsPattern);
  await userPage.getByRole('button', { name: '重试登录配置', exact: true }).click();
  await userPage.getByLabel('登录名', { exact: true }).waitFor();
  assert.equal(await userPage.getByRole('link', { name: '使用 smoke-oidc 登录', exact: true }).count(), 1);
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

  await runRelayHistorySmoke({ userPage, adminPage, origin, api, platformToken, relayIdentity, mark });

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

  mark('tenant-relay-view-uses-enrolled-records');
  let peerRelayRequests = 0;
  userPage.on('request', (request) => { if (new URL(request.url()).pathname === '/api/v2/relays') peerRelayRequests++; });
  await userPage.goto(origin + '/relays');
  await userPage.getByRole('navigation', { name: '中继功能' }).getByRole('button', { name: '私有中继', exact: true }).click();
  await userPage.locator('tbody tr').filter({ hasText: '上海验收中继' }).waitFor();
  assert.equal(peerRelayRequests, 0);
  await userPage.getByText('已接入 1 / 1', { exact: true }).waitFor();

  mark('network-read-failures-are-not-zero-resources');
  const networkPaths = ['/api/v1/routes', '/api/v2/relays/enrolled', '/api/v2/derp', '/api/v2/exit-nodes'];
  for (const endpoint of networkPaths) {
    await userPage.route('**' + endpoint, (route) => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: '网络读取失败（验收注入）' }) }));
  }
  await userPage.getByRole('button', { name: '刷新', exact: true }).click();
  await userPage.getByRole('alert').filter({ hasText: '托管中继读取失败' }).waitFor();
  assert.equal(await userPage.getByText('还没有私有中继', { exact: true }).count(), 0);
  await userPage.getByRole('navigation', { name: '中继功能' }).getByRole('button', { name: '可用中继', exact: true }).click();
  await userPage.getByText('网络读取失败（验收注入）', { exact: true }).waitFor();
  await userPage.goto(origin + '/routes');
  await userPage.getByRole('alert').filter({ hasText: '子网路由读取失败' }).waitFor();
  await userPage.getByRole('alert').filter({ hasText: '出口节点读取失败' }).waitFor();
  await userPage.getByText('子网路由 —', { exact: true }).waitFor();
  await userPage.getByText('出口节点 —', { exact: true }).waitFor();
  for (const endpoint of networkPaths) await userPage.unroute('**' + endpoint);
  await userPage.goto(origin + '/relays');
  await userPage.getByRole('navigation', { name: '中继功能' }).getByRole('button', { name: '私有中继', exact: true }).click();
  await userPage.locator('tbody tr').filter({ hasText: '上海验收中继' }).waitFor();
  assert.equal(await userPage.getByRole('alert').count(), 0);
  await userPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await userPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);

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
  mark('member-owner-boundary-and-confirmation');
  await userPage.goto(origin + '/members');
  const ownerSelect = userPage.locator('tbody select');
  await ownerSelect.waitFor();
  assert.equal(await ownerSelect.isDisabled(), true);
  const actualUsers = await userContext.request.get(origin + '/api/v1/users').then((response) => response.json());
  const memberFixture = { id: 2, loginName: 'member-smoke', displayName: '权限验收成员', email: '', role: 'member' };
  // 注入一条展示夹具和写入故障，只验收 UI 取消/失败回滚，不冒充真实服务端改角色。
  await userPage.route('**/api/v1/users', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ users: [...actualUsers.users, memberFixture] }) }));
  let roleWrites = 0;
  await userPage.route('**/api/v1/users/2', (route) => {
    roleWrites++;
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '角色更新失败（验收注入）' }) });
  });
  await userPage.getByRole('button', { name: '刷新', exact: true }).click();
  const memberSelect = userPage.locator('tbody tr').filter({ hasText: 'member-smoke' }).locator('select');
  await memberSelect.waitFor();
  userPage.once('dialog', (dialog) => dialog.dismiss());
  await memberSelect.selectOption('admin');
  assert.equal(roleWrites, 0);
  assert.equal(await memberSelect.inputValue(), 'member');
  userPage.once('dialog', (dialog) => dialog.accept());
  await memberSelect.selectOption('admin');
  await userPage.getByText('角色更新失败（验收注入）', { exact: true }).waitFor();
  assert.equal(roleWrites, 1);
  assert.equal(await memberSelect.inputValue(), 'member');
  await userPage.unroute('**/api/v1/users/2');
  await userPage.unroute('**/api/v1/users');
  await userPage.route(snapshotPattern, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.user.role = 'admin';
    await route.fulfill({ response, json: snapshot });
  });
  await userPage.reload();
  await userPage.getByText('只有网络所有者可以修改成员角色。', { exact: false }).waitFor();
  assert.equal(await userPage.locator('tbody select').count(), 0);
  await userPage.unroute(snapshotPattern);

  mark('member-list-failure-is-not-empty');
  await userPage.route('**/api/v1/users', (route) => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: '成员列表读取失败（验收注入）' }) }));
  await userPage.getByRole('button', { name: '刷新', exact: true }).click();
  await userPage.getByRole('alert').filter({ hasText: '成员列表读取失败' }).waitFor();
  assert.equal(await userPage.getByText('没有成员', { exact: true }).count(), 0);
  await userPage.unroute('**/api/v1/users');
  await userPage.getByRole('button', { name: '刷新', exact: true }).click();
  await userPage.locator('tbody tr').filter({ hasText: 'consolesmoke' }).waitFor();
  assert.equal(await userPage.getByRole('alert').count(), 0);

  mark('free-member-quota-keeps-owner-login');
  await userPage.reload();
  await userPage.getByRole('button', { name: '创建成员邀请', exact: true }).click();
  const memberQuotaDenial = userPage.waitForResponse((response) => response.url().endsWith('/api/v1/member-invitations') && response.status() === 403);
  await userPage.getByRole('button', { name: '生成一次性邀请码', exact: true }).click();
  await memberQuotaDenial;
  await userPage.getByRole('alert').filter({ hasText: '成员数量已达上限，请升级套餐' }).waitFor();
  assert.equal(userPage.url(), origin + '/members');
  await userPage.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await api('/api/platform/v1/organizations/default/plan', platformToken, { plan_id: 'pro' }, 'PATCH')).status, 200);

  mark('member-invitation-created-once-without-url-or-storage-secret');
  await userPage.reload();
  await userPage.getByRole('button', { name: '创建成员邀请', exact: true }).click();
  await userPage.getByLabel('邀请备注', { exact: true }).fill('受邀浏览器成员');
  await userPage.getByRole('button', { name: '生成一次性邀请码', exact: true }).click();
  const inviteCode = await userPage.getByLabel('一次性邀请码', { exact: true }).inputValue();
  assert.equal(inviteCode.startsWith('xunara_invite_'), true);
  await assertSecretNotStored(userPage, inviteCode);
  assert.equal(await userPage.getByLabel('注册页面（不含邀请码）', { exact: true }).inputValue(), origin + '/register');
  await userPage.getByRole('button', { name: '关闭并清除代码', exact: true }).click();
  assert.equal(await userPage.getByLabel('一次性邀请码', { exact: true }).count(), 0);
  assert.equal((await userPage.content()).includes(inviteCode), false);

  mark('invited-browser-joins-existing-tenant-and-cannot-manage-invites');
  const invitedContext = await browser.newContext();
  const invitedPage = await invitedContext.newPage();
  invitedPage.on('pageerror', (error) => pageErrors.push(error.name));
  await invitedPage.goto(origin + '/register');
  await invitedPage.getByLabel('邀请码', { exact: true }).fill(inviteCode);
  await invitedPage.getByLabel('登录名', { exact: true }).fill('browser-invited-member');
  await invitedPage.getByLabel('密码', { exact: true }).fill(password);
  await invitedPage.getByRole('button', { name: '注册并登录', exact: true }).click();
  await invitedPage.waitForURL('**/dashboard');
  const invitedSnapshot = await invitedContext.request.get(origin + '/api/v1/auth/session').then((response) => response.json());
  assert.equal(invitedSnapshot.user.role, 'member');
  assert.equal(invitedSnapshot.tenant.id, 'default');
  const deniedInvitations = await invitedContext.request.get(origin + '/api/v1/member-invitations');
  assert.equal(deniedInvitations.status(), 403);
  await invitedPage.goto(origin + '/members');
  assert.equal(await invitedPage.getByRole('button', { name: '创建成员邀请', exact: true }).count(), 0);
  await userPage.getByRole('button', { name: '刷新邀请', exact: true }).click();
  await userPage.locator('tbody tr').filter({ hasText: '受邀浏览器成员' }).getByText('已使用', { exact: true }).waitFor();
  const replay = await fetch(origin + '/api/v1/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite: inviteCode, login: 'browser-replayed-member', password }), signal: AbortSignal.timeout(10000) });
  assert.equal(replay.status, 403);

  mark('invitation-revoke-cancellation-failure-and-real-revocation');
  await userPage.getByRole('button', { name: '创建成员邀请', exact: true }).click();
  await userPage.getByLabel('邀请备注', { exact: true }).fill('待撤销邀请');
  await userPage.getByRole('button', { name: '生成一次性邀请码', exact: true }).click();
  await userPage.getByLabel('一次性邀请码', { exact: true }).waitFor();
  await userPage.getByRole('button', { name: '关闭并清除代码', exact: true }).click();
  const invitationRow = userPage.locator('tbody tr').filter({ hasText: '待撤销邀请' });
  userPage.once('dialog', (dialog) => dialog.dismiss());
  await invitationRow.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await invitationRow.count(), 1);
  await userPage.route('**/api/v1/member-invitations/*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'INVITATIONS_UNAVAILABLE: injected outage' }) }));
  userPage.once('dialog', (dialog) => dialog.accept());
  await invitationRow.getByRole('button', { name: '撤销', exact: true }).click();
  await userPage.getByText('暂时无法读取或管理邀请，请稍后重试', { exact: false }).waitFor();
  assert.equal(await invitationRow.count(), 1);
  await userPage.unroute('**/api/v1/member-invitations/*');
  userPage.once('dialog', (dialog) => dialog.accept());
  await invitationRow.getByRole('button', { name: '撤销', exact: true }).click();
  await invitationRow.waitFor({ state: 'detached' });

  mark('invitation-read-outage-does-not-invent-empty-list');
  await userPage.route('**/api/v1/member-invitations', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'INVITATIONS_UNAVAILABLE: injected outage' }) }));
  await userPage.getByRole('button', { name: '刷新邀请', exact: true }).click();
  await userPage.getByRole('alert').filter({ hasText: '暂时无法读取或管理邀请' }).waitFor();
  assert.equal(await userPage.getByText('还没有成员邀请', { exact: true }).count(), 0);
  await userPage.unroute('**/api/v1/member-invitations');
  await userPage.getByRole('button', { name: '刷新邀请', exact: true }).click();
  await userPage.locator('tbody tr').filter({ hasText: '受邀浏览器成员' }).waitFor();
  await userPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await userPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  mark('real-oidc-through-spa-preserves-target-and-rejects-stolen-binding-state-replay');
  const oidcContext = await browser.newContext();
  const oidcPage = await oidcContext.newPage();
  oidcPage.on('pageerror', (error) => pageErrors.push(error.name));
  const unboundContext = await browser.newContext();
  await oidcPage.goto(origin + '/login?return_to=' + encodeURIComponent('/security?tab=sessions#current'));
  const oidcLink = oidcPage.getByRole('link', { name: '使用 smoke-oidc 登录', exact: true });
  assert.equal(new URL(await oidcLink.getAttribute('href'), origin).pathname, '/api/v1/auth/start');
  await oidcLink.click();
  // 在提供方确认页停住，而不是依赖 Playwright 对 302 链中间请求的路由拦截。
  const authorizationLink = oidcPage.getByRole('link', { name: '确认登录', exact: true });
  const callbackURL = await authorizationLink.getAttribute('href');
  const authBinding = (await oidcContext.cookies(origin)).find((cookie) => cookie.name === 'xunara_auth');
  assert.equal(!!authBinding, true);
  assert.equal((await unboundContext.request.get(callbackURL, { maxRedirects: 0 })).status(), 400);
  const tampered = new URL(callbackURL);
  tampered.searchParams.set('state', 'wrong-state');
  const exchangesBeforeValidation = tokenExchanges;
  assert.equal((await oidcContext.request.get(tampered.href, { maxRedirects: 0 })).status(), 403);
  assert.equal(tokenExchanges, exchangesBeforeValidation);
  await authorizationLink.click();
  await oidcPage.waitForURL(origin + '/security?tab=sessions#current');
  const oidcSnapshot = await oidcContext.request.get(origin + '/api/v1/auth/session').then((response) => response.json());
  assert.equal(oidcSnapshot.user.role, 'member');
  assert.notEqual(oidcSnapshot.user.id, 1);
  assert.equal(oidcSnapshot.user.email, 'same-email@example.invalid');
  await assertSecretNotStored(oidcPage, lastAccessToken);
  const exchangesBeforeReplay = tokenExchanges;
  assert.equal((await unboundContext.request.get(callbackURL, { maxRedirects: 0, headers: { Cookie: `${authBinding.name}=${authBinding.value}` } })).status(), 400);
  assert.equal(tokenExchanges, exchangesBeforeReplay);

  mark('real-oidc-preserves-backend-device-authorization-target');
  const deviceContext = await browser.newContext();
  const devicePage = await deviceContext.newPage();
  devicePage.on('pageerror', (error) => pageErrors.push(error.name));
  await devicePage.goto(origin + '/login?return_to=' + encodeURIComponent('/register/oidc-browser-target'));
  await devicePage.getByRole('link', { name: '使用 smoke-oidc 登录', exact: true }).click();
  const deviceResponse = devicePage.waitForResponse((response) => new URL(response.url()).pathname === '/register/oidc-browser-target');
  await devicePage.getByRole('link', { name: '确认登录', exact: true }).click();
  assert.equal((await deviceResponse).status(), 404);
  await devicePage.waitForURL(origin + '/register/oidc-browser-target');

  mark('real-oidc-rejects-invalid-rsa-signature-and-nonce');
  for (const mode of ['signature', 'nonce']) {
    issuerMode = mode;
    const rejectedContext = await browser.newContext();
    const rejectedPage = await rejectedContext.newPage();
    await rejectedPage.goto(origin + '/login');
    await rejectedPage.getByRole('link', { name: '使用 smoke-oidc 登录', exact: true }).click();
    const rejectedCallback = rejectedPage.waitForResponse((response) => new URL(response.url()).pathname === '/oidc/callback/smoke-oidc');
    await rejectedPage.getByRole('link', { name: '确认登录', exact: true }).click();
    assert.equal((await rejectedCallback).status(), 403);
    assert.equal((await rejectedContext.request.get(origin + '/api/v1/auth/session').then((response) => response.json())).authenticated, false);
    await rejectedContext.close();
  }
  issuerMode = 'valid';
  mark('legacy-oidc-bookmark-forwards-to-the-same-api-flow');
  const legacyContext = await browser.newContext();
  const legacyPage = await legacyContext.newPage();
  legacyPage.on('pageerror', (error) => pageErrors.push(error.name));
  await legacyPage.goto(origin + '/login?provider=smoke-oidc&return_to=' + encodeURIComponent('/security?legacy=1'));
  await legacyPage.getByRole('link', { name: '确认登录', exact: true }).click();
  await legacyPage.waitForURL(origin + '/security?legacy=1');
  assert.equal((await legacyContext.request.get(origin + '/api/v1/auth/session').then((response) => response.json())).authenticated, true);
  await runNetworkSmoke({ page: userPage, memberPage: invitedPage, origin, state, mark, assertSecretNotStored });
  await runAddressRelaySmoke({ page: userPage, memberPage: invitedPage, origin, mark, upgrade: async () => {
    const response = await api('/api/platform/v1/organizations/default/plan', platformToken, { plan_id: 'pro' }, 'PATCH');
    assert.equal(response.status, 200);
  } });
  assert.equal(pageErrors.length, 0);
  console.log(JSON.stringify({ passed: true, stages: completed, javascript_errors: pageErrors.length, fixture: 'isolated ephemeral tenant' }));
}

// 失败输出只有阶段与错误类型，不能把断言中的请求正文或凭据顺带打印。
main().catch((error) => {
  const locations = error.stack?.split('\n').filter((line) => line.includes(__filename) || line.includes('network-browser-smoke.cjs') || line.includes('relay-history-browser-smoke.cjs'));
  console.error(JSON.stringify({ failed_stage: stage, error_type: error.name, locations }));
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  if (issuer) { issuer.closeAllConnections(); await new Promise((resolve) => issuer.close(resolve)); }
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((resolve) => daemon.once('exit', resolve));
    daemon.kill('SIGTERM');
    await exited;
  }
  fs.rmSync(state, { recursive: true, force: true });
});
