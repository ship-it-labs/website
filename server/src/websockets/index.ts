import { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import { supabase } from "../db/index.js";
import { hashApiKey } from "../utils/api-key.js";
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

async function authenticateSocket(token: string | undefined): Promise<string | null> {
  if (!token) return null;

  const { data } = await supabase
    .from("api_keys")
    .select("user_id, is_active")
    .eq("key_hash", hashApiKey(token))
    .single();

  if (!data || !data.is_active) return null;
  return data.user_id;
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
