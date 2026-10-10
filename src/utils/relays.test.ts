import { describe, expect, it } from "vitest";
import type { PlatformRelay } from "../api/types";
import { bandwidthText, bytesText, filterRelays, parseBandwidth, relayStatus, relayDesiredStateText } from "./relays";

const relay: PlatformRelay = {
  id: "relay-1", name: "上海 01", organizationId: "acme", organizationName: "测试租户",
  hostname: "sh.example.com", regionCode: "sh", visibility: "private",
  desiredState: "online", configVersion: 1, bandwidthLimit: 0, online: true, healthy: true,
};

describe("relay presentation", () => {
  it("does not describe a historical desired state as a live heartbeat", () => {
    expect(relayDesiredStateText("online")).toBe("启用");
    expect(relayDesiredStateText("revoked")).toContain("不可恢复身份");
    expect(relayDesiredStateText("unknown")).toBe("未知期望状态");
  });
  it("distinguishes heartbeat liveness, data-plane health and requested state", () => {
    expect(relayStatus(relay)).toBe("online");
    expect(relayStatus({ ...relay, healthy: false })).toBe("degraded");
    expect(relayStatus({ ...relay, online: false })).toBe("offline");
    for (const desiredState of ["maintenance", "disabled", "revoked"] as const) {
      expect(relayStatus({ ...relay, desiredState })).toBe(desiredState);
    }
    expect(relayStatus({ ...relay, desiredState: "future-state" as PlatformRelay["desiredState"] })).toBe("unknown");
  });

  it("filters by the exact tenant even when relay IDs or names collide", () => {
    const other = { ...relay, organizationId: "other", healthy: false };
    expect(filterRelays([relay, other], "acme", "", "SH.EXAMPLE")).toEqual([relay]);
    expect(filterRelays([relay, other], "", "degraded", "")).toEqual([other]);
    expect(filterRelays([relay], "", "", "广州")).toEqual([]);
  });

  it("keeps absent counters unknown rather than inventing zero traffic", () => {
    expect(bytesText(undefined)).toBe("—");
    expect(bytesText(0)).toBe("0 B");
    expect(bytesText(2048)).toBe("2.0 KiB");
  });

  it("uses the protocol byte-rate semantics for local configuration and unlimited", () => {
    expect(bandwidthText(0)).toBe("使用中继本地配置");
    expect(bandwidthText(-1)).toBe("不限速");
    expect(bandwidthText(1024)).toContain("字节/秒/连接");
    expect(parseBandwidth("-1")).toBe(-1);
    expect(parseBandwidth("0")).toBe(0);
    expect(parseBandwidth(" 1024 ")).toBe(1024);
    expect(parseBandwidth(1024)).toBe(1024);
    expect(parseBandwidth(-1)).toBe(-1);
    expect(() => parseBandwidth(1.5)).toThrow();
    for (const value of ["", "1.5", "-2", "1e3", "Infinity", "9007199254740992"]) {
      expect(() => parseBandwidth(value)).toThrow();
    }
  });
});
