import { FastifyInstance } from "fastify";
import { authenticateApiKey } from "../middleware/auth.js";
import {
  createCheckout,
  cancelMembership,
  retrieveMembership,
  validateWhopConfig,
  verifyWebhookSignature,
  handleWebhookEvent,
  whopPlanIdFor,
  expectedWhopPlanEnvName,
  isSameTierActiveSubscription,
  type WhopWebhookEvent,
} from "../services/whop-service.js";
import { supabase } from "../db/index.js";
import { getAllPlans } from "../services/plan-service.js";
import { logger } from "../utils/logger.js";

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/plans", async (_req, reply) => {
    const plans = await getAllPlans();
    return reply.send({ plans });
  });

  app.post("/billing/checkout", { preHandler: authenticateApiKey }, async (req, reply) => {
    const { plan_id } = req.body as { plan_id: string };

    const { data: plan, error } = await supabase
      .from("plans")
      .select("id, name, price_cents")
      .eq("id", plan_id)
      .single();

    if (error || !plan) {
      return reply.status(404).send({
        error: { code: "PLAN_NOT_FOUND", message: "Unknown plan" },
      });
    }

    if (plan.price_cents === 0) {
      return reply.status(400).send({
        error: { code: "PLAN_IS_FREE", message: "The free plan does not require checkout" },
      });
    }

    // Whop owns pricing, so the platform's tiers map to Whop plans held in the
    // environment rather than storing amounts or ids of its own.
    const whopPlanId = whopPlanIdFor(plan_id);

    if (!whopPlanId) {
      const missingEnv = expectedWhopPlanEnvName(plan_id);
      logger.error({ planId: plan_id, missingEnv }, "No Whop plan is configured for this tier");
      return reply.status(502).send({
        error: { code: "BILLING_NOT_CONFIGURED", message: "This plan is not available for purchase yet" },
        // The variable an admin must set, not a riddle for support to solve.
        ...(missingEnv ? { missing_env: missingEnv } : {}),
      });
    }

    // Buying the tier you already hold would open a second paid membership for
    // the same plan. The UI hides the button, and this refuses the direct API
    // call too — a double-click or a crafted request must not double-bill.
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("plan_id, status, cancel_at_period_end")
      .eq("user_id", req.auth!.userId)
      .order("updated_at", { ascending: false })
      .limit(1);
    const current = (existing?.[0] ?? null) as {
      plan_id?: string;
      status?: string;
      cancel_at_period_end?: boolean | number | null;
    } | null;

    if (isSameTierActiveSubscription(current, plan_id)) {
      return reply.status(400).send({
        error: { code: "ALREADY_SUBSCRIBED", message: "This plan is already active on your account" },
      });
    }

    // Idempotency: prevent double-click double-billing by checking for an
    // in-flight checkout for this user+plan within the last 2 minutes. A webhook
    // will complete or fail the purchase; until then we return the existing URL.
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: inflight } = await supabase
      .from("webhook_events")
      .select("id, created_at, payload")
      .eq("provider", "whop")
      .eq("event_type", "checkout.created")
      .gte("created_at", twoMinutesAgo)
      .limit(1);
    // payload carries {user_id, plan_id} in metadata; we check loosely to
    // avoid schema coupling. If present, reuse.
    const inflightCheckout = (inflight?.[0] as { payload?: { data?: { purchase_url?: string }; metadata?: { user_id?: string; plan_id?: string } } } | null);
    if (inflightCheckout?.payload?.metadata?.user_id === req.auth!.userId &&
        inflightCheckout?.payload?.metadata?.plan_id === plan_id &&
        inflightCheckout.payload.data?.purchase_url) {
      return reply.send({ checkout_url: inflightCheckout.payload.data.purchase_url });
    }

    try {
      validateWhopConfig();

      // Whop returns the checkout link itself; there is no redirect to configure.
      const { purchaseUrl } = await createCheckout({
        whopPlanId,
        userId: req.auth!.userId,
        planId: plan_id,
        source: "dashboard",
      });

      return reply.send({ checkout_url: purchaseUrl });
    } catch (err) {
      logger.error({ err, planId: plan_id }, "Failed to create Whop checkout");
      return reply.status(502).send({
        error: { code: "CHECKOUT_FAILED", message: "Could not start checkout" },
      });
    }
  });

  app.get("/billing/subscription", { preHandler: authenticateApiKey }, async (req, reply) => {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", req.auth!.userId)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not load the subscription" },
      });
    }

    const subscription = (data?.[0] ?? null) as Record<string, unknown> | null;

    // Whop's self-serve management page (plan changes, payment method,
    // cancellation) for the "Manage in Whop" button. Fetched live rather than
    // stored: it is a URL, not state, and a stale one is worse than none.
    // Missing means the button hides, never an error.
    let manageUrl: string | null = null;
    const membershipId = subscription?.whop_membership_id;
    if (typeof membershipId === "string" && membershipId) {
      try {
        const membership = await retrieveMembership(membershipId);
        manageUrl = membership.manage_url ?? null;
      } catch (err) {
        logger.warn({ err, userId: req.auth!.userId }, "Could not fetch Whop manage URL");
      }
    }

    return reply.send({ subscription: subscription ? { ...subscription, manage_url: manageUrl } : null });
  });

  app.post("/billing/cancel", { preHandler: authenticateApiKey }, async (req, reply) => {
    // Every billable state, not just active: a past-due or trialing customer
    // asking out must reach the same door, not a "no subscription" wall.
    const { data, error } = await supabase
      .from("subscriptions")
      .select("whop_membership_id, status")
      .eq("user_id", req.auth!.userId)
      .in("status", ["active", "past_due", "trialing"])
      .limit(1);

    if (error) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Could not load the subscription" },
      });
    }

    const membershipId = data?.[0]?.whop_membership_id;
    if (!membershipId) {
      return reply.status(404).send({
        error: { code: "NO_SUBSCRIPTION", message: "No active subscription to cancel" },
      });
    }

    try {
      await cancelMembership(membershipId);

      // Reflect the scheduled cancellation locally immediately so the UI
      // doesn't show "active + Cancel" until the webhook lands (which can
      // be delayed or fail). The webhook will reconcile to the final state.
      await supabase
        .from("subscriptions")
        .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
        .eq("whop_membership_id", membershipId);

      return reply.send({ success: true, cancel_at_period_end: true });
    } catch (err) {
      logger.error({ err, membershipId }, "Whop cancellation failed");
      return reply.status(502).send({
        error: { code: "CANCEL_FAILED", message: "Could not cancel the subscription" },
      });
    }
  });
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/whop", async (req, reply) => {
    const webhookId = req.headers["webhook-id"];
    const timestamp = req.headers["webhook-timestamp"];
    const signature = req.headers["webhook-signature"];

    const header = (value: string | string[] | undefined): string =>
      Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

    const raw =
      (req as unknown as { rawBody?: string }).rawBody ??
      (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));

    const valid = verifyWebhookSignature({
      body: raw,
      webhookId: header(webhookId),
      timestamp: header(timestamp),
      signature: header(signature),
    });

    if (!valid) {
      return reply.status(401).send({
        error: { code: "BAD_SIGNATURE", message: "Webhook signature verification failed" },
      });
    }

    let event: WhopWebhookEvent;
    try {
      event = JSON.parse(raw) as WhopWebhookEvent;
    } catch {
      return reply.status(400).send({
        error: { code: "INVALID_JSON", message: "Webhook payload is not valid JSON" },
      });
    }

    if (!event.type || !event.id) {
      return reply.status(400).send({
        error: { code: "INVALID_EVENT", message: "Webhook payload is missing type or id" },
      });
    }

    const outcome = await handleWebhookEvent(event);

    // A failure here is a 500, not a 200 with handled:false: Whop retries
    // failures, which is exactly what a half-applied event needs, while a
    // silent 200 would lose the payment mapping forever. Duplicates already
    // report handled:true above and stay 200.
    if (!outcome.handled && !outcome.duplicate) {
      return reply.status(500).send({
        error: { code: "WEBHOOK_NOT_HANDLED", message: "Event recorded for retry" },
        ...outcome,
      });
    }

    return reply.send({ received: true, ...outcome });
  });
}
