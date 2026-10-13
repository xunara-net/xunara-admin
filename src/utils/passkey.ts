import type { CreationOptions, RequestOptions } from "../api/platform-auth";
import { errorMessage } from "../api/client";

export function availability(): string {
  if (!window.isSecureContext) return "通行密钥需要可信 HTTPS 连接，请从正式域名访问。";
  if (typeof PublicKeyCredential === "undefined" || !navigator.credentials?.create || !navigator.credentials?.get) return "浏览器不支持通行密钥，请换用新版浏览器或令牌登录。";
  return "";
}
export function decode(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), character => character.charCodeAt(0)).buffer;
}
export function encode(value: ArrayBuffer): string {
  let binary = "";
  for (const byteValue of new Uint8Array(value)) binary += String.fromCharCode(byteValue);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function common(credential: Credential | null) {
  if (!credential || credential.type !== "public-key") throw new Error("没有取得通行密钥响应");
  const key = credential as PublicKeyCredential;
  return { key, fields: { id: key.id, rawId: encode(key.rawId), type: key.type, authenticatorAttachment: key.authenticatorAttachment, clientExtensionResults: key.getClientExtensionResults() } };
}
export async function register(options: CreationOptions, signal: AbortSignal) {
  const { key, fields } = common(await navigator.credentials.create({ publicKey: {
    ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map(item => ({ ...item, id: decode(item.id) })),
  }, signal }));
  const response = key.response as AuthenticatorAttestationResponse;
  return { ...fields, response: { clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject), transports: response.getTransports?.() ?? [] } };
}
export async function authenticate(options: RequestOptions, signal: AbortSignal) {
  const { key, fields } = common(await navigator.credentials.get({ publicKey: {
    ...options, challenge: decode(options.challenge), allowCredentials: options.allowCredentials?.map(item => ({ ...item, id: decode(item.id) })),
  }, signal }));
  const response = key.response as AuthenticatorAssertionResponse;
  return { ...fields, response: { clientDataJSON: encode(response.clientDataJSON), authenticatorData: encode(response.authenticatorData), signature: encode(response.signature), userHandle: response.userHandle === null ? null : encode(response.userHandle) } };
}
export function failureMessage(error: unknown): string {
  if (error instanceof Error && ["NotAllowedError", "AbortError"].includes(error.name)) return "验证已取消或超时，请重新开始；不会自动重试。";
  if (error instanceof Error && error.name === "InvalidStateError") return "此认证器已保存这把密钥，请选择其他认证器或设备。";
  return errorMessage(error);
}
