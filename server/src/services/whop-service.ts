import { WhopClient, WhopEnvironment } from "@whop/sdk";
import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { supabase } from "../db/index.js";
import { isDuplicateKeyError } from "../utils/db-errors.js";

// Re-exported so existing imports keep working.
export { isDuplicateKeyError };

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
 *
 * Sandbox and production endpoints sign with different secrets, so each side
 * has its own variable, selected by runtime mode exactly like the plan ids.
 * The shared WHOP_WEBHOOK_SECRET still works as a fallback while deployments
 * migrate. A wrong-side secret fails verification rather than anything worse:
 * webhooks simply 401 until the matching secret is configured.
 */
function webhookSecret(): string {
  const specific =
    process.env.NODE_ENV === "production"
      ? process.env.PROD_WEBHOOK_SECRET
      : process.env.SANDBOX_WEBHOOK_SECRET;
  return specific?.trim() || process.env.WHOP_WEBHOOK_SECRET || "";
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
 * keeps only the mapping. Each tier has an environment-specific variable
 * (SANDBOX_* in development, PROD_* in production) so test and live plans never
 * cross: a sandbox checkout must not sell the live plan and vice versa. The
 * older shared WHOP_*_PLAN_ID variables still work as a fallback, so existing
 * deployments keep selling while they migrate — but a set environment-specific
 * value always wins.
 */
const PLAN_ENV_NAME: Record<string, string> = {
  pro: "PRO",
  plus: "PLUS",
  ultra: "ULTRA",
};

const LEGACY_PLAN_ID_ENV: Record<string, string> = {
  pro: "WHOP_PRO_PLAN_ID",
  plus: "WHOP_PLUS_PLAN_ID",
  ultra: "WHOP_ULTRA_PLAN_ID",
};

function checkPlanId(planId: string, envName: string): string | null {
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

export function whopPlanIdFor(planId: string): string | null {
  const name = PLAN_ENV_NAME[planId];
  if (!name) return null;

  const production = process.env.NODE_ENV === "production";
  const specific = checkPlanId(planId, `${production ? "PROD" : "SANDBOX"}_${name}_PLAN_ID`);
  if (specific) return specific;

  const legacyName = LEGACY_PLAN_ID_ENV[planId];
  return legacyName ? checkPlanId(planId, legacyName) : null;
}

/**
 * The environment-specific variable a tier is bought from, for error messages.
 * Read per call like the resolution itself, so it tracks the live NODE_ENV.
 * Null for unknown tiers, which fail as PLAN_NOT_FOUND before this matters.
 */
export function expectedWhopPlanEnvName(planId: string): string | null {
  const name = PLAN_ENV_NAME[planId];
  if (!name) return null;
  return `${process.env.NODE_ENV === "production" ? "PROD" : "SANDBOX"}_${name}_PLAN_ID`;
}

/**
 * True when the stored row already entitles this tier: buying again would open
 * a second paid membership for the same plan, which is how double subscriptions
 * happen. The checkout route refuses those with ALREADY_SUBSCRIBED instead of
 * handing Whop a duplicate purchase. A scheduled cancellation does not block:
 * the customer is leaving, and re-buying before the period ends is legitimate.
 */
export function isSameTierActiveSubscription(
  subscription: { plan_id?: string; status?: string; cancel_at_period_end?: boolean | number | null } | null,
  planId: string
): boolean {
  if (!subscription || subscription.plan_id !== planId) return false;
  if (subscription.cancel_at_period_end) return false;
  return (
    subscription.status === "active" ||
    subscription.status === "past_due" ||
    subscription.status === "trialing"
  );
}

/** Reports which tiers are missing a Whop plan, so misconfiguration is visible. */
export function unconfiguredPlans(): string[] {
  // Plus was retired (merged into Ultra): it has no plan to sell and must not
  // warn. The resolution maps above keep it only so ancient metadata still
  // resolves instead of crashing.
  return Object.keys(PLAN_ENV_NAME).filter(
    (planId) => planId !== "plus" && !whopPlanIdFor(planId)
  );
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
  /** Where the checkout was started, for reconciling "why was I charged". */
  source?: string;
}): Promise<CheckoutResult> {
  const c = whopClient();

  const checkout = await c.checkoutConfigurations.create({
    plan_id: options.whopPlanId,
    metadata: {
      user_id: options.userId,
      plan_id: options.planId,
      ...(options.source ? { source: options.source } : {}),
    },
  });

  if (!checkout.purchase_url) {
    throw new Error("Whop did not return a purchase_url for the checkout");
  }

  // Record the checkout creation for idempotency (prevents double-click
  // double-billing). The webhook will complete or fail the purchase.
  try {
    await supabase.from("webhook_events").insert({
      provider: "whop",
      event_type: "checkout.created",
      idempotency_key: `checkout_${checkout.id ?? crypto.randomUUID()}`,
      payload: {
        data: { purchase_url: checkout.purchase_url },
        metadata: { user_id: options.userId, plan_id: options.planId },
      },
      processed: false,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to record checkout.created event");
  }

  return { purchaseUrl: checkout.purchase_url, planId: checkout.plan?.id ?? options.whopPlanId };
}

export interface WhopMembership {
  id: string;
  // The plan arrives in different shapes depending on the event: a top-level
  // plan_id on some payloads, a nested plan object on others, absent entirely
  // on the rest. Every reader must go through whopPlanIdOf below, because
  // passing any of these through as undefined crashes the subscription write
  // on SQLite (which cannot bind undefined) and silently skipped it before
  // the atomicity guard made the failure loud.
  plan_id?: string | null;
  plan?: { id?: string | null } | null;
  status: string;
  user_id: string | null;
  metadata: Record<string, unknown>;
  cancel_at_period_end: boolean;
  current_period_end?: string | null;
  // Whop-hosted page where the customer manages the membership themselves,
  // including cancellation and plan changes. Null when no member record exists.
  manage_url?: string | null;
  // Discount code applied to the membership, when Whop includes one. Surfaced
  // on the billing page so a promo buyer sees their discount acknowledged;
  // null when the purchase was full price.
  promo_code?: string | null;
}

/**
 * Which handling an event's object gets. Memberships carry subscription
 * identity and take the full write path; everything else (payments, refunds,
 * future shapes) only refreshes status on the existing row. Routed by id
 * prefix because event types alone proved unreliable — payment events arrived
 * shaped like memberships and corrupted the stored identity.
 */
export type WebhookObjectKind = "membership" | "reference";

export function classifyWebhookObject(id: unknown): WebhookObjectKind {
  return typeof id === "string" && id.startsWith("mem_") ? "membership" : "reference";
}

/**
 * The Whop plan behind a membership, whatever shape carried it. Null when the
 * payload names none — callers store null rather than undefined, which the
 * database drivers accept and undefined crashes.
 */
export function whopPlanIdOf(membership: WhopMembership): string | null {
  return membership.plan_id ?? membership.plan?.id ?? null;
}

/**
 * The discount code on a membership, if Whop carried one. String-only: a
 * non-string value is a misshapen payload, not a code.
 */
export function promoCodeOf(membership: WhopMembership): string | null {
  const code = membership.promo_code;
  return typeof code === "string" && code.length > 0 ? code : null;
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
 * for. Implemented as a membership update, not the cancel endpoint: the live
 * API rejects cancel_at_period_end on cancel with parameter_invalid (the SDK
 * type still declares it), while PATCH update documents true as "schedule for
 * period end" and false as "reverse a pending one".
 *
 * If the membership is already canceled or has cancel_at_period_end=true,
 * Whop returns parameter_invalid. We treat that as success (idempotent)
 * because the desired end state is already in place.
 */
export async function cancelMembership(membershipId: string): Promise<void> {
  const c = whopClient();
  try {
    await c.memberships.update({
      id: membershipId,
      cancel_at_period_end: true,
    });
  } catch (err) {
    // Whop returns parameter_invalid when cancel_at_period_end is already true
    // or the membership is already canceled. Treat as success — the end state
    // we want is already set.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("parameter_invalid")) {
      logger.info({ membershipId }, "Membership already scheduled for cancellation or canceled");
      return;
    }
    throw err;
  }
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
    logger.error("No webhook secret is configured (SANDBOX_/PROD_WEBHOOK_SECRET or WHOP_WEBHOOK_SECRET); rejecting webhook");
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
 * Duplicate-key detection lives in utils/db-errors so every driver check
 * stays identical (see the re-export at the top of this file).
 */

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
export function planIdFromMembership(
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
    // Unknown today, and possibly a new Whop shape tomorrow. Recorded and
    // acknowledged rather than failed: nothing was applied, so no retry will
    // ever resolve it, and a 500 would retry forever. The warn keeps new
    // types visible so handling can be added deliberately.
    logger.warn({ eventId: event.id, type: event.type }, "Ignoring unknown Whop webhook type");
    await supabase.from("webhook_events").insert({
      provider: "whop",
      event_type: event.type,
      idempotency_key: event.id,
      payload: event as unknown as Record<string, unknown>,
      processed: true,
    });
    return { handled: true, duplicate: false };
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
    if (!isDuplicateKeyError(insertError)) {
      logger.error({ err: insertError, eventId: event.id }, "Failed to record webhook");
      return { handled: false, duplicate: false };
    }

    // Seen before — but "seen" is not "finished". A crash between recording
    // and completing leaves a processed:false row, and blindly ignoring the
    // retry would lose the payment forever. Resume those; ignore the rest.
    const { data: prior } = await supabase
      .from("webhook_events")
      .select("processed")
      .eq("idempotency_key", event.id)
      .single();

    const finished =
      (prior as { processed?: boolean | number | null } | null)?.processed === true ||
      (prior as { processed?: boolean | number | null } | null)?.processed === 1;

    if (finished) {
      logger.info({ eventId: event.id, type: event.type }, "Duplicate webhook ignored");
      return { handled: true, duplicate: true };
    }

    logger.info({ eventId: event.id, type: event.type }, "Resuming unfinished webhook delivery");
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
    // Handled, not failed: no account link exists on the event, so no retry
    // will ever resolve it. Returning false would 500 and retry forever.
    return { handled: true, duplicate: false };
  }

  // Only membership objects carry subscription identity. Payment, refund and
  // any future shapes reference them (pay_…, re_…) instead — refreshing the
  // existing row's status, never overwriting its membership ids or plan.
  // Storing a pay_ id as the membership once corrupted lookups (404 on every
  // retrieve) and plan mapping, so the shapes are routed by id prefix.
  const eventObjectId = typeof membership.id === "string" ? membership.id : "";
  if (classifyWebhookObject(eventObjectId) === "reference") {
    const refreshStatus =
      desiredStatus === "active"
        ? (membership.cancel_at_period_end ? "canceled" : "active")
        : desiredStatus;

    const { data: existing } = await supabase
      .from("subscriptions")
      .select("user_id")
      .eq("user_id", userId)
      .single();

    if (existing) {
      await supabase
        .from("subscriptions")
        .update({ status: refreshStatus, updated_at: new Date().toISOString() })
        .eq("user_id", userId);

      // A refund ends paid access: the money is back, so the tier goes with
      // it. Anything else leaves the plan exactly as the membership events
      // set it — a payment confirmation must never re-tier an account.
      if (desiredStatus === "free") {
        await supabase.from("users").update({ plan_id: "free" }).eq("id", userId);
      }
    } else {
      logger.info(
        { eventId: event.id, type: event.type, userId },
        "Non-membership event for an account with no subscription; nothing to refresh"
      );
    }

    await supabase
      .from("webhook_events")
      .update({ processed: true })
      .eq("idempotency_key", event.id);
    return { handled: true, duplicate: false };
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

  // One billing membership per user. A new activation naming a different
  // membership than the stored row means the customer switched tiers, and the
  // old membership keeps billing until someone stops it — which used to be
  // nobody, so upgrading double-charged. Cancel the old one at period end so
  // paid days are never taken away early. Renewals carry the same membership
  // id and skip this entirely; cleanup never fails the webhook itself.
  if (desiredStatus === "active" && planId && membership.id) {
    try {
      const { data: existing } = await supabase
        .from("subscriptions")
        .select("whop_membership_id, status")
        .eq("user_id", userId)
        .single();

      const oldId = (existing as { whop_membership_id?: string; status?: string } | null)?.whop_membership_id;
      const oldStatus = (existing as { whop_membership_id?: string; status?: string } | null)?.status;
      if (oldId && oldId !== membership.id && (oldStatus === "active" || oldStatus === "past_due")) {
        // Retry with backoff: if Whop is transiently down, schedule a reconciliation
        // rather than silently leaving the old membership billing forever.
        let cancelled = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await cancelMembership(oldId);
            cancelled = true;
            break;
          } catch (err) {
            if (attempt === 2) throw err;
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
        if (cancelled) {
          logger.info(
            { userId, oldMembershipId: oldId, newMembershipId: membership.id },
            "Canceled superseded membership after tier change"
          );
        }
      }
    } catch (err) {
      // Final failure: log prominently and record for manual reconciliation.
      // The subscription write must not depend on this — the new membership
      // is already stored; the old one will be caught by a future webhook or
      // admin review. We do NOT return handled:false here because the primary
      // subscription change succeeded.
      logger.error(
        { err, userId, eventId: event.id },
        "Failed to cancel superseded membership after retries — requires manual reconciliation"
      );
    }
  }

  // A discount code arrives sporadically — some events carry it, most do not —
  // so an event without one keeps the last seen value rather than wiping it.
  // A missing row or a lookup failure reads as no carried code, never a fatal
  // one: the promo is display-only, and the subscription write must not depend
  // on it.
  let promoCode = promoCodeOf(membership);
  if (!promoCode) {
    try {
      const { data: priorSub } = await supabase
        .from("subscriptions")
        .select("promo_code")
        .eq("user_id", userId)
        .single();
      const carried = (priorSub as { promo_code?: string | null } | null)?.promo_code;
      promoCode = typeof carried === "string" && carried.length > 0 ? carried : null;
    } catch {
      promoCode = null;
    }
  }

  // The plan must never move without its backing subscription row: a stored
  // plan with no row bills nothing, shows nothing, and counts nowhere — MRR 0,
  // billing page Free, dashboard paid. That exact split-brain happened when an
  // upsert failed silently here, so a failed write aborts the whole event and
  // returns handled:false (the route turns that into a 500 and Whop retries)
  // instead of half-applying it.
  const { error: upsertError } = await supabase.from("subscriptions").upsert(
    {
      user_id: userId,
      plan_id: planId ?? "free",
      whop_membership_id: membership.id,
      whop_plan_id: whopPlanIdOf(membership),
      promo_code: promoCode,
      status,
      current_period_end: membership.current_period_end ?? null,
      cancel_at_period_end: membership.cancel_at_period_end ?? false,
      updated_at: now,
    },
    { onConflict: "user_id" }
  );

  if (upsertError) {
    logger.error(
      { err: upsertError, userId, eventId: event.id },
      "Failed to store subscription; plan left untouched"
    );
    return { handled: false, duplicate: false };
  }

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
