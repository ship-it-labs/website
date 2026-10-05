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
      logger.error({ planId: plan_id }, "No Whop plan is configured for this tier");
      return reply.status(502).send({
        error: { code: "BILLING_NOT_CONFIGURED", message: "This plan is not available for purchase yet" },
      });
    }

    try {
      validateWhopConfig();

      // Whop returns the checkout link itself; there is no redirect to configure.
      const { purchaseUrl } = await createCheckout({
        whopPlanId,
        userId: req.auth!.userId,
        planId: plan_id,
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
    const { data, error } = await supabase
      .from("subscriptions")
      .select("whop_membership_id, status")
      .eq("user_id", req.auth!.userId)
      .eq("status", "active")
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

    const event = JSON.parse(raw) as WhopWebhookEvent;

    if (!event.type || !event.id) {
      return reply.status(400).send({
        error: { code: "INVALID_EVENT", message: "Webhook payload is missing type or id" },
      });
    }

    const outcome = await handleWebhookEvent(event);

    return reply.send({ received: true, ...outcome });
  });
}
