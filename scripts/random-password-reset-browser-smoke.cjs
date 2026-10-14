const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

async function runRandomPasswordResetSmoke({ adminPage, invitedPage, ownerPage, newPage, member, origin, databaseFile, api, browserAPI, mark, restart }) {
  const resetPath = `/api/platform/v1/organizations/portal/users/${member.id}/password-reset/random`;
  const row = () => adminPage.locator('tbody tr').filter({ hasText: 'invited-member' });
  const holder = () => adminPage.getByLabel('我已通过可靠渠道核实账号持有人', { exact: true });
  const reason = () => adminPage.getByLabel('重置原因（必填）', { exact: true });
  const submit = () => adminPage.getByRole('button', { name: '确认重置密码', exact: true });
  let writes = 0;
  adminPage.on('request', (request) => { if (new URL(request.url()).pathname === resetPath && request.method() === 'POST') writes++; });
  mark('random-password-reset-cancel-ownership-mobile-and-stale-version');
  for (const width of [320, 390, 768]) {
    await adminPage.setViewportSize({ width, height: 844 });
    await row().getByRole('button', { name: '重置密码', exact: true }).click();
    await adminPage.getByRole('dialog').waitFor();
    assert.equal(await submit().isDisabled(), true);
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const box = await adminPage.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 845);
    await reason().fill('取消不重置'); await holder().check();
    await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  }
  assert.equal(writes, 0);
  await row().getByRole('button', { name: '重置密码', exact: true }).click();
  assert.equal(await reason().inputValue(), '');
  await reason().fill('已独立核实持有人'); await holder().check();
  const original = (await api('/api/platform/v1/users').then((response) => response.json())).users.find((user) => user.org === 'portal' && user.id === member.id);
  const ownerAccount = await browserAPI(ownerPage, '/api/v1/account').then((response) => response.json());
  assert.equal((await browserAPI(ownerPage, `/api/v1/users/${member.id}`, { method: 'PATCH', headers: { 'X-CSRF-Token': ownerAccount.csrf_token },
    body: { displayName: '恢复前已复核', expectedUpdatedAt: original.updatedAt } })).status(), 200);
  let response = adminPage.waitForResponse((answer) => new URL(answer.url()).pathname === resetPath && answer.request().method() === 'POST');
  await submit().click(); assert.equal((await response).status(), 409);
  assert.equal(await reason().inputValue(), '已独立核实持有人');
  assert.equal(await submit().isDisabled(), true);
  await adminPage.getByRole('button', { name: '刷新核对账号', exact: true }).click();
  await adminPage.getByText('已刷新真实状态，请重新核实持有人并确认；再次重置会使此前的临时密码失效', { exact: true }).waitFor();
  assert.equal(await holder().isChecked(), false); await holder().check();
  response = adminPage.waitForResponse((answer) => new URL(answer.url()).pathname === resetPath && answer.request().method() === 'POST');
  await submit().click();
  const first = await response; assert.equal(first.status(), 200);
  const firstResult = await first.json();
  const firstPassword = firstResult.temporaryPassword;
  assert.match(firstPassword, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(firstResult.passwordChangeRequired, true); assert.equal(firstResult.passwordChanged, true);
  assert.ok(firstResult.sessionsRevoked > 0); assert.equal(first.headers()['cache-control'], 'no-store');
  assert.equal(await adminPage.getByLabel('随机临时密码', { exact: true }).inputValue(), firstPassword);
  await adminPage.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await adminPage.getByRole('button', { name: '复制临时密码', exact: true }).click();
  assert.equal(await adminPage.evaluate(() => navigator.clipboard.readText()), firstPassword);
  await adminPage.evaluate(() => navigator.clipboard.writeText(''));
  await adminPage.getByRole('button', { name: '关闭并清除本页密码', exact: true }).click();
  assert.equal((await adminPage.locator('body').innerText()).includes(firstPassword), false);
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 401);
  assert.equal((await browserAPI(ownerPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(newPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(ownerPage, resetPath, { method: 'POST', body: { reason: '无平台权限', expected_updated_at: firstResult.updatedAt, ownership_verified: true } })).status(), 401);

  mark('random-password-reset-audit-failure-preserves-password-and-requires-explicit-refresh');
  await row().getByRole('button', { name: '重置密码', exact: true }).click();
  await reason().fill('再次核实临时密码交付'); await holder().check();
  let passwordHash;
  const fault = new DatabaseSync(databaseFile);
  try {
    passwordHash = Buffer.from(fault.prepare('SELECT password_hash FROM local_credentials WHERE user_id = ?').get(member.id).password_hash);
    fault.exec("CREATE TRIGGER random_reset_fault BEFORE INSERT ON audit_events WHEN NEW.action = 'user.password_reset' BEGIN SELECT RAISE(ABORT, 'isolated reset audit failure'); END");
  } finally { fault.close(); }
  response = adminPage.waitForResponse((answer) => new URL(answer.url()).pathname === resetPath && answer.request().method() === 'POST');
  await submit().click(); assert.equal((await response).status(), 503);
  assert.equal(await submit().isDisabled(), true);
  assert.equal(await reason().inputValue(), '再次核实临时密码交付');
  const checked = new DatabaseSync(databaseFile);
  try {
    assert.equal(Buffer.compare(Buffer.from(checked.prepare('SELECT password_hash FROM local_credentials WHERE user_id = ?').get(member.id).password_hash), passwordHash), 0);
    assert.equal(checked.prepare('SELECT password_change_required FROM users WHERE id = ?').get(member.id).password_change_required, 1);
    checked.exec('DROP TRIGGER random_reset_fault');
  } finally { checked.close(); }
  await adminPage.getByRole('button', { name: '刷新核对账号', exact: true }).click();
  await adminPage.getByText('已刷新真实状态，请重新核实持有人并确认；再次重置会使此前的临时密码失效', { exact: true }).waitFor();
  await holder().check();
  response = adminPage.waitForResponse((answer) => new URL(answer.url()).pathname === resetPath && answer.request().method() === 'POST');
  await submit().click();
  const second = await response; assert.equal(second.status(), 200);
  const temporaryPassword = (await second.json()).temporaryPassword;
  assert.notEqual(temporaryPassword, firstPassword);
  await adminPage.getByRole('button', { name: '关闭并清除本页密码', exact: true }).click();
  await restart();

  mark('random-password-reset-restart-retired-code-flow-and-mandatory-first-change');
  assert.equal((await browserAPI(invitedPage, '/api/v1/auth/password-reset', { method: 'POST', body: { code: 'old-code' } })).status(), 410);
  await invitedPage.goto(origin + '/reset-password?code=not-a-secret');
  await invitedPage.waitForURL((url) => url.pathname === '/reset-password' && url.search === '');
  await invitedPage.getByText('联系平台管理员恢复账号，无需重置码。', { exact: true }).waitFor();
  assert.equal(await invitedPage.locator('input').count(), 0);
  assert.equal((await browserAPI(invitedPage, '/api/v1/auth/login', { method: 'POST', body: { login: 'invited-member', password: firstPassword } })).status(), 401);
  async function temporaryLogin() {
    await invitedPage.goto(origin + '/login');
    await invitedPage.getByLabel('登录名', { exact: true }).fill('invited-member');
    await invitedPage.getByLabel('密码', { exact: true }).fill(temporaryPassword);
    await invitedPage.getByRole('button', { name: '登录', exact: true }).click();
    await invitedPage.waitForURL('**/change-password');
    await invitedPage.getByLabel('临时密码 / 当前密码', { exact: true }).waitFor();
  }
  await temporaryLogin();
  for (const width of [320, 390, 768]) {
    await invitedPage.setViewportSize({ width, height: 844 });
    assert.equal(await invitedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  assert.equal((await browserAPI(invitedPage, '/api/v1/machines')).status(), 403);
  assert.equal((await browserAPI(invitedPage, '/api/v1/account/passkeys')).status(), 403);
  await invitedPage.goto(origin + '/devices'); await invitedPage.waitForURL('**/change-password');
  const replacementPassword = crypto.randomBytes(24).toString('base64url');
  async function fillChange() {
    await invitedPage.getByLabel('临时密码 / 当前密码', { exact: true }).fill(temporaryPassword);
    await invitedPage.getByLabel('新密码', { exact: true }).fill(replacementPassword);
    await invitedPage.getByLabel('确认新密码', { exact: true }).fill(replacementPassword);
  }
  await fillChange();
  const changeFault = new DatabaseSync(databaseFile);
  try { changeFault.exec("CREATE TRIGGER personal_change_fault BEFORE INSERT ON audit_events WHEN NEW.action = 'user.password_changed' BEGIN SELECT RAISE(ABORT, 'isolated personal audit failure'); END"); }
  finally { changeFault.close(); }
  let changeResponse = invitedPage.waitForResponse((answer) => answer.url().endsWith('/api/v1/account/password') && answer.request().method() === 'POST');
  await invitedPage.getByRole('button', { name: '保存新密码并重新登录', exact: true }).click();
  assert.equal((await changeResponse).status(), 500);
  assert.equal(await invitedPage.getByLabel('临时密码 / 当前密码', { exact: true }).inputValue(), '');
  assert.equal(await invitedPage.getByLabel('新密码', { exact: true }).inputValue(), '');
  assert.equal(await invitedPage.getByRole('button', { name: '保存新密码并重新登录', exact: true }).isDisabled(), true);
  const verified = new DatabaseSync(databaseFile);
  try {
    assert.equal(verified.prepare('SELECT password_change_required FROM users WHERE id = ?').get(member.id).password_change_required, 1);
    verified.exec('DROP TRIGGER personal_change_fault');
  } finally { verified.close(); }
  await invitedPage.getByRole('button', { name: '退出登录', exact: true }).click();
  await invitedPage.waitForURL('**/login');
  await temporaryLogin(); await fillChange();

  mark('random-password-reset-personal-password-completes-flow-with-no-secret-storage');
  changeResponse = invitedPage.waitForResponse((answer) => answer.url().endsWith('/api/v1/account/password') && answer.request().method() === 'POST');
  await invitedPage.getByRole('button', { name: '保存新密码并重新登录', exact: true }).click();
  assert.equal((await changeResponse).status(), 200);
  await invitedPage.waitForURL((url) => url.pathname === '/login' && url.searchParams.get('password_changed') === '1');
  assert.equal((await browserAPI(invitedPage, '/api/v1/account')).status(), 401);
  assert.equal((await browserAPI(ownerPage, '/api/v1/account')).status(), 200);
  assert.equal((await browserAPI(newPage, '/api/v1/account')).status(), 200);
  await invitedPage.getByLabel('登录名', { exact: true }).fill('invited-member');
  await invitedPage.getByLabel('密码', { exact: true }).fill(replacementPassword);
  await invitedPage.getByRole('button', { name: '登录', exact: true }).click();
  await invitedPage.waitForURL('**/dashboard');
  const secrets = [firstPassword, temporaryPassword, replacementPassword];
  const final = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    assert.equal(final.prepare('SELECT password_change_required FROM users WHERE id = ?').get(member.id).password_change_required, 0);
    assert.equal(final.prepare('SELECT COUNT(*) AS count FROM password_reset_tickets').get().count, 0);
    const persisted = JSON.stringify(final.prepare('SELECT actor, action, target, detail FROM audit_events').all());
    for (const secret of secrets) assert.equal(persisted.includes(secret), false);
  } finally { final.close(); }
  for (const page of [adminPage, invitedPage]) {
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of secrets) { assert.equal(storage.includes(secret), false); assert.equal(page.url().includes(secret), false); }
  }
  return secrets;
}

module.exports = { runRandomPasswordResetSmoke };
