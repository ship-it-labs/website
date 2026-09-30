import { FastifyInstance } from "fastify";
import { authenticateApiKey } from "../middleware/auth.js";
import {
  createCheckout,
  cancelMembership,
  validateWhopConfig,
  verifyWebhookSignature,
  handleWebhookEvent,
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
      .select("id, name, whop_product_id, price_cents")
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

    if (!plan.whop_product_id) {
      logger.error({ planId: plan_id }, "Plan has no Whop plan mapping");
      return reply.status(502).send({
        error: { code: "BILLING_NOT_CONFIGURED", message: "This plan is not available for purchase yet" },
      });
    }

    try {
      validateWhopConfig();

      const { purchaseUrl } = await createCheckout({
        whopPlanId: plan.whop_product_id,
        userId: req.auth!.userId,
        planId: plan_id,
        redirectUrl: `${process.env.FRONTEND_URL || "http://localhost:5173"}/dashboard/billing`,
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

    return reply.send({ subscription: data?.[0] ?? null });
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
    const webhookId = req.headers["whop-webhook-id"];
    const timestamp = req.headers["whop-timestamp"];
    const signature = req.headers["whop-signature"];

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
