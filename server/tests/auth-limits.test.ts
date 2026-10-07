import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, clearRateLimits } from "../src/services/rate-limit.js";
import { isCommonPassword } from "../src/utils/passwords.js";

describe("rate limiting", () => {
  beforeEach(() => {
    clearRateLimits();
  });

  it("allows attempts under the limit", () => {
    expect(checkRateLimit("ip:1", 3, 60_000, 1000).allowed).toBe(true);
    expect(checkRateLimit("ip:1", 3, 60_000, 2000).allowed).toBe(true);
    expect(checkRateLimit("ip:1", 3, 60_000, 3000).allowed).toBe(true);
  });

  it("refuses past the limit with a retry hint", () => {
    checkRateLimit("ip:2", 2, 60_000, 1000);
    checkRateLimit("ip:2", 2, 60_000, 2000);
    const result = checkRateLimit("ip:2", 2, 60_000, 3000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("lets the window age out", () => {
    checkRateLimit("ip:3", 1, 60_000, 1000);
    expect(checkRateLimit("ip:3", 1, 60_000, 2000).allowed).toBe(false);
    expect(checkRateLimit("ip:3", 1, 60_000, 62_000).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    checkRateLimit("ip:4", 1, 60_000, 1000);
    expect(checkRateLimit("ip:5", 1, 60_000, 1000).allowed).toBe(true);
  });
});

describe("common passwords", () => {
  // Length checks pass "password123" without this list — eleven characters,
  // cracked in seconds.
  it("rejects the classics regardless of case", () => {
    expect(isCommonPassword("password123")).toBe(true);
    expect(isCommonPassword("Password123")).toBe(true);
    expect(isCommonPassword("QWERTY")).toBe(true);
    expect(isCommonPassword("hunter2")).toBe(true);
  });

  it("accepts real passwords, including long test fixtures", () => {
    expect(isCommonPassword("hunter2hunter2")).toBe(false);
    expect(isCommonPassword("correct horse battery staple")).toBe(false);
    expect(isCommonPassword("xJ9#qW2!vLm4")).toBe(false);
  });
});
