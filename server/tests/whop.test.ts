import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { planIdFromMembership, isDuplicateKeyError, whopPlanIdOf } from "../src/services/whop-service.js";

/**
 * Whop uses the Standard Webhooks spec. These tests exercise the real signature
 * scheme, plus the replay window and the sandbox/live split, without needing
 * Whop credentials.
 */

const SECRET = "whop-sandbox-test-secret";

function sign(body: string, id: string, timestamp: string): string {
  const digest = crypto
    .createHmac("sha256", Buffer.from(SECRET, "utf8"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${digest}`;
}

/** Re-imports the module so env changes are observed, since the environment is
 *  resolved at module load. */
async function freshService() {
  vi.resetModules();
  return import("../src/services/whop-service.js");
}

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("standard webhooks signature", () => {
  beforeEach(() => {
    process.env.WHOP_WEBHOOK_SECRET = SECRET;
    process.env.NODE_ENV = "development";
  });

  it("accepts a correctly signed payload", async () => {
    const { verifyWebhookSignature } = await freshService();

    const body = JSON.stringify({ type: "membership.activated", data: {} });
    const id = "msg_123";
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp, signature: sign(body, id, timestamp) })
    ).toBe(true);
  });

  it("rejects a payload whose body was modified", async () => {
    const { verifyWebhookSignature } = await freshService();

    const original = JSON.stringify({ type: "membership.activated" });
    const tampered = JSON.stringify({ type: "membership.deactivated" });
    const id = "msg_123";
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(
      verifyWebhookSignature({
        body: tampered,
        webhookId: id,
        timestamp,
        signature: sign(original, id, timestamp),
      })
    ).toBe(false);
  });

  it("rejects a signature computed over a different id", async () => {
    const { verifyWebhookSignature } = await freshService();

    const body = JSON.stringify({ type: "payment.succeeded" });
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(
      verifyWebhookSignature({
        body,
        webhookId: "msg_real",
        timestamp,
        signature: sign(body, "msg_other", timestamp),
      })
    ).toBe(false);
  });

  it("rejects anything outside the five minute replay window", async () => {
    const { verifyWebhookSignature } = await freshService();

    const body = JSON.stringify({ type: "payment.succeeded" });
    const id = "msg_123";
    const stale = String(Math.floor(Date.now() / 1000) - 600);

    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp: stale, signature: sign(body, id, stale) })
    ).toBe(false);
  });

  it("accepts a signature list containing the valid entry", async () => {
    const { verifyWebhookSignature } = await freshService();

    const body = JSON.stringify({ type: "membership.activated" });
    const id = "msg_123";
    const timestamp = String(Math.floor(Date.now() / 1000));

    // Standard Webhooks sends one or more space separated `v1,<base64>` entries.
    const signature = `v1,ZmFrZXNpZ25hdHVyZWJ1dG5vdHZhbGlk ${sign(body, id, timestamp)}`;

    expect(verifyWebhookSignature({ body, webhookId: id, timestamp, signature })).toBe(true);
  });

  it("rejects a signature list with no valid entry", async () => {
    const { verifyWebhookSignature } = await freshService();

    const body = JSON.stringify({ type: "membership.activated" });
    const id = "msg_123";
    const timestamp = String(Math.floor(Date.now() / 1000));

    const signature = `v1,ZmFrZXNpZ25hdHVyZWJ1dG5vdHZhbGlk v1,b3RoZXJmYWtl`;

    expect(verifyWebhookSignature({ body, webhookId: id, timestamp, signature })).toBe(false);
  });

  it("rejects every request when the secret is not configured", async () => {
    process.env.WHOP_WEBHOOK_SECRET = "";
    const { verifyWebhookSignature } = await freshService();

    const body = "{}";
    const id = "msg_123";
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp, signature: sign(body, id, timestamp) })
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    const { verifyWebhookSignature } = await freshService();

    const body = "{}";
    expect(
      verifyWebhookSignature({
        body,
        webhookId: "msg_123",
        timestamp: "not-a-number",
        signature: sign(body, "msg_123", "not-a-number"),
      })
    ).toBe(false);
  });
});

function beforeEachConfig() {
  process.env.WHOP_WEBHOOK_SECRET = SECRET;
  process.env.NODE_ENV = "development";
}

describe("whop configuration guard", () => {
  it("fails loudly in development when the sandbox key is missing", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.WHOP_SANDBOX_API_KEY;
    delete process.env.WHOP_LIVE_API_KEY;

    const { validateWhopConfig } = await freshService();
    expect(() => validateWhopConfig()).toThrow(/WHOP_SANDBOX_API_KEY/);
  });

  it("does not fall back to the live key in development", async () => {
    process.env.NODE_ENV = "development";
    process.env.WHOP_LIVE_API_KEY = "live_key_that_must_not_be_used_in_dev";
    delete process.env.WHOP_SANDBOX_API_KEY;

    const { validateWhopConfig } = await freshService();
    expect(() => validateWhopConfig()).toThrow(/sandbox/i);
  });

  it("does not fall back to the sandbox key in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.WHOP_SANDBOX_API_KEY = "sandbox_key_must_not_be_used_in_prod";
    delete process.env.WHOP_LIVE_API_KEY;

    const { validateWhopConfig } = await freshService();
    expect(() => validateWhopConfig()).toThrow(/WHOP_LIVE_API_KEY/);
  });

  it("names the sandbox environment in development", async () => {
    process.env.NODE_ENV = "development";
    process.env.WHOP_SANDBOX_API_KEY = "sandbox_key";

    const { whopEnvironmentName } = await freshService();
    expect(whopEnvironmentName()).toBe("sandbox");
  });

  it("names the production environment in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.WHOP_LIVE_API_KEY = "live_key_1234567890";

    const { whopEnvironmentName } = await freshService();
    expect(whopEnvironmentName()).toBe("production");
  });

  it("rejects a truncated live key rather than trying it", async () => {
    process.env.NODE_ENV = "production";
    process.env.WHOP_LIVE_API_KEY = "abc";

    const { validateWhopConfig } = await freshService();
    expect(() => validateWhopConfig()).toThrow(/truncated/);
  });

  it("accepts a configured environment", async () => {
    process.env.NODE_ENV = "development";
    process.env.WHOP_SANDBOX_API_KEY = "sandbox_key";

    const { validateWhopConfig } = await freshService();
    expect(() => validateWhopConfig()).not.toThrow();
  });
});

describe("whop environment hosts", () => {
  it("uses a different host for sandbox and production", async () => {
    const { WhopEnvironment } = await import("@whop/sdk");
    expect(WhopEnvironment.Sandbox.api).not.toBe(WhopEnvironment.Production.api);
    expect(WhopEnvironment.Sandbox.api).toContain("sandbox");
  });
});

describe("membership plan mapping", () => {
  // Plus no longer exists as a row: writing it would 401 every request for
  // the account, so stale metadata normalizes to its surviving equivalent.
  it("maps retired plus metadata to ultra", () => {
    expect(planIdFromMembership({ plan_id: "plus" }, null)).toBe("ultra");
  });

  it("passes live plan ids through untouched", () => {
    expect(planIdFromMembership({ plan_id: "pro" }, null)).toBe("pro");
    expect(planIdFromMembership({ plan_id: "ultra" }, "free")).toBe("ultra");
  });

  it("falls back when metadata carries no plan", () => {
    expect(planIdFromMembership({}, "free")).toBe("free");
    expect(planIdFromMembership({}, null)).toBeNull();
    expect(planIdFromMembership({ plan_id: 42 }, "free")).toBe("free");
  });
});

describe("membership plan resolution", () => {
  // Webhook payloads disagree about where the plan lives, and passing
  // undefined through crashed the subscription write on SQLite while silently
  // skipping it before the atomicity guard. Null everywhere instead.
  const base = {
    id: "mem_1",
    status: "active",
    user_id: "u1",
    metadata: {},
    cancel_at_period_end: false,
    current_period_end: null,
  };

  it("reads the top-level plan id", () => {
    expect(whopPlanIdOf({ ...base, plan_id: "plan_abc" })).toBe("plan_abc");
  });

  it("reads the nested plan object", () => {
    expect(whopPlanIdOf({ ...base, plan: { id: "plan_xyz" } })).toBe("plan_xyz");
  });

  it("returns null when the payload names no plan", () => {
    expect(whopPlanIdOf({ ...base })).toBeNull();
    expect(whopPlanIdOf({ ...base, plan_id: null, plan: null })).toBeNull();
  });
});

describe("duplicate delivery detection", () => {
  // Whop retries deliveries, and the retry must be recognized on both
  // drivers: Postgres reports code 23505, SQLite reports a bare message.
  // Missing the SQLite shape once caused an infinite retry storm.
  it("recognizes Postgres unique violations", () => {
    expect(isDuplicateKeyError({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe(true);
  });

  it("recognizes SQLite unique violations", () => {
    expect(isDuplicateKeyError({ message: "UNIQUE constraint failed: webhook_events.idempotency_key" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError({ code: "23503", message: "insert violates foreign key" })).toBe(false);
    expect(isDuplicateKeyError({ message: "connection refused" })).toBe(false);
  });
});
