import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, errorMessage, platformApi } from "./client";
import { admin } from "../store";

describe("platform API errors", () => {
  it("keeps the status and message", () => {
    const err = new ApiError(409, "a tailnet needs at least one owner");
    expect(err.status).toBe(409);
    expect(errorMessage(err)).toBe("a tailnet needs at least one owner");
  });

  it("passes through other values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("platform credential lifecycle", () => {
  beforeEach(() => {
    const entries = new Map<string, string>();
    vi.stubGlobal("window", {
      location: { origin: "https://admin.xunara.test" },
      sessionStorage: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => entries.set(key, value),
        removeItem: (key: string) => entries.delete(key),
      },
    });
    admin.signIn("test-platform-credential");
  });

  afterEach(() => {
    admin.signOut();
    vi.unstubAllGlobals();
  });

  it("sends version preconditions in headers without replacing the platform credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await platformApi("/api/platform/v1/organizations/acme/relays/relay-1", { method: "DELETE", headers: { "If-Match": "3", Authorization: "untrusted" } });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "If-Match": "3", Authorization: "Bearer test-platform-credential" });
  });

  it("retains the operator credential on a version conflict and rejects non-JSON success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "RELAY_CONFIG_CHANGED: stale" }), { status: 409 })));
    await expect(platformApi("/api/platform/v1/relays")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("草稿保留") });
    expect(admin.authenticated).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(platformApi("/api/platform/v1/relays")).rejects.toMatchObject({ status: 502 });
  });

  it("keeps the operator signed in after a quota denial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("RELAY_LIMIT_REACHED", { status: 403 })));
    await expect(platformApi("/api/platform/v1/relays")).rejects.toMatchObject({ status: 403, message: "RELAY_LIMIT_REACHED" });
    expect(admin.authenticated).toBe(true);
    expect(window.sessionStorage.getItem("xunara.admin.token")).toBe("test-platform-credential");
  });

  it("clears an invalid credential only on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    await expect(platformApi("/api/platform/v1/relays")).rejects.toMatchObject({ status: 401 });
    expect(admin.authenticated).toBe(false);
    expect(window.sessionStorage.getItem("xunara.admin.token")).toBeNull();
  });

  it("explains the server's actual plaintext relay quota denial in Chinese", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("the current plan does not allow another relay\n", { status: 403 })));
    await expect(platformApi("/api/platform/v1/relays")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("托管中继额度已用完") });
    expect(admin.authenticated).toBe(true);
  });

  it("does not clear credentials on network or storage outages", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }));
    vi.stubGlobal("fetch", request);
    await expect(platformApi("/api/platform/v1/relays")).rejects.toThrow("network unavailable");
    await expect(platformApi("/api/platform/v1/relays")).rejects.toMatchObject({ status: 503 });
    expect(admin.authenticated).toBe(true);
  });

  it("sends the platform credential in a header, never the URL", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ relays: [] }), { status: 200 }));
    vi.stubGlobal("fetch", request);
    await platformApi("/api/platform/v1/relays");
    const [url, options] = request.mock.calls[0]!;
    expect(String(url)).toBe("https://admin.xunara.test/api/platform/v1/relays");
    expect(options.headers.Authorization).toBe("Bearer test-platform-credential");
  });
});
