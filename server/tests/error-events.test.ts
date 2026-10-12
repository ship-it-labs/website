import { describe, it, expect } from "vitest";
import {
  toErrorEventRow,
  shouldLogStatus,
  errorCodeFromPayload,
} from "../src/services/error-log.js";
import { clientErrorSchema } from "../src/routes/client-errors.js";

/**
 * The failure log must never become a failure itself: rows are length-capped
 * so one chatty client cannot bloat the table, and only 5xx responses are
 * recorded (4xx are user mistakes, not platform failures).
 */
describe("error event rows", () => {
  it("builds a complete row with an id", () => {
    const row = toErrorEventRow({
      source: "api",
      method: "POST",
      path: "/api/v1/billing/checkout",
      statusCode: 502,
      errorCode: "CHECKOUT_FAILED",
      message: "Could not start checkout",
      userId: "u1",
      requestId: "req_abc",
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row).toMatchObject({
      source: "api",
      method: "POST",
      status_code: 502,
      error_code: "CHECKOUT_FAILED",
      user_id: "u1",
      request_id: "req_abc",
    });
  });

  it("caps every field so one reporter cannot bloat the table", () => {
    const row = toErrorEventRow({
      source: "client",
      method: "unhandledrejectiontoolong",
      path: `/${"p".repeat(600)}`,
      errorCode: `C${"o".repeat(200)}`,
      message: "m".repeat(5000),
      requestId: `r${"e".repeat(100)}`,
    });
    expect(row.message).toHaveLength(1000);
    expect(row.path).toHaveLength(500);
    expect(row.error_code).toHaveLength(100);
    expect(row.method).toHaveLength(16);
    expect(row.request_id).toHaveLength(64);
  });

  it("normalizes blanks and non-numbers instead of storing garbage", () => {
    const row = toErrorEventRow({ source: "process", message: "   " });
    expect(row.message).toBe("Unknown error");
    expect(row.method).toBeNull();
    expect(row.path).toBeNull();
    expect(row.status_code).toBeNull();
    expect(row.error_code).toBeNull();
    expect(row.user_id).toBeNull();
    expect(row.request_id).toBeNull();
    expect(toErrorEventRow({ source: "api", message: "x", statusCode: NaN }).status_code).toBeNull();
  });
});

describe("failure status gate", () => {
  it("logs 5xx and nothing else", () => {
    expect(shouldLogStatus(500)).toBe(true);
    expect(shouldLogStatus(502)).toBe(true);
    expect(shouldLogStatus(599)).toBe(true);
    expect(shouldLogStatus(400)).toBe(false);
    expect(shouldLogStatus(404)).toBe(false);
    expect(shouldLogStatus(429)).toBe(false);
    expect(shouldLogStatus(200)).toBe(false);
    expect(shouldLogStatus(600)).toBe(false);
  });
});

describe("error payload extraction", () => {
  it("reads code and message from the standard envelope", () => {
    expect(
      errorCodeFromPayload(JSON.stringify({ error: { code: "CHECKOUT_FAILED", message: "nope" } }))
    ).toEqual({ code: "CHECKOUT_FAILED", message: "nope" });
  });

  it("reads Buffers the same as strings", () => {
    expect(
      errorCodeFromPayload(Buffer.from(JSON.stringify({ error: { code: "X", message: "y" } })))
    ).toEqual({ code: "X", message: "y" });
  });

  it("returns nulls for anything uninspectable", () => {
    expect(errorCodeFromPayload(null)).toEqual({ code: null, message: null });
    expect(errorCodeFromPayload("not json")).toEqual({ code: null, message: null });
    expect(errorCodeFromPayload(JSON.stringify({ ok: true }))).toEqual({ code: null, message: null });
    expect(errorCodeFromPayload("x".repeat(5000))).toEqual({ code: null, message: null });
  });
});

describe("client error report validation", () => {
  it("accepts a full report", () => {
    const parsed = clientErrorSchema.safeParse({
      message: "Failed to load",
      path: "/billing",
      kind: "api",
      status: 502,
      code: "CHECKOUT_FAILED",
      stack: "Error: x\n at y",
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults the kind and tolerates missing optionals", () => {
    const parsed = clientErrorSchema.safeParse({ message: "boom", path: "/" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.kind).toBe("window");
  });

  it("rejects empties, overlong fields, non-failure statuses and bad kinds", () => {
    expect(clientErrorSchema.safeParse({ message: "", path: "/" }).success).toBe(false);
    expect(clientErrorSchema.safeParse({ message: "x", path: "" }).success).toBe(false);
    expect(clientErrorSchema.safeParse({ message: "x", path: "/", status: 200 }).success).toBe(false);
    expect(clientErrorSchema.safeParse({ message: "x", path: "/", kind: "nope" }).success).toBe(false);
    expect(clientErrorSchema.safeParse({ message: "x".repeat(1001), path: "/" }).success).toBe(false);
    expect(clientErrorSchema.safeParse({}).success).toBe(false);
  });
});
