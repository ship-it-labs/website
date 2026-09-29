import { FastifyInstance } from "fastify";
import { authenticateApiKey } from "../middleware/auth.js";
import {
  verifyWhopWebhook,
  handleWhopWebhook,
  createWhopCheckout,
  cancelWhopSubscription,
  type WhopWebhookEvent,
} from "../services/whop-service.js";
import { supabase } from "../db/client.js";
import { getAllPlans } from "../services/plan-service.js";

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/plans", async (_req, reply) => {
    const plans = await getAllPlans();
    return reply.send({ plans });
  });

  app.post("/billing/checkout", { preHandler: authenticateApiKey }, async (req, reply) => {
    const { plan_id } = req.body as { plan_id: string };

    try {
      const { checkoutUrl } = await createWhopCheckout(
        req.auth!.userId,
        plan_id,
        `${process.env.FRONTEND_URL || "http://localhost:5173"}/dashboard/billing?success=1`
      );
      return reply.send({ checkout_url: checkoutUrl });
    } catch (err) {
      return reply.status(502).send({
        error: { code: "CHECKOUT_FAILED", message: "Failed to create checkout" },
      });
    }
  });

  app.get("/billing/subscription", { preHandler: authenticateApiKey }, async (req, reply) => {
    const { data } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", req.auth!.userId)
      .order("created_at", { ascending: false })
      .limit(1);

    return reply.send({ subscription: data?.[0] || null });
  });

  app.post("/billing/cancel", { preHandler: authenticateApiKey }, async (req, reply) => {
    const { data } = await supabase
      .from("subscriptions")
      .select("whop_subscription_id")
      .eq("user_id", req.auth!.userId)
      .eq("status", "active")
      .limit(1);

    const whopId = data?.[0]?.whop_subscription_id;
    if (!whopId) {
      return reply.status(404).send({
        error: { code: "NO_SUBSCRIPTION", message: "No active subscription" },
      });
    }

    await cancelWhopSubscription(whopId);
    return reply.send({ success: true });
  });
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/whop", async (req, reply) => {
    const signature = req.headers["x-whop-signature"];
    if (typeof signature !== "string") {
      return reply.status(401).send({ error: { code: "BAD_SIGNATURE", message: "Missing signature" } });
    }

    const raw = JSON.stringify(req.body);
    if (!verifyWhopWebhook(raw, signature)) {
      return reply.status(401).send({ error: { code: "BAD_SIGNATURE", message: "Invalid signature" } });
    }

    await handleWhopWebhook(req.body as WhopWebhookEvent);
    return reply.send({ success: true });
  });
}
