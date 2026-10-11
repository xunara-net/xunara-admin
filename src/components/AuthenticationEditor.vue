<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { errorMessage } from "../api/client";
import type { AuthenticationAPI, AuthenticationProvider, AuthenticationSettings, IdentityProviderType, MemberRegistration, NewIdentityProvider } from "../api/authentication-settings";
import ModalDialog from "./ModalDialog.vue";

const props = defineProps<{ api: AuthenticationAPI }>();
const data = ref<AuthenticationSettings | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const success = ref("");
const registration = ref<MemberRegistration>("closed");
const publicSignup = ref(false);
const dialogOpen = ref(false);
const editing = ref<AuthenticationProvider | null>(null);
const formError = ref("");
const providerID = ref("");
const providerType = ref<IdentityProviderType>("github");
const displayName = ref("");
const clientID = ref("");
const clientSecret = ref("");
const issuer = ref("");
const baseURL = ref("");
const authURL = ref("");
const tokenURL = ref("");
const userInfoURL = ref("");
const subjectField = ref("id");
const nameField = ref("name");
const usernameField = ref("");
const emailField = ref("email");
const authStyle = ref("client_secret_post");
const scopes = ref("");
const enabled = ref(false);
const activeProviders = computed(() => (data.value?.providers ?? []).filter((provider) => !provider.archived));
const archivedProviders = computed(() => (data.value?.providers ?? []).filter((provider) => provider.archived));
const policyDirty = computed(() => !!data.value && (registration.value !== data.value.registration ||
  data.value.can_manage_public_signup && publicSignup.value !== data.value.public_signup_enabled));
const callback = computed(() => {
  if (editing.value) return editing.value.callback_url;
  if (!providerID.value.trim() || !data.value?.control_url) return "输入提供方 ID 后显示固定回调地址";
  return data.value.control_url.replace(/\/$/, "") + (providerType.value === "oidc" ? "/oidc/callback/" : "/oauth2/callback/") + providerID.value.trim();
});
const typeNames: Record<string, string> = { oidc: "OpenID Connect", github: "GitHub", gitlab: "GitLab", gitea: "Gitea", generic: "通用 OAuth2", external: "部署适配器" };

onMounted(load);
onBeforeUnmount(() => { clientSecret.value = ""; });
function accept(value: AuthenticationSettings) {
  data.value = value;
  registration.value = value.registration;
  publicSignup.value = value.public_signup_enabled;
}
async function load() {
  if (busy.value) return;
  loading.value = true; error.value = ""; success.value = "";
  try { accept(await props.api.get()); }
  catch (failure) { data.value = null; error.value = errorMessage(failure); }
  finally { loading.value = false; }
}
async function savePolicy() {
  if (!data.value || busy.value || !policyDirty.value) return;
  if (registration.value === "open" && !window.confirm("开放后，任何访客都可加入当前网络成为普通成员，仍受套餐额度限制。确认开放？")) return;
  busy.value = true; error.value = ""; success.value = "";
  try {
    accept(await props.api.policy(data.value, registration.value, data.value.can_manage_public_signup ? publicSignup.value : undefined));
    success.value = "注册设置已生效，无需重启；已有成员、邀请记录和设备连接不变。";
  } catch (failure) { error.value = errorMessage(failure); }
  finally { busy.value = false; }
}
function begin(provider: AuthenticationProvider | null = null) {
  if (busy.value || loading.value || !data.value) return;
  editing.value = provider;
  providerID.value = provider?.id ?? "";
  providerType.value = provider && provider.type !== "external" ? provider.type : "github";
  displayName.value = provider?.display_name ?? "";
  clientID.value = provider?.client_id ?? "";
  clientSecret.value = "";
  issuer.value = ""; baseURL.value = ""; authURL.value = ""; tokenURL.value = ""; userInfoURL.value = "";
  subjectField.value = "id"; nameField.value = "name"; usernameField.value = ""; emailField.value = "email";
  authStyle.value = "client_secret_post"; scopes.value = "";
  enabled.value = provider?.enabled ?? false;
  formError.value = ""; dialogOpen.value = true;
}
function close() {
  if (busy.value) return;
  clientSecret.value = ""; formError.value = ""; dialogOpen.value = false;
}
function newProvider(): NewIdentityProvider {
  const provider: NewIdentityProvider = {
    id: providerID.value.trim(), type: providerType.value, display_name: displayName.value.trim(),
    client_id: clientID.value.trim(), client_secret: clientSecret.value, enabled: enabled.value,
  };
  const permissions = scopes.value.split(/[,\s]+/).filter(Boolean);
  if (permissions.length) provider.scopes = permissions;
  if (providerType.value === "oidc") provider.issuer = issuer.value.trim();
  if (providerType.value === "gitlab" || providerType.value === "gitea") provider.base_url = baseURL.value.trim();
  if (providerType.value === "generic") Object.assign(provider, {
    auth_url: authURL.value.trim(), token_url: tokenURL.value.trim(), userinfo_url: userInfoURL.value.trim(),
    subject_field: subjectField.value.trim(), name_field: nameField.value.trim(), username_field: usernameField.value.trim(),
    email_field: emailField.value.trim(), auth_style: authStyle.value,
  });
  return provider;
}
async function saveProvider() {
  if (!data.value || busy.value) return;
  formError.value = "";
  if (!displayName.value.trim() || !editing.value && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(providerID.value.trim()) || !clientID.value.trim())) {
    formError.value = "请填写显示名称、合法提供方 ID 和 Client ID。"; return;
  }
  if (!editing.value && providerType.value !== "oidc" && !clientSecret.value) {
    formError.value = "OAuth2 需要应用的 Client Secret；请从提供方应用管理页获取。"; return;
  }
  busy.value = true; error.value = ""; success.value = "";
  try {
    const result = editing.value
      ? await props.api.update(data.value, editing.value.id, { display_name: displayName.value.trim(), ...(clientSecret.value ? { client_secret: clientSecret.value } : {}) })
      : await props.api.create(data.value, newProvider());
    accept(result);
    dialogOpen.value = false;
    success.value = "登录提供方已保存。启用后可在登录页使用，或到安全中心绑定已有账户。";
  } catch (failure) { formError.value = errorMessage(failure); }
  finally {
    // 明文只用于这一次请求；失败也清除，不能缓存到浏览器或在重试中隐式复用。
    clientSecret.value = ""; busy.value = false;
  }
}
async function toggle(provider: AuthenticationProvider) {
  if (!data.value || busy.value) return;
  if (provider.enabled && !window.confirm("停用后不能再使用此提供方登录或绑定。已有绑定、会话和设备保留；若有账户只依赖它登录，服务端会拒绝停用。继续？")) return;
  busy.value = true; error.value = ""; success.value = "";
  try {
    accept(await props.api.update(data.value, provider.id, { enabled: !provider.enabled }));
    success.value = provider.enabled ? "登录提供方已停用，已有绑定保留。" : "登录提供方已启用。";
  } catch (failure) { error.value = errorMessage(failure); }
  finally { busy.value = false; }
}
async function archive(provider: AuthenticationProvider) {
  if (!data.value || busy.value || !window.confirm("归档会永久停用此提供方并清除保存的应用密钥；已有绑定和记录保留，ID 不能再用于其他身份域。确认？")) return;
  busy.value = true; error.value = ""; success.value = "";
  try { accept(await props.api.archive(data.value, provider.id)); success.value = "提供方已归档，身份记录保留。"; }
  catch (failure) { error.value = errorMessage(failure); }
  finally { busy.value = false; }
}
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); success.value = "固定回调地址已复制。"; }
  catch { error.value = "浏览器不允许复制，请手动选中回调地址。"; }
}
</script>

<template>
  <div class="authentication-editor stack">
    <p v-if="loading" role="status">正在读取网络登录设置…</p>
    <div v-if="error" class="alert error" role="alert">{{ error }}</div>
    <div v-if="success" class="alert success" role="status">{{ success }}</div>
    <button v-if="!loading && !data" class="btn" @click="load">重新读取设置</button>
    <template v-if="data && !loading">
      <section class="card">
        <div class="card-head"><h2>成员加入方式</h2><button class="btn small" :disabled="busy" @click="load">刷新设置</button></div>
        <form class="card-body stack" @submit.prevent="savePolicy">
          <div class="field"><label for="member-registration-policy">当前网络注册策略</label>
            <select id="member-registration-policy" v-model="registration" class="input" :disabled="busy">
              <option value="closed">关闭加入 · 只允许已有成员登录</option>
              <option value="invite">邀请加入 · 必须输入一次性邀请码</option>
              <option v-if="!data.self_service" value="open">开放加入 · 访客可成为普通成员</option>
            </select>
          </div>
          <p class="hint">启用邀请后，所有者可在「成员与权限」生成邀请码。关闭后保留邀请历史，不删除成员；再次启用时，尚未使用且未到期的邀请码仍有效。成员数量始终按套餐限制。</p>
          <p v-if="data.self_service" class="alert info">此站点同时是独立网络开户入口。这里的成员邀请只加入当前网络，不会影响其他用户创建自己的网络空间。</p>
          <label v-if="data.can_manage_public_signup" class="checkbox"><input v-model="publicSignup" type="checkbox" :disabled="busy" />允许访客注册账户并创建独立网络</label>
          <p v-else-if="data.self_service" class="hint">独立网络公开开户目前{{ data.public_signup_enabled ? "已开放" : "已关闭" }}，仅平台管理员可调整。</p>
          <div class="action-row"><button class="btn primary" :disabled="busy || !policyDirty" type="submit">{{ busy ? "保存中…" : "保存注册设置" }}</button><span class="hint">密码登录{{ data.local_login ? "保留启用" : "由部署配置关闭" }}，已有设备不会被重新审批。</span></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>第三方登录</h2><p class="hint">应用配置属于本网络，不是个人账号绑定。</p></div><button class="btn primary small" :disabled="busy" @click="begin()">添加登录提供方</button></div>
        <div class="card-body stack">
          <p v-if="!activeProviders.length" class="muted">还没有配置第三方登录。添加 GitHub、GitLab、Gitea、通用 OAuth2 或企业 OIDC，配置应用后再启用。</p>
          <article v-for="provider in activeProviders" :key="provider.id" class="provider-row">
            <div class="provider-title"><strong>{{ provider.display_name || provider.id }}</strong><span class="badge" :class="provider.enabled ? 'success' : ''">{{ provider.enabled ? "已启用" : "已停用" }}</span><span class="hint">{{ typeNames[provider.type] }} · {{ provider.source === "deployment" ? "部署配置" : "页面配置" }}</span></div>
            <p class="hint">ID：{{ provider.id }} · Client ID：{{ provider.client_id || "自定义适配器" }} · {{ provider.secret_configured ? "密钥已安全保存（不可读取）" : "未配置密钥 / 公共客户端" }}</p>
            <details><summary>回调与身份域</summary><div class="provider-details">
              <p class="mono">{{ provider.callback_url }}</p><button class="btn small" @click="copy(provider.callback_url)">复制回调地址</button>
              <p v-if="provider.issuer" class="hint">Issuer：{{ provider.issuer }}</p><p v-if="provider.base_url" class="hint">提供方地址：{{ provider.base_url }}</p>
              <p v-if="provider.auth_url" class="hint">授权地址：{{ provider.auth_url }}</p><p v-if="provider.token_url" class="hint">换码地址：{{ provider.token_url }}</p><p v-if="provider.userinfo_url" class="hint">资料地址：{{ provider.userinfo_url }} · subject：{{ provider.subject_field }}</p>
              <p class="hint">提供方 ID、Client ID 和身份域不可修改。更换应用/issuer 请使用新 ID，避免旧绑定被其他身份冒用。</p>
            </div></details>
            <div class="action-row"><button class="btn small" :disabled="busy" @click="toggle(provider)">{{ provider.enabled ? "停用" : "启用" }}</button><button v-if="provider.source === 'runtime'" class="btn small" :disabled="busy" @click="begin(provider)">名称 / 密钥轮换</button><button v-if="provider.source === 'runtime'" class="btn small danger" :disabled="busy" @click="archive(provider)">归档</button></div>
          </article>
          <details v-if="archivedProviders.length"><summary>已归档的提供方（{{ archivedProviders.length }}）</summary><p v-for="provider in archivedProviders" :key="provider.id" class="hint archived-row">{{ provider.display_name || provider.id }} · {{ provider.id }} · 密钥已清除，绑定记录保留，ID 不可复用</p></details>
          <p class="hint">第三方登录不会按相同邮箱合并账户，也不会自动信任组网设备。现有成员请在安全中心显式绑定；未绑定的第三方身份须通过邀请或网络开放加入策略准入。</p>
        </div>
      </section>
      <p class="hint">配置版本 {{ data.revision }} · 实时持久保存。修改会取消尚未完成的第三方授权，需重新发起；已有控制台会话不受影响。</p>
    </template>
    <ModalDialog :title="editing ? '修改名称与轮换密钥' : '添加第三方登录'" :open="dialogOpen" :busy="busy" @close="close">
      <form id="authentication-provider-form" class="stack" @submit.prevent="saveProvider">
        <div v-if="formError" class="alert error" role="alert">{{ formError }}</div>
        <template v-if="!editing">
          <div class="field"><label for="provider-type">登录协议 / 提供方</label><select id="provider-type" v-model="providerType" class="input" :disabled="busy"><option value="github">GitHub OAuth2</option><option value="gitlab">GitLab OAuth2</option><option value="gitea">Gitea OAuth2</option><option value="oidc">通用 OIDC（企业 / Dex 等）</option><option value="generic">通用 OAuth2（支持 PKCE S256）</option></select></div>
          <div class="field"><label for="provider-id">提供方 ID（保存后不可变）</label><input id="provider-id" v-model="providerID" class="input" maxlength="64" :disabled="busy" required placeholder="例如 github-main、company-oidc" autocomplete="off" /></div>
        </template>
        <div class="field"><label for="provider-name">登录按钮名称</label><input id="provider-name" v-model="displayName" class="input" maxlength="100" :disabled="busy" required placeholder="例如 GitHub 账号、公司统一登录" /></div>
        <template v-if="!editing">
          <div v-if="providerType === 'oidc'" class="field"><label for="provider-issuer">OIDC Issuer</label><input id="provider-issuer" v-model="issuer" class="input" type="url" :disabled="busy" required placeholder="https://id.example.com/realms/company" /></div>
          <div v-if="providerType === 'gitlab' || providerType === 'gitea'" class="field"><label for="provider-base-url">提供方地址</label><input id="provider-base-url" v-model="baseURL" class="input" type="url" :disabled="busy" :required="providerType === 'gitea'" placeholder="GitLab 留空使用 gitlab.com；自建服务填写公网 HTTPS 地址" /></div>
          <template v-if="providerType === 'generic'">
            <div class="field"><label for="provider-auth-url">Authorization Endpoint</label><input id="provider-auth-url" v-model="authURL" class="input" type="url" :disabled="busy" required placeholder="https://id.example.com/oauth/authorize" /></div>
            <div class="field"><label for="provider-token-url">Token Endpoint</label><input id="provider-token-url" v-model="tokenURL" class="input" type="url" :disabled="busy" required placeholder="https://id.example.com/oauth/token" /></div>
            <div class="field"><label for="provider-userinfo-url">当前用户资料 Endpoint</label><input id="provider-userinfo-url" v-model="userInfoURL" class="input" type="url" :disabled="busy" required placeholder="https://id.example.com/api/user" /></div>
            <div class="field"><label for="provider-subject">唯一身份字段（稳定的 subject / 用户 ID）</label><input id="provider-subject" v-model="subjectField" class="input" :disabled="busy" required /></div>
            <details><summary>资料字段与客户端认证</summary><div class="stack provider-details">
              <div class="field"><label for="provider-profile-name">显示名称字段</label><input id="provider-profile-name" v-model="nameField" class="input" :disabled="busy" /></div>
              <div class="field"><label for="provider-profile-username">用户名字段（可选）</label><input id="provider-profile-username" v-model="usernameField" class="input" :disabled="busy" /></div>
              <div class="field"><label for="provider-profile-email">邮箱字段（仅属性）</label><input id="provider-profile-email" v-model="emailField" class="input" :disabled="busy" /></div>
              <div class="field"><label for="provider-auth-style">Token Endpoint 客户端认证</label><select id="provider-auth-style" v-model="authStyle" class="input" :disabled="busy"><option value="client_secret_post">POST 正文</option><option value="client_secret_basic">Authorization Basic</option></select></div>
            </div></details>
          </template>
          <div class="field"><label for="provider-client-id">Client ID / 应用 ID（保存后不可变）</label><input id="provider-client-id" v-model="clientID" class="input" maxlength="512" :disabled="busy" required autocomplete="off" /></div>
        </template>
        <div class="field"><label for="provider-client-secret">{{ editing ? "新 Client Secret（留空不更换）" : "Client Secret（OIDC 公共客户端可留空）" }}</label><input id="provider-client-secret" v-model="clientSecret" class="input" type="password" maxlength="4096" :disabled="busy" :required="!editing && providerType !== 'oidc'" autocomplete="off" /><p class="hint">只提交到服务端加密保存，提交后清空，列表不会回显。不要把密钥填入 endpoint 或备注。</p></div>
        <template v-if="!editing">
          <div class="field"><label for="provider-scopes">Scopes（空格或逗号分隔，可留空使用协议默认值）</label><input id="provider-scopes" v-model="scopes" class="input" :disabled="busy" placeholder="OIDC 默认 openid profile email" /></div>
          <label class="checkbox"><input v-model="enabled" type="checkbox" :disabled="busy" />保存后立即启用（建议先核对提供方应用与回调）</label>
        </template>
        <div class="field"><label for="provider-callback">固定 Redirect URI / 回调地址</label><textarea id="provider-callback" :value="callback" class="input mono" rows="2" readonly /><p class="hint">在提供方应用管理页精确登记此地址，不能使用通配符。需要真实应用凭据；自签测试站点可能被提供方拒绝。运行时只支持公网 HTTPS，不能关闭 TLS、PKCE 或内网保护。</p></div>
      </form>
      <template #footer><button class="btn" :disabled="busy" @click="close">取消</button><button class="btn primary" form="authentication-provider-form" type="submit" :disabled="busy">{{ busy ? "保存中…" : "保存登录提供方" }}</button></template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.authentication-editor { min-width: 0; }
.authentication-editor .card-head { flex-wrap: wrap; gap: 12px; }
.provider-row { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; display: grid; gap: 10px; min-width: 0; }
.provider-title, .action-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.provider-title strong { overflow-wrap: anywhere; }
.provider-row p, .provider-details p, .authentication-editor .hint { overflow-wrap: anywhere; }
.provider-details { margin-top: 12px; display: grid; gap: 10px; }
details summary { cursor: pointer; color: var(--text-muted); }
.archived-row { padding-top: 10px; }
.field { min-width: 0; }
.input { width: 100%; min-width: 0; }
@media (max-width: 560px) { .provider-row { padding: 12px; } .action-row { align-items: flex-start; } .action-row .hint { flex-basis: 100%; } }
</style>
