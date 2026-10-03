import { FastifyRequest, FastifyReply } from "fastify";
import { supabase } from "../db/index.js";
import { isAdminUser } from "../services/admin.js";

/**
 * Runs after authenticateApiKey and refuses everyone who is not an admin.
 *
 * Registered per-route or per-plugin rather than globally, so a missing
 * registration fails open only where someone forgot the guard — and every
 * admin route lists it explicitly, which is auditable in one grep.
 */
export async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!req.auth) {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Missing credentials" },
    });
    return;
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, email, is_admin")
    .eq("id", req.auth.userId)
    .single();

  if (!user) {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "User not found" },
    });
    return;
  }

  if (!(await isAdminUser(user as { id: string; email: string; is_admin?: boolean | number | null }))) {
    reply.status(403).send({
      error: { code: "FORBIDDEN", message: "Admin access required" },
    });
    return;
  }
}
