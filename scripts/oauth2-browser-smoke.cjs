const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// 隔离的 GitLab 风格 OAuth2 服务，不签 ID Token，不接公网，不将夹具内存用作生产会话。
function createOAuth2Fixture({ origin, secret }) {
  const codes = new Map();
  const tokens = new Map();
  let subject = 70001;
  let mode = 'valid';
  let exchanges = 0;
  let lastToken = '';
  return {
    setSubject(value) { subject = value; },
    setMode(value) { mode = value; },
    get exchanges() { return exchanges; },
    get lastToken() { return lastToken; },
    async serve(request, response) {
      const endpoint = new URL(request.url, 'http://localhost');
      const json = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(payload)); };
      if (endpoint.pathname === '/oauth-smoke/oauth/authorize') {
        const query = endpoint.searchParams;
        if (query.get('client_id') !== 'browser-oauth2' || query.get('redirect_uri') !== origin + '/oauth2/callback/smoke-oauth2' || query.get('response_type') !== 'code' || query.get('scope') !== 'read_user' || query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge') || !query.get('state') || query.has('nonce') || query.has('client_secret')) { json(400, { error: 'invalid_request' }); return; }
        const code = crypto.randomBytes(32).toString('base64url');
        codes.set(code, { challenge: query.get('code_challenge'), redirect: query.get('redirect_uri'), subject, mode, expires: Date.now() + 60000 });
        const callback = new URL(query.get('redirect_uri'));
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', query.get('state'));
        const escaped = callback.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(`<html lang="zh-CN"><body><a href="${escaped}">确认 OAuth2 授权</a></body></html>`);
        return;
      }
      if (endpoint.pathname === '/oauth-smoke/oauth/token' && request.method === 'POST') {
        if (endpoint.search) { json(400, { error: 'invalid_request' }); return; }
        request.setTimeout(5000, () => request.destroy());
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 8192) { json(413, { error: 'invalid_request' }); return; } }
        const values = new URLSearchParams(body);
        const code = values.get('code');
        const authorization = codes.get(code);
        const challenge = crypto.createHash('sha256').update(values.get('code_verifier') || '').digest('base64url');
        if (!authorization || authorization.expires <= Date.now() || values.get('client_id') !== 'browser-oauth2' || values.get('client_secret') !== secret || values.get('grant_type') !== 'authorization_code' || authorization.redirect !== values.get('redirect_uri') || authorization.challenge !== challenge) { json(400, { error: 'invalid_grant' }); return; }
        codes.delete(code);
        lastToken = crypto.randomBytes(32).toString('base64url');
        tokens.set(lastToken, authorization);
        exchanges++;
        json(200, { token_type: 'Bearer', access_token: lastToken, expires_in: 60 });
        return;
      }
      if (endpoint.pathname === '/oauth-smoke/api/v4/user' && request.method === 'GET') {
        if (endpoint.search) { json(400, { error: 'invalid_request' }); return; }
        const authorization = tokens.get((request.headers.authorization || '').replace(/^Bearer /, ''));
        if (!authorization || authorization.expires <= Date.now()) { json(401, { error: 'unauthorized' }); return; }
        json(200, { id: authorization.mode === 'missing-subject' ? undefined : authorization.subject, username: 'renamable-login', name: 'OAuth2 验收成员', email: 'same-email@example.invalid', is_admin: true, api_key: 'discard-this-profile-secret' });
        return;
      }
      json(404, { error: 'not_found' });
    },
  };
}

async function runOAuth2Smoke({ browser, origin, ownerPage, ownerContext, fixture, mark, assertSecretNotStored, pageErrors }) {
  const newPage = async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.name));
    return { context, page };
  };
  const snapshot = async (context) => context.request.get(origin + '/api/v1/auth/session').then((response) => response.json());
  const members = async () => ownerContext.request.get(origin + '/api/v1/users').then((response) => response.json());
  const capabilities = await ownerContext.request.get(origin + '/api/v1/capabilities').then((response) => response.json());
  assert.equal(capabilities.capabilities.includes('auth.oauth2'), true);
  assert.equal(capabilities.capabilities.includes('auth.oidc'), true);

  mark('native-oauth2-unknown-identity-cannot-bypass-invite');
  const denied = await newPage();
  await denied.page.goto(origin + '/login');
  await denied.page.getByRole('link', { name: '使用 OAuth2 验收 登录', exact: true }).click();
  const deniedCallback = denied.page.waitForResponse((response) => new URL(response.url()).pathname === '/oauth2/callback/smoke-oauth2');
  await denied.page.getByRole('link', { name: '确认 OAuth2 授权', exact: true }).click();
  assert.equal((await deniedCallback).status(), 303);
  await denied.page.getByRole('heading', { name: '未能完成授权', exact: true }).waitFor();
  assert.equal((await snapshot(denied.context)).authenticated, false);
  await denied.context.close();

  mark('native-oauth2-invitation-creates-distinct-human-without-role-claims');
  const before = await members();
  const invitationPolicy = await ownerContext.request.get(origin + '/api/v1/member-invitations').then((response) => response.json());
  const issued = await ownerContext.request.post(origin + '/api/v1/member-invitations', { headers: { 'X-CSRF-Token': invitationPolicy.csrf_token }, data: { role: 'member', note: '原生 OAuth2 验收', ttl_hours: 24 } });
  assert.equal(issued.status(), 201);
  const invite = await issued.json();
  const member = await newPage();
  await member.page.goto(origin + '/register');
  await member.page.getByLabel('邀请码', { exact: true }).fill(invite.code);
  await member.page.getByRole('button', { name: '使用 OAuth2 验收 加入网络', exact: true }).click();
  const memberCallback = await member.page.getByRole('link', { name: '确认 OAuth2 授权', exact: true }).getAttribute('href');
  assert.equal(memberCallback.includes(invite.code), false);
  await member.page.getByRole('link', { name: '确认 OAuth2 授权', exact: true }).click();
  await member.page.waitForURL('**/dashboard');
  const memberSnapshot = await snapshot(member.context);
  assert.equal(memberSnapshot.user.role, 'member');
  assert.match(memberSnapshot.user.login_name, /^smoke-oauth2_[a-f0-9]{16}$/);
  assert.notEqual(memberSnapshot.user.id, 1);
  assert.equal(memberSnapshot.user.email, 'same-email@example.invalid');
  assert.equal((await members()).users.length, before.users.length + 1);
  assert.equal((await member.context.request.get(memberCallback, { maxRedirects: 0 })).status(), 400);
  await assertSecretNotStored(member.page, invite.code);
  await assertSecretNotStored(member.page, fixture.lastToken);

  mark('native-oauth2-last-login-method-is-protected');
  await member.page.goto(origin + '/security');
  member.page.once('dialog', (dialog) => dialog.accept());
  await member.page.getByRole('region', { name: '第三方账号绑定', exact: true }).getByRole('button', { name: '解除绑定', exact: true }).click();
  await member.page.getByRole('alert').filter({ hasText: '不能解绑最后一种可用登录方式' }).waitFor();
  assert.equal((await snapshot(member.context)).authenticated, true);

  mark('native-oauth2-invalid-profile-fails-without-account-or-session');
  fixture.setMode('missing-subject');
  const malformed = await newPage();
  await malformed.page.goto(origin + '/login');
  await malformed.page.getByRole('link', { name: '使用 OAuth2 验收 登录', exact: true }).click();
  const malformedCallback = malformed.page.waitForResponse((response) => new URL(response.url()).pathname === '/oauth2/callback/smoke-oauth2');
  await malformed.page.getByRole('link', { name: '确认 OAuth2 授权', exact: true }).click();
  assert.equal((await malformedCallback).status(), 303);
  await malformed.page.getByRole('heading', { name: '未能完成授权', exact: true }).waitFor();
  assert.equal((await snapshot(malformed.context)).authenticated, false);
  assert.equal((await members()).users.length, before.users.length + 1);
  await malformed.context.close();
  fixture.setMode('valid');

  mark('native-oauth2-binding-requires-current-human-and-does-not-merge-email');
  fixture.setSubject(70002);
  await ownerPage.goto(origin + '/security');
  const bindings = ownerPage.getByRole('region', { name: '第三方账号绑定', exact: true });
  await bindings.getByRole('button', { name: '绑定 OAuth2 验收', exact: true }).click();
  const confirm = ownerPage.getByRole('link', { name: '确认 OAuth2 授权', exact: true });
  const callback = await confirm.getAttribute('href');
  const bindingCookie = (await ownerContext.cookies()).find((cookie) => cookie.name === 'xunara_auth');
  const exchangesBefore = fixture.exchanges;
  const stolen = await newPage();
  assert.equal((await stolen.context.request.get(callback, { maxRedirects: 0, headers: { Cookie: `${bindingCookie.name}=${bindingCookie.value}` } })).status(), 403);
  assert.equal(fixture.exchanges, exchangesBefore);
  await stolen.context.close();
  await confirm.click();
  await ownerPage.waitForURL((target) => target.pathname === '/security');
  await bindings.getByText('已绑定', { exact: true }).waitFor();
  assert.equal((await snapshot(ownerContext)).user.id, 1);
  assert.equal((await members()).users.length, before.users.length + 1);
  const identityMetadata = await ownerContext.request.get(origin + '/api/v1/account/identities').then((response) => response.json());
  assert.equal(JSON.stringify(identityMetadata).includes('discard-this-profile-secret'), false);

  mark('native-oauth2-state-browser-binding-and-return-target');
  const sso = await newPage();
  await sso.page.goto(origin + '/login?return_to=' + encodeURIComponent('/security?oauth2=1'));
  await sso.page.getByRole('link', { name: '使用 OAuth2 验收 登录', exact: true }).click();
  const authorization = sso.page.getByRole('link', { name: '确认 OAuth2 授权', exact: true });
  const authorizationURL = await authorization.getAttribute('href');
  const tampered = new URL(authorizationURL);
  tampered.searchParams.set('state', 'not-the-state');
  const validExchanges = fixture.exchanges;
  assert.equal((await sso.context.request.get(tampered.href, { maxRedirects: 0 })).status(), 403);
  assert.equal(fixture.exchanges, validExchanges);
  await authorization.click();
  await sso.page.waitForURL(origin + '/security?oauth2=1');
  assert.equal((await snapshot(sso.context)).user.id, 1);
  await assertSecretNotStored(sso.page, fixture.lastToken);
  for (const width of [320, 390, 768]) {
    await ownerPage.setViewportSize({ width, height: 844 });
    assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }

  mark('native-oauth2-unlink-revokes-only-source-sessions');
  ownerPage.once('dialog', (dialog) => dialog.accept());
  await bindings.getByRole('button', { name: '解除绑定', exact: true }).click();
  await bindings.getByRole('button', { name: '绑定 OAuth2 验收', exact: true }).waitFor();
  assert.equal((await snapshot(sso.context)).authenticated, false);
  assert.equal((await snapshot(ownerContext)).authenticated, true);
  assert.equal((await snapshot(member.context)).authenticated, true);
  await sso.context.close();
  await member.context.close();
}

module.exports = { createOAuth2Fixture, runOAuth2Smoke };
