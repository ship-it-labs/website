import { logger } from "../utils/logger.js";
import { supabase } from "../db/client.js";
import crypto from "crypto";

const isProduction = process.env.NODE_ENV === "production";
const WHOP_API_KEY = isProduction
  ? process.env.WHOP_LIVE_API_KEY
  : process.env.WHOP_SANDBOX_API_KEY;
const WHOP_PRODUCT_ID = isProduction
  ? process.env.WHOP_LIVE_PRODUCT_ID
  : process.env.WHOP_SANDBOX_PRODUCT_ID;
const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET || "";
const WHOP_API_URL = isProduction
  ? "https://api.whop.com/api/v1"
  : "https://api.whop.com/api/v1";

export interface WhopWebhookData {
  id?: string;
  status?: string;
  metadata?: { user_id?: string; plan_id?: string };
  plan_id?: string;
  current_period_start?: string;
  current_period_end?: string;
  cancel_at_period_end?: boolean;
}

export interface WhopWebhookEvent {
  id: string;
  event: string;
  data: WhopWebhookData;
}

export function validateWhopConfig(): void {  if (!WHOP_API_KEY) {
    throw new Error(
      isProduction
        ? "WHOP_LIVE_API_KEY is required in production"
        : "WHOP_SANDBOX_API_KEY is required in development"
    );
  }
  if (!WHOP_PRODUCT_ID) {
    throw new Error(
      isProduction
        ? "WHOP_LIVE_PRODUCT_ID is required in production"
        : "WHOP_SANDBOX_PRODUCT_ID is required in development"
    );
  }
}

export function verifyWhopWebhook(payload: string, signature: string): boolean {
  if (!WHOP_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", WHOP_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export async function createWhopCheckout(
  userId: string,
  planId: string,
  successUrl: string
): Promise<{ checkoutUrl: string }> {
  validateWhopConfig();

  const resp = await fetch(`${WHOP_API_URL}/checkouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHOP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_id: WHOP_PRODUCT_ID,
      metadata: { user_id: userId, plan_id: planId },
      redirect_url: successUrl,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    logger.error({ status: resp.status, text }, "Whop checkout creation failed");
    throw new Error("Failed to create checkout");
  }

  const data = (await resp.json()) as { data?: { url?: string }; url?: string };
  const checkoutUrl = data.data?.url ?? data.url;
  if (!checkoutUrl) {
    throw new Error("Whop did not return a checkout URL");
  }
  return { checkoutUrl };
}

export async function getWhopSubscription(subscriptionId: string): Promise<unknown> {
  const resp = await fetch(`${WHOP_API_URL}/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${WHOP_API_KEY}` },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { data?: unknown };
  return data.data ?? null;
}

export async function cancelWhopSubscription(subscriptionId: string): Promise<void> {
  const resp = await fetch(`${WHOP_API_URL}/subscriptions/${subscriptionId}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHOP_API_KEY}` },
  });
  if (!resp.ok) {
    logger.error({ subscriptionId, status: resp.status }, "Failed to cancel Whop subscription");
  }
}

export async function handleWhopWebhook(event: WhopWebhookEvent): Promise<void> {
  const { id, event: eventType, data } = event;

  const { error } = await supabase.from("webhook_events").insert({
    provider: "whop",
    event_type: eventType,
    payload: event,
    idempotency_key: id,
    processed: true,
  });

  if (error) {
    logger.error({ error, eventId: id }, "Failed to store webhook event");
    return;
  }

  switch (eventType) {
    case "subscription.created":
    case "subscription.updated": {
      const userId = data?.metadata?.user_id;
      const planId = data?.metadata?.plan_id || data?.plan_id;
      if (userId && planId) {
        await supabase
          .from("subscriptions")
          .upsert({
            user_id: userId,
            plan_id: planId,
            whop_subscription_id: data.id,
            status: data.status,
            current_period_start: data.current_period_start,
            current_period_end: data.current_period_end,
            cancel_at_period_end: data.cancel_at_period_end || false,
          });
        await supabase
          .from("users")
          .update({ plan_id: planId })
          .eq("id", userId);
      }
      break;
    }
    case "subscription.canceled": {
      const userId = data?.metadata?.user_id;
      if (userId) {
        await supabase
          .from("subscriptions")
          .update({ status: "canceled" })
          .eq("whop_subscription_id", data.id);
      }
      break;
    }
  }

  logger.info({ eventType, eventId: id }, "Whop webhook processed");
}
