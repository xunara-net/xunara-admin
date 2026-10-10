import { describe, expect, it } from "vitest";
import type { RelayExecution } from "../api/types";
import { relayExecutionContract, relayExecutionSummary } from "./relay-execution";

const received = "2026-10-10T00:00:00Z";
const now = Date.parse(received) + 1000;
const execution: RelayExecution = { config_version: "7", applied_version: "7", status: "applied", state: "online", bandwidth_limit: 0 };
const relay = { configVersion: 7, desiredState: "online", lastSeen: received, executionReportedAt: received, execution };

describe("reported relay execution", () => {
  it("never equates saved desired configuration with execution", () => {
    expect(relayExecutionSummary({ configVersion: 7 }, now).label).toBe("执行状态未知");
    expect(relayExecutionSummary(relay, now).label).toBe("中继上报已应用 v7");
    expect(relayExecutionSummary(relay, now).detail).toContain("不替代端到端验证");
    expect(relayExecutionSummary({ ...relay, configVersion: 8 }, now).label).toContain("待应用 v8");
    expect(relayExecutionSummary({ ...relay, configVersion: 8, desiredState: "revoked" }, now).label).toContain("无停机回执");
  });

  it("marks expired and future-dated reports as non-live", () => {
    expect(relayExecutionSummary(relay, now + 180_000).label).toBe("旧回执 · 非实时");
    expect(relayExecutionSummary(relay, now - 32_000).label).toBe("旧回执 · 非实时");
  });

  it("reports local effective bandwidth and fixed failures without arbitrary error text", () => {
    const failed: RelayExecution = { config_version: "7", applied_version: "6", status: "failed", state: "disabled", bandwidth_limit: 2048, error_code: "cache_write_failed" };
    const summary = relayExecutionSummary({ ...relay, execution: failed }, now);
    expect(summary.label).toBe("中继上报执行失败");
    expect(summary.detail).toContain("缓存写入失败");
    expect(summary.detail).toContain("2,048");
    expect(summary.detail).toContain("上次成功：v6");
  });

  it("rejects incomplete, future, contradictory and arbitrary-error reports", () => {
    for (const report of [
      { ...execution, config_version: "8", applied_version: "8" },
      { ...execution, config_version: "07" }, { ...execution, applied_version: "6" },
      { ...execution, state: "pending" }, { ...execution, state: "disabled" },
      { ...execution, bandwidth_limit: -1 }, { ...execution, bandwidth_limit: undefined },
      { ...execution, error_code: "secret" }, { ...execution, status: "failed", error_code: "secret" },
      { ...execution, status: "received" },
    ]) {
      const malformed = { ...relay, execution: report as RelayExecution };
      expect(relayExecutionContract(malformed)).toBe(false);
      expect(relayExecutionSummary(malformed, now).label).toBe("执行报告异常");
    }
    expect(relayExecutionContract({ ...relay, executionReportedAt: undefined })).toBe(false);
    expect(relayExecutionContract({ ...relay, executionReportedAt: "invalid" })).toBe(false);
    expect(relayExecutionContract({ ...relay, lastSeen: undefined })).toBe(false);
    expect(relayExecutionContract({ ...relay, executionReportedAt: "2026-10-11T00:00:00Z" })).toBe(false);
    expect(relayExecutionContract({ executionReportedAt: received })).toBe(false);
  });
});
