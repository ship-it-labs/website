import { FastifyInstance } from "fastify";
import { supabase } from "../db/client.js";
import { generateApiKey } from "../utils/api-key.js";
import { seedPlans } from "../services/plan-service.js";
import { logger } from "../utils/logger.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/signup", async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    if (!email || !password) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "email and password required" } });
    }

    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .single();

    if (existing) {
      return reply.status(409).send({ error: { code: "EMAIL_EXISTS", message: "Email already registered" } });
    }

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError || !authData.user) {
      return reply.status(400).send({ error: { code: "SIGNUP_FAILED", message: authError?.message || "Signup failed" } });
    }

    await seedPlans();

    const { data: freePlan } = await supabase
      .from("plans")
      .select("id")
      .eq("id", "free")
      .single();

    const { error: userError } = await supabase.from("users").insert({
      id: authData.user.id,
      email,
      plan_id: freePlan?.id || "free",
    });

    if (userError) {
      return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to create user" } });
    }

    const { key, hash, prefix } = generateApiKey();
    await supabase.from("api_keys").insert({
      user_id: authData.user.id,
      key_hash: hash,
      key_prefix: prefix,
      name: "default",
      is_active: true,
    });

    return reply.status(201).send({
      user: { id: authData.user.id, email },
      api_key: key,
    });
  });

  app.post("/auth/login", async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    if (!email || !password) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "email and password required" } });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      return reply.status(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
    }

    const { data: user } = await supabase
      .from("users")
      .select("id, email, plan_id")
      .eq("id", data.user.id)
      .single();

    return reply.send({
      user,
      session: data.session,
    });
  });

  app.post("/auth/logout", async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      await supabase.auth.signOut();
    }
    return reply.send({ success: true });
  });

  app.post("/auth/reset-password", async (req, reply) => {
    const { email } = req.body as { email: string };
    if (!email) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "email required" } });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) {
      return reply.status(400).send({ error: { code: "RESET_FAILED", message: error.message } });
    }

    return reply.send({ success: true });
  });
}
