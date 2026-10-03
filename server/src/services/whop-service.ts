import { WhopClient, WhopEnvironment } from "@whop/sdk";
import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { supabase } from "../db/index.js";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Sandbox and production are genuinely different Whop hosts, not the same
 * endpoint with a test key. The SDK exposes both, so the environment choice is
 * a single switch rather than two URL strings that can drift apart.
 */
const ENVIRONMENT = isProduction
  ? WhopEnvironment.Production
  : WhopEnvironment.Sandbox;

const API_VERSION_DATE = process.env.WHOP_API_VERSION_DATE || "2026-07-01";

/**
 * Read per call so the value reflects the live environment and a missing secret
 * is caught at verification time rather than at import time.
 */
function webhookSecret(): string {
  return process.env.WHOP_WEBHOOK_SECRET || "";
}

export class WhopConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhopConfigError";
  }
}

export function whopEnvironmentName(): "production" | "sandbox" {
  return isProduction ? "production" : "sandbox";
}

/**
 * A missing credential for the active environment is a hard failure. Falling
 * back to the other environment's key would either take real payments in
 * development or hand out sandbox entitlements in production.
 */
export function validateWhopConfig(): void {
  const key = activeApiKey();

  if (!key) {
    throw new WhopConfigError(
      isProduction
        ? "WHOP_LIVE_API_KEY is required when NODE_ENV=production. Refusing to fall back to the sandbox key."
        : "WHOP_SANDBOX_API_KEY is required in development. Refusing to fall back to the live key."
    );
  }

  if (isProduction && key.trim().length < 10) {
    throw new WhopConfigError("WHOP_LIVE_API_KEY looks truncated.");
  }
}

/** Reads the credential for the active environment, per call. */
function activeApiKey(): string {
  return isProduction
    ? process.env.WHOP_LIVE_API_KEY || ""
    : process.env.WHOP_SANDBOX_API_KEY || "";
}

let client: WhopClient | null = null;

export function whopClient(): WhopClient {
  const key = activeApiKey();

  if (!key) {
    throw new WhopConfigError(
      isProduction
        ? "WHOP_LIVE_API_KEY is required when NODE_ENV=production."
        : "WHOP_SANDBOX_API_KEY is required in development."
    );
  }

  if (!client) {
    client = new WhopClient({
      token: key,
      environment: ENVIRONMENT,
      apiVersionDate: API_VERSION_DATE,
      timeoutInSeconds: 30,
      maxRetries: 2,
    });
  }
  return client;
}

export interface CheckoutResult {
  purchaseUrl: string;
  planId: string;
}

/**
 * Resolves a platform tier to the Whop plan that sells it.
 *
 * Pricing is owned by Whop, so the platform stores no amounts for paid tiers and
 * keeps only the mapping. The ids come from the environment rather than the
 * database so that rotating a plan id is a configuration change, not a data
 * migration.
 */
const PLAN_ID_ENV: Record<string, string> = {
  pro: "WHOP_PRO_PLAN_ID",
  plus: "WHOP_PLUS_PLAN_ID",
  ultra: "WHOP_ULTRA_PLAN_ID",
};

export function whopPlanIdFor(planId: string): string | null {
  const envName = PLAN_ID_ENV[planId];
  if (!envName) return null;

  const value = process.env[envName]?.trim();
  if (!value) return null;

  // A plan id is prefixed `plan_`. Catching a pasted URL or a key here turns a
  // silent misconfiguration into an obvious error.
  if (!value.startsWith("plan_")) {
    logger.warn(
      { planId, envName },
      `${envName} does not look like a Whop plan id (expected a plan_ prefix)`
    );
    return null;
  }
  return value;
}

/** Reports which tiers are missing a Whop plan, so misconfiguration is visible. */
export function unconfiguredPlans(): string[] {
  return Object.keys(PLAN_ID_ENV).filter((planId) => !whopPlanIdFor(planId));
}

/**
 * Creates a checkout for an existing Whop plan and returns the link to send the
 * customer to.
 *
 * No redirect URL is configured. Whop returns a `purchase_url` that the client
 * opens, and where the customer lands afterwards is decided by our own route
 * reading the subscription, which keeps the destination in one place instead of
 * duplicating it into every checkout Whop stores.
 */
export async function createCheckout(options: {
  whopPlanId: string;
  userId: string;
  planId: string;
}): Promise<CheckoutResult> {
  const c = whopClient();

  const checkout = await c.checkoutConfigurations.create({
    plan_id: options.whopPlanId,
    metadata: {
      user_id: options.userId,
      plan_id: options.planId,
    },
  });

  if (!checkout.purchase_url) {
    throw new Error("Whop did not return a purchase_url for the checkout");
  }

  return { purchaseUrl: checkout.purchase_url, planId: checkout.plan?.id ?? options.whopPlanId };
}

export interface WhopMembership {
  id: string;
  plan_id: string;
  status: string;
  user_id: string | null;
  metadata: Record<string, unknown>;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
}

export async function retrieveMembership(membershipId: string): Promise<WhopMembership> {
  const c = whopClient();
  const membership = await c.memberships.retrieve({ id: membershipId });
  return membership as unknown as WhopMembership;
}

export async function listMembershipsForUser(
  userId: string,
  statuses?: string[]
): Promise<WhopMembership[]> {
  const c = whopClient();

  const page = await c.memberships.list({
    user_id: userId,
    ...(statuses ? { status: statuses as never } : {}),
  });

  return (page.data ?? []) as unknown as WhopMembership[];
}

/**
 * Cancels at period end by default so a customer keeps access until they paid
 * for. Passing cancel_at_period_end false would revoke immediately, which is
 * rarely what a "cancel my subscription" button should do.
 */
export async function cancelMembership(membershipId: string): Promise<void> {
  const c = whopClient();
  await c.memberships.cancel({
    id: membershipId,
    cancel_at_period_end: true,
  });
}

// Whop follows the Standard Webhooks spec.

export interface WhopWebhookEvent {
  id: string;
  type: string;
  api_version: string;
  data: Record<string, unknown>;
}

const REPLAY_WINDOW_SECONDS = 5 * 60;

/**
 * Verifies a Standard Webhooks signature over `{id}.{timestamp}.{body}` using
 * HMAC-SHA256 with the base64-decoded secret, then rejects anything outside the
 * replay window. The raw body must be used: re-serialising the parsed JSON
 * changes the bytes and the signature will not match.
 */
export function verifyWebhookSignature(params: {
  body: string;
  webhookId: string;
  timestamp: string;
  signature: string;
  now?: number;
}): boolean {
  const secret = webhookSecret();
  if (!secret) {
    logger.error("WHOP_WEBHOOK_SECRET is not configured; rejecting webhook");
    return false;
  }

  if (!params.webhookId || !params.timestamp || !params.signature) {
    return false;
  }

  const timestampSeconds = Number(params.timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor((params.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > REPLAY_WINDOW_SECONDS) {
    logger.warn({ timestamp: params.timestamp }, "Rejected webhook outside the replay window");
    return false;
  }

  const key = Buffer.from(secret, "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${params.webhookId}.${params.timestamp}.${params.body}`)
    .digest("base64");

  // The header carries one or more space separated `v1,<signature>` pairs.
  const candidates = params.signature
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter((value): value is string => Boolean(value));

  if (candidates.length === 0) {
    return false;
  }

  const expectedBuf = Buffer.from(expected);
  return candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate);
    return (
      candidateBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidateBuf, expectedBuf)
    );
  });
}

const PLAN_FOR_STATUS: Record<string, string | null> = {
  "membership.activated": "active",
  "membership.deactivated": "free",
  "membership.cancel_at_period_end_changed": "active",
  "payment.succeeded": "active",
  "payment.failed": "past_due",
  "refund.created": "free",
};

/**
 * Maps a Whop membership onto a local plan id. The plan id travels in the
 * membership metadata that was attached at checkout, so no reverse lookup
 * against Whop's plan catalogue is needed.
 *
 * Plus no longer exists: memberships created before the kill still carry its
 * id in metadata, and writing it to the user row would 401 every request once
 * the row is gone. Ultra is the surviving equivalent, matching the merge the
 * migration applied to stored rows.
 */
function planIdFromMembership(
  metadata: Record<string, unknown>,
  fallback: string | null
): string | null {
  const fromMetadata = metadata?.plan_id;
  if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
    if (fromMetadata === "plus") return "ultra";
    return fromMetadata;
  }
  return fallback;
}

export interface WebhookOutcome {
  handled: boolean;
  duplicate: boolean;
  userId?: string;
  planId?: string;
}

export async function handleWebhookEvent(
  event: WhopWebhookEvent
): Promise<WebhookOutcome> {
  const desiredStatus = PLAN_FOR_STATUS[event.type];
  if (!desiredStatus) {
    return { handled: false, duplicate: false };
  }

  // The unique constraint on idempotency_key makes duplicate delivery a no-op
  // rather than a double plan change.
  const { error: insertError } = await supabase.from("webhook_events").insert({
    provider: "whop",
    event_type: event.type,
    idempotency_key: event.id,
    payload: event as unknown as Record<string, unknown>,
    processed: false,
  });

  if (insertError) {
    if (insertError.code === "23505") {
      logger.info({ eventId: event.id, type: event.type }, "Duplicate webhook ignored");
      return { handled: true, duplicate: true };
    }
    logger.error({ err: insertError, eventId: event.id }, "Failed to record webhook");
    return { handled: false, duplicate: false };
  }

  const membership = event.data as unknown as WhopMembership;
  const userId =
    (typeof membership.metadata?.user_id === "string" ? membership.metadata.user_id : undefined) ??
    (typeof membership.user_id === "string" ? membership.user_id : undefined);

  if (!userId) {
    logger.warn({ eventId: event.id }, "Webhook carried no user id; nothing to update");
    await supabase
      .from("webhook_events")
      .update({ processed: true })
      .eq("idempotency_key", event.id);
    return { handled: false, duplicate: false };
  }

  // A deactivation or refund ends paid access, full stop. Stale metadata still
  // naming a paid tier must not override that, or an ex-customer keeps paid
  // limits forever on a dead subscription.
  const planId =
    desiredStatus === "free"
      ? "free"
      : planIdFromMembership(membership.metadata, null);

  const now = new Date().toISOString();
  const status =
    desiredStatus === "active"
      ? (membership.cancel_at_period_end ? "canceled" : "active")
      : desiredStatus;

  await supabase.from("subscriptions").upsert(
    {
      user_id: userId,
      plan_id: planId ?? "free",
      whop_membership_id: membership.id,
      whop_plan_id: membership.plan_id,
      status,
      current_period_end: membership.current_period_end,
      cancel_at_period_end: membership.cancel_at_period_end ?? false,
      updated_at: now,
    },
    { onConflict: "user_id" }
  );

  await supabase
    .from("users")
    .update({ plan_id: planId ?? "free" })
    .eq("id", userId);

  await supabase
    .from("webhook_events")
    .update({ processed: true })
    .eq("idempotency_key", event.id);

  logger.info(
    { eventId: event.id, type: event.type, userId, planId, status },
    "Whop webhook processed"
  );

  return { handled: true, duplicate: false, userId, planId: planId ?? "free" };
}
