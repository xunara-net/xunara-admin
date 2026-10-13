import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, availability, decode, encode, failureMessage, register } from "./passkey";

afterEach(() => vi.unstubAllGlobals());
describe("administrator WebAuthn bridge", () => {
  it("roundtrips URL-safe bytes and rejects insecure contexts", () => {
    const bytes = new Uint8Array([0, 127, 255]).buffer;
    expect(new Uint8Array(decode(encode(bytes)))).toEqual(new Uint8Array(bytes));
    vi.stubGlobal("window", { isSecureContext: false });
    expect(availability()).toContain("HTTPS");
  });
  it("decodes immutable options and encodes an attestation", async () => {
    const options = { challenge: "AQI", user: { id: "AwQ", name: "admin", displayName: "平台管理员" }, rp: { name: "平台", id: "admin.test" }, pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], excludeCredentials: [{ type: "public-key" as const, id: "BQY" }] };
    const create = vi.fn().mockResolvedValue({ type: "public-key", id: "test", rawId: decode("AQI"), getClientExtensionResults: () => ({}), response: { clientDataJSON: decode("AwQ"), attestationObject: decode("BQY"), getTransports: () => ["internal"] } });
    vi.stubGlobal("navigator", { credentials: { create } });
    const result = await register(options, new AbortController().signal);
    expect(create.mock.calls[0]![0].publicKey.challenge).toBeInstanceOf(ArrayBuffer);
    expect(options.challenge).toBe("AQI");
    expect(result.response.attestationObject).toBe("BQY");
  });
  it("encodes assertions and preserves a null user handle", async () => {
    const get = vi.fn().mockResolvedValue({ type: "public-key", id: "test", rawId: decode("AQI"), getClientExtensionResults: () => ({}), response: { clientDataJSON: decode("AwQ"), authenticatorData: decode("BQY"), signature: decode("Bwg"), userHandle: null } });
    vi.stubGlobal("navigator", { credentials: { get } });
    const result = await authenticate({ challenge: "AQI" }, new AbortController().signal);
    expect(result.response.userHandle).toBeNull();
    expect(result.response.signature).toBe("Bwg");
  });
  it("does not treat cancellation as a successful binding", () => {
    const failure = new Error("cancelled"); failure.name = "NotAllowedError";
    expect(failureMessage(failure)).toContain("取消");
  });
});
