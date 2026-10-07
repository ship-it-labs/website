import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { planIdFromMembership, isDuplicateKeyError, whopPlanIdOf, classifyWebhookObject, whopPlanIdFor, expectedWhopPlanEnvName, isSameTierActiveSubscription, promoCodeOf, verifyWebhookSignature } from "../src/services/whop-service.js";

/**
 * Whop uses the Standard Webhooks spec. These tests exercise the real signature
 * scheme, plus the replay window and the sandbox/live split, without needing
 * Whop credentials.
 *
 * Standard Webhooks signs with base64-decoded secrets. The test secret is
 * stored as a base64 string in env; signing uses the decoded key.
 */
const SECRET_B64 = Buffer.from("whop-sandbox-test-secret", "utf8").toString("base64");

function sign(body: string, id: string, timestamp: string, secretB64 = SECRET_B64): string {
  const digest = crypto
    .createHmac("sha256", Buffer.from(secretB64, "base64"))
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
    process.env.WHOP_WEBHOOK_SECRET = SECRET_B64;
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

  it("returns the promo code when present", () => {
    expect(promoCodeOf({ ...base, promo_code: "FREE50" })).toBe("FREE50");
  });

  it("returns null for missing or misshapen promo codes", () => {
    expect(promoCodeOf({ ...base })).toBeNull();
    expect(promoCodeOf({ ...base, promo_code: null })).toBeNull();
    expect(promoCodeOf({ ...base, promo_code: "" })).toBeNull();
    expect(promoCodeOf({ ...base, promo_code: 42 as unknown as string })).toBeNull();
  });
});

describe("duplicate checkout guard", () => {
  // Buying the tier you already hold opens a second paid membership. The
  // checkout route refuses those; anything else (different tier, dead status,
  // scheduled cancellation) proceeds.
  it("blocks re-buying the active tier", () => {
    expect(isSameTierActiveSubscription({ plan_id: "pro", status: "active" }, "pro")).toBe(true);
    expect(isSameTierActiveSubscription({ plan_id: "pro", status: "past_due" }, "pro")).toBe(true);
    expect(isSameTierActiveSubscription({ plan_id: "pro", status: "trialing" }, "pro")).toBe(true);
  });

  it("allows a different tier", () => {
    expect(isSameTierActiveSubscription({ plan_id: "pro", status: "active" }, "ultra")).toBe(false);
  });

  it("allows dead or departing states", () => {
    expect(isSameTierActiveSubscription({ plan_id: "pro", status: "canceled" }, "pro")).toBe(false);
    expect(isSameTierActiveSubscription({ plan_id: "pro", status: "free" }, "pro")).toBe(false);
    expect(isSameTierActiveSubscription({ plan_id: "free", status: "active" }, "pro")).toBe(false);
    expect(
      isSameTierActiveSubscription({ plan_id: "pro", status: "active", cancel_at_period_end: true }, "pro")
    ).toBe(false);
    expect(isSameTierActiveSubscription(null, "pro")).toBe(false);
  });
});

describe("webhook object routing", () => {  // Payment and refund objects once flowed down the membership write path and
  // overwrote subscription identity with pay_/re_ ids. Routing by prefix keeps
  // every current and future non-membership shape on the status-only path.
  it("routes memberships to full handling", () => {
    expect(classifyWebhookObject("mem_abc123")).toBe("membership");
  });

  it("routes payments, refunds and unknowns to status-only refresh", () => {
    expect(classifyWebhookObject("pay_abc123")).toBe("reference");
    expect(classifyWebhookObject("re_abc123")).toBe("reference");
    expect(classifyWebhookObject("")).toBe("reference");
    expect(classifyWebhookObject(undefined)).toBe("reference");
    expect(classifyWebhookObject(null)).toBe("reference");
    expect(classifyWebhookObject(42)).toBe("reference");
  });
});

describe("environment-specific plan ids", () => {
  const keys = [
    "SANDBOX_PRO_PLAN_ID",
    "SANDBOX_ULTRA_PLAN_ID",
    "PROD_PRO_PLAN_ID",
    "PROD_ULTRA_PLAN_ID",
    "WHOP_PRO_PLAN_ID",
    "WHOP_ULTRA_PLAN_ID",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("prefers the environment-specific variable", () => {
    process.env.NODE_ENV = "development";
    process.env.SANDBOX_PRO_PLAN_ID = "plan_sandbox";
    process.env.WHOP_PRO_PLAN_ID = "plan_legacy";
    expect(whopPlanIdFor("pro")).toBe("plan_sandbox");
  });

  it("reads the production column in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PROD_ULTRA_PLAN_ID = "plan_live";
    process.env.WHOP_ULTRA_PLAN_ID = "plan_legacy";
    expect(whopPlanIdFor("ultra")).toBe("plan_live");
  });

  it("falls back to the legacy shared variable", () => {
    process.env.NODE_ENV = "development";
    process.env.WHOP_PRO_PLAN_ID = "plan_legacy";
    expect(whopPlanIdFor("pro")).toBe("plan_legacy");
  });

  it("returns null for unknown tiers and bad values", () => {
    expect(whopPlanIdFor("enterprise")).toBeNull();
    process.env.SANDBOX_PRO_PLAN_ID = "https://whop.com/not-an-id";
    expect(whopPlanIdFor("pro")).toBeNull();
  });

  it("names the environment-specific variable for error messages", async () => {
    process.env.NODE_ENV = "development";
    const { expectedWhopPlanEnvName } = await freshService();
    expect(expectedWhopPlanEnvName("pro")).toBe("SANDBOX_PRO_PLAN_ID");
    expect(expectedWhopPlanEnvName("ultra")).toBe("SANDBOX_ULTRA_PLAN_ID");
    expect(expectedWhopPlanEnvName("enterprise")).toBeNull();
  });

  it("names the production variable in production", async () => {
    process.env.NODE_ENV = "production";
    const { expectedWhopPlanEnvName } = await freshService();
    expect(expectedWhopPlanEnvName("pro")).toBe("PROD_PRO_PLAN_ID");
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

describe("environment-specific webhook secrets", () => {
  const secretKeys = ["SANDBOX_WEBHOOK_SECRET", "PROD_WEBHOOK_SECRET", "WHOP_WEBHOOK_SECRET"];

  function signWith(secretB64: string, body: string, id: string, timestamp: string): string {
    const digest = crypto
      .createHmac("sha256", Buffer.from(secretB64, "base64"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    return `v1,${digest}`;
  }

  beforeEach(() => {
    for (const key of secretKeys) delete process.env[key];
  });

  // The file-level afterEach restores the whole environment afterwards.

  function payload() {
    const body = JSON.stringify({ type: "membership.activated", data: {} });
    const id = "msg_env_test";
    const timestamp = String(Math.floor(Date.now() / 1000));
    return { body, id, timestamp };
  }

  it("verifies with the sandbox secret in development", async () => {
    const sandboxSecretB64 = Buffer.from("sandbox-only-secret", "utf8").toString("base64");
    process.env.NODE_ENV = "development";
    process.env.SANDBOX_WEBHOOK_SECRET = sandboxSecretB64;
    const { verifyWebhookSignature } = await freshService();
    const { body, id, timestamp } = payload();

    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp, signature: signWith(sandboxSecretB64, body, id, timestamp) })
    ).toBe(true);
  });

  it("prefers the specific secret over the legacy one", async () => {
    const sandboxSecretB64 = Buffer.from("sandbox-only-secret", "utf8").toString("base64");
    const legacySecretB64 = Buffer.from("legacy-secret", "utf8").toString("base64");
    process.env.NODE_ENV = "development";
    process.env.SANDBOX_WEBHOOK_SECRET = sandboxSecretB64;
    process.env.WHOP_WEBHOOK_SECRET = legacySecretB64;
    const { verifyWebhookSignature } = await freshService();
    const { body, id, timestamp } = payload();

    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp, signature: signWith(sandboxSecretB64, body, id, timestamp) })
    ).toBe(true);
    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp, signature: signWith(legacySecretB64, body, id, timestamp) })
    ).toBe(false);
  });

  it("falls back to the legacy secret when nothing specific is set", async () => {
    const legacySecretB64 = Buffer.from("legacy-secret", "utf8").toString("base64");
    process.env.NODE_ENV = "development";
    process.env.WHOP_WEBHOOK_SECRET = legacySecretB64;
    const { verifyWebhookSignature } = await freshService();
    const { body, id, timestamp } = payload();

    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp, signature: signWith(legacySecretB64, body, id, timestamp) })
    ).toBe(true);
  });

  it("verifies with the production secret in production", async () => {
    const prodSecretB64 = Buffer.from("prod-only-secret", "utf8").toString("base64");
    const sandboxSecretB64 = Buffer.from("sandbox-only-secret", "utf8").toString("base64");
    process.env.NODE_ENV = "production";
    process.env.PROD_WEBHOOK_SECRET = prodSecretB64;
    process.env.SANDBOX_WEBHOOK_SECRET = sandboxSecretB64;
    const { verifyWebhookSignature } = await freshService();
    const { body, id, timestamp } = payload();

    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp, signature: signWith(prodSecretB64, body, id, timestamp) })
    ).toBe(true);
    expect(
      verifyWebhookSignature({ body, webhookId: id, timestamp, signature: signWith(sandboxSecretB64, body, id, timestamp) })
    ).toBe(false);
  });
});
