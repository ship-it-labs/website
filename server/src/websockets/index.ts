import { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import { supabase } from "../db/index.js";
import { hashApiKey } from "../utils/api-key.js";
import { hasSessionRow } from "../services/sessions.js";
import { logger } from "../utils/logger.js";

interface Client {
  userId: string;
  socket: WebSocket;
  subscriptions: Set<string>;
}

const clients = new Map<string, Set<Client>>();

export function broadcastToUser(userId: string, type: string, payload: unknown): void {
  const userClients = clients.get(userId);
  if (!userClients) return;

  const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const client of userClients) {
    if (client.socket.readyState === 1) {
      client.socket.send(message);
    }
  }
}

function isApiKey(token: string): boolean {
  return token.startsWith("ox_live_") || token.startsWith("ox_test_");
}

/**
 * Mirrors middleware/auth.ts so the socket accepts exactly what HTTP accepts:
 * a live API key, or a session token from login. Session tokens resolve the
 * same way — the local driver's opaque token first, then the Supabase Auth
 * API — and must still be on record, so signing out everywhere closes the
 * socket's credential too. Disabled accounts are refused here as well: without
 * that check a ban would stop API calls but leave a connected socket humming.
 */
async function authenticateSocket(token: string | undefined): Promise<string | null> {
  if (!token) return null;

  let userId: string | null = null;

  if (isApiKey(token)) {
    const { data } = await supabase
      .from("api_keys")
      .select("user_id, is_active, expires_at")
      .eq("key_hash", hashApiKey(token))
      .single();

    if (!data?.is_active) return null;
    if (data.expires_at && new Date(data.expires_at as string).getTime() <= Date.now()) {
      return null;
    }
    userId = data.user_id as string;
  } else {
    const local = supabase as { getUserIdForToken?: (token: string) => string | null };
    const localUserId = local.getUserIdForToken?.(token) ?? null;
    if (localUserId) {
      userId = localUserId;
    } else {
      const auth = supabase.auth as unknown as {
        getUser?: (token: string) => Promise<{ data: { user: { id: string } | null } }>;
      };
      if (typeof auth.getUser !== "function") return null;
      try {
        const { data } = await auth.getUser(token);
        userId = data?.user?.id ?? null;
      } catch {
        return null;
      }
    }

    if (!userId) return null;
    if (!(await hasSessionRow(userId, token))) return null;
  }

  if (!userId) return null;

  const { data: user } = await supabase
    .from("users")
    .select("id, is_active")
    .eq("id", userId)
    .single();

  if (!user) return null;
  if (user.is_active === false || user.is_active === 0) return null;
  return user.id as string;
}

export async function websocketRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const token = (req.query as { token?: string | string[] }).token;
    const rawToken = Array.isArray(token) ? token[0] : token;

    authenticateSocket(rawToken)
      .then((userId) => {
        if (!userId) {
          socket.close(4001, "Unauthorized");
          return;
        }

        const client: Client = { userId, socket, subscriptions: new Set() };
        if (!clients.has(userId)) {
          clients.set(userId, new Set());
        }
        clients.get(userId)!.add(client);

        logger.info({ userId }, "WebSocket client connected");

        socket.on("message", async (raw: Buffer) => {
          try {
            const msg = JSON.parse(raw.toString());

            if (msg.type === "subscribe" && typeof msg.resourceId === "string") {
              client.subscriptions.add(msg.resourceId);
              socket.send(JSON.stringify({ type: "subscribed", payload: { resourceId: msg.resourceId } }));
              return;
            }

            if (msg.type === "unsubscribe" && typeof msg.resourceId === "string") {
              client.subscriptions.delete(msg.resourceId);
              return;
            }

            if (msg.type === "ping") {
              socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            }
          } catch {
            socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid message" } }));
          }
        });

        socket.on("close", () => {
          clients.get(userId)?.delete(client);
          logger.info({ userId }, "WebSocket client disconnected");
        });
      })
      .catch((err) => {
        logger.error({ err }, "WebSocket auth failed");
        socket.close(4001, "Unauthorized");
      });
  });
}
