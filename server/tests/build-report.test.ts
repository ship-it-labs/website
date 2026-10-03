import { describe, it, expect } from "vitest";
import {
  secretMatches,
  capLogs,
} from "../src/routes/build-reports.js";
import { expiryToTimestamp } from "../src/routes/api-keys.js";

/**
 * The report endpoint is the only way a GitHub Actions build ever leaves
 * "running" and the only place its output lands. The guards around it are load
 * bearing: a wrong secret must fail closed, and an oversized log must shrink to
 * fit rather than taking the status update down with it.
 */

describe("report token comparison", () => {
  it("accepts the configured secret", () => {
    expect(secretMatches("correct-horse", "correct-horse")).toBe(true);
  });

  it("rejects a wrong secret without throwing", () => {
    expect(secretMatches("wrong", "correct-horse")).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(secretMatches("anything", "")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});

describe("report log capping", () => {
  const line = (content: string) => ({ stream: "stdout" as const, content });

  it("keeps a small log untouched", () => {
    const logs = [line("a"), line("b")];
    expect(capLogs(logs)).toEqual(logs);
  });

  it("truncates by bytes and says so", () => {
    const logs = [line("x".repeat(300 * 1024))];
    const capped = capLogs(logs);

    expect(capped).toHaveLength(1);
    expect(capped[0].stream).toBe("system");
    expect(capped[0].content).toContain("truncated");
  });

  it("keeps the head of the log when it overflows", () => {
    const logs = Array.from({ length: 50 }, (_, i) =>
      line(`line ${i} ` + "x".repeat(10 * 1024))
    );
    const capped = capLogs(logs);

    expect(capped[0].content).toContain("line 0");
    expect(capped[capped.length - 1].stream).toBe("system");
  });
});

describe("key expiry timestamps", () => {
  it("returns null when no expiry was asked for", () => {
    expect(expiryToTimestamp(undefined)).toBeNull();
  });

  it("turns days into a future timestamp", () => {
    const before = Date.now();
    const at = expiryToTimestamp({ expires_in_days: 30 });

    expect(at).not.toBeNull();
    const parsed = new Date(at!).getTime();
    expect(parsed).toBeGreaterThan(before + 29 * 24 * 60 * 60 * 1000);
    expect(parsed).toBeLessThanOrEqual(before + 31 * 24 * 60 * 60 * 1000);
  });

  it("accepts a future date", () => {
    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(expiryToTimestamp({ expires_at: future })).toBe(future);
  });

  it("refuses a past date", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(expiryToTimestamp({ expires_at: past })).toBeNull();
  });
});
