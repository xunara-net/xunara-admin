import { describe, expect, it } from "vitest";
import { ApiError, errorMessage } from "./client";

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
