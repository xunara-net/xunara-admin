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

const binary = process.env.SMOKE_XUNARAD;
const dist = path.resolve(__dirname, '../dist');
if (!binary || !fs.existsSync(binary) || !fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build server/admin and set SMOKE_XUNARAD');
process.umask(0o077);
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'xunara-platform-account-'));
const recovery = crypto.randomBytes(32).toString('base64url');
const password = crypto.randomBytes(24).toString('base64url');
const completed = [], errors = [];
let stage = 'startup', daemon, browser, proxy, origin, control, daemonArguments;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function mark(value) { stage = value; completed.push(value); console.log(JSON.stringify({ stage })); }
async function port() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
function serve(request, response) {
  const pathname = new URL(request.url, origin).pathname;
  if (pathname.startsWith('/api/') || pathname === '/health') {
    const upstream = http.request(control + request.url, { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream); return;
  }
  const relative = pathname.slice('/admin'.length);
  const asset = relative.startsWith('/assets/') ? path.resolve(dist, '.' + relative) : path.join(dist, 'index.html');
  if (!asset.startsWith(dist + path.sep) || !fs.existsSync(asset)) { response.writeHead(404); response.end(); return; }
  const extension = path.extname(asset);
  response.writeHead(200, { 'Content-Type': extension === '.js' ? 'application/javascript' : extension === '.css' ? 'text/css' : 'text/html; charset=utf-8' }); fs.createReadStream(asset).pipe(response);
}
function api(endpoint, token = recovery) {
  return new Promise((resolve, reject) => {
    const request = http.request(control + endpoint, { headers: { Host: new URL(origin).host, Authorization: 'Bearer ' + token } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
    }); request.setTimeout(15000, () => request.destroy()); request.on('error', reject); request.end();
  });
}
function start() {
  const log = fs.openSync(path.join(state, 'daemon.log'), 'a', 0o600);
  daemon = spawn(binary, daemonArguments, { env: { ...process.env, XUNARA_PLATFORM_ADMIN_TOKEN: recovery }, stdio: ['ignore', log, log] }); fs.closeSync(log);
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) throw new Error('isolated daemon exited');
    try { if ((await api('/health')).status === 200) return; } catch {}
    await sleep(100);
  }
  throw new Error('daemon not ready');
}
async function tokenLogin(page) {
  await page.goto(origin + '/admin/login');
  await page.getByLabel('平台管理令牌', { exact: true }).fill(recovery);
  await page.getByRole('button', { name: '进入后台', exact: true }).click();
  await page.waitForURL('**/admin/dashboard');
  const value = await page.evaluate(() => sessionStorage.getItem('xunara.admin.token'));
  assert(value && value !== recovery);
  assert.equal(await page.evaluate(secret => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(secret), recovery), false);
  return value;
}
async function addKey(page, name) {
  await page.getByRole('button', { name: '绑定通行密钥', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '开始绑定', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText(name, { exact: true }).waitFor();
}
async function main() {
  const keyFile = path.join(state, 'test-key.pem'), certFile = path.join(state, 'test-cert.pem');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=admin.example.test', '-addext', 'subjectAltName=DNS:admin.example.test'], { stdio: 'ignore' }).status, 0);
  const certificate = fs.readFileSync(certFile);
  const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  proxy = https.createServer({ key: fs.readFileSync(keyFile), cert: certificate }, serve);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  origin = `https://admin.example.test:${proxy.address().port}`;
  control = `http://127.0.0.1:${await port()}`;
  daemonArguments = ['-listen', new URL(control).host, '-server-url', origin, '-state-dir', path.join(state, 'tenant'), '-allow-local-login', '-registration', 'closed', '-log-level', 'error'];
  start(); await ready();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BINARY || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--host-resolver-rules=MAP admin.example.test 127.0.0.1', '--ignore-certificate-errors-spki-list=' + spki] });
  const context = await browser.newContext();
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.name));
  mark('recovery-exchange-without-persisting-recovery-secret');
  const firstSession = await tokenLogin(page);
  assert.equal((await api('/api/platform/v1/users', firstSession)).status, 200);

  mark('mobile-create-member-explicit-network-and-secret-cleanup');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(origin + '/admin/users');
  await page.getByRole('button', { name: '添加用户', exact: true }).click();
  await page.getByLabel('所属网络', { exact: true }).selectOption('default');
  await page.getByLabel('用户名', { exact: true }).fill('browser-member');
  await page.getByLabel('显示名称', { exact: true }).fill('后台新增用户');
  await page.getByLabel('初始密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '创建用户', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText('后台新增用户', { exact: true }).waitFor();
  const users = JSON.parse((await api('/api/platform/v1/users')).body).users;
  const member = users.find(user => user.login === 'browser-member');
  assert(member && member.org === 'default' && member.role === 'member' && member.sessions === 0);
  assert.equal(await page.evaluate(secret => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(secret), password), false);

  mark('multiple-passkeys-through-real-browser-virtual-authenticators');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const options = { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
  const firstAuthenticator = (await cdp.send('WebAuthn.addVirtualAuthenticator', { options })).authenticatorId;
  // 旧租户同域、同数字 ID 的驻留凭据，不能被新的平台绑定覆盖。
  const legacyKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const legacyId = crypto.randomBytes(32).toString('base64');
  const legacyHandle = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]).toString('base64');
  await cdp.send('WebAuthn.addCredential', { authenticatorId: firstAuthenticator, credential: {
    credentialId: legacyId, isResidentCredential: true, rpId: 'admin.example.test',
    privateKey: legacyKey.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), userHandle: legacyHandle, signCount: 0,
  } });
  await page.getByRole('button', { name: '管 平台管理员', exact: true }).click();
  await page.getByRole('button', { name: '管理员安全', exact: true }).click();
  await page.waitForURL('**/admin/security');
  await addKey(page, '手机密钥');
  const firstCredentials = (await cdp.send('WebAuthn.getCredentials', { authenticatorId: firstAuthenticator })).credentials;
  assert.equal(firstCredentials.length, 2);
  assert(firstCredentials.some(credential => credential.credentialId === legacyId && credential.userHandle === legacyHandle));
  assert(firstCredentials.some(credential => credential.userHandle !== legacyHandle));
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: firstAuthenticator });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options });
  await addKey(page, '备用密钥');
  await page.getByRole('heading', { name: '通行密钥 （2）', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  mark('administrator-identity-and-passkeys-survive-real-process-restart');
  daemon.kill('SIGTERM'); await new Promise(resolve => daemon.once('exit', resolve));
  start(); await ready(); await page.reload();
  await page.getByText('手机密钥', { exact: true }).waitFor();
  await page.getByText('备用密钥', { exact: true }).waitFor();
  assert.equal((await api('/api/platform/v1/users', firstSession)).status, 200);

  mark('logout-revokes-backend-session-and-passkey-login-succeeds');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByText('平台管理员', { exact: true }).click();
  await page.getByRole('button', { name: '退出后台', exact: true }).click();
  await page.waitForURL('**/admin/login');
  await page.reload();
  assert.equal((await api('/api/platform/v1/users', firstSession)).status, 401);
  await page.getByRole('button', { name: '使用通行密钥登录', exact: true }).click();
  await page.waitForURL('**/admin/dashboard');
  const passkeySession = await page.evaluate(() => sessionStorage.getItem('xunara.admin.token'));
  assert(passkeySession && passkeySession !== recovery);

  mark('unbind-revokes-passkey-sessions-and-remaining-key-logs-in');
  await page.goto(origin + '/admin/security');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('.key-row').filter({ hasText: '手机密钥' }).getByRole('button', { name: '解绑', exact: true }).click();
  await page.waitForURL('**/admin/login');
  assert.equal((await api('/api/platform/v1/users', passkeySession)).status, 401);
  await page.getByRole('button', { name: '使用通行密钥登录', exact: true }).click();
  await page.waitForURL('**/admin/dashboard');
  await page.goto(origin + '/admin/security');
  await page.getByText('备用密钥', { exact: true }).waitFor();
  assert.equal(await page.getByText('手机密钥', { exact: true }).count(), 0);
  await page.locator('.key-row').filter({ hasText: '备用密钥' }).getByRole('button', { name: '解绑', exact: true }).click();
  await page.waitForURL('**/admin/login');

  mark('recovery-still-works-after-unbinding-last-key');
  await tokenLogin(page);
  await page.goto(origin + '/admin/security');
  await page.getByText('尚未绑定通行密钥。', { exact: true }).waitFor();
  assert.equal(errors.length, 0);
  console.log(JSON.stringify({ ok: true, stages: completed.length, pageErrors: errors.length }));
}
main().catch(error => { console.error(JSON.stringify({ ok: false, stage, error: error.name, detail: error.message.replaceAll(recovery, '[redacted]').replaceAll(password, '[redacted]').slice(0, 600) })); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (daemon?.exitCode === null) daemon.kill('SIGTERM'); await new Promise(resolve => proxy ? proxy.close(resolve) : resolve());
});
