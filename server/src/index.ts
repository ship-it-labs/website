import "dotenv/config";
import path from "path";
import fs from "fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { logger } from "./utils/logger.js";
import { authRoutes } from "./routes/auth.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { buildRoutes } from "./routes/builds.js";
import { projectRoutes } from "./routes/projects.js";
import { runtimeRoutes } from "./routes/runtimes.js";
import { billingRoutes, webhookRoutes } from "./routes/billing.js";
import { websocketRoutes } from "./websockets/index.js";
import { startLeaseExpiryWorker } from "./services/usage-worker.js";
import { seedPlans } from "./services/plan-service.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const FRONTEND_DIST = path.resolve(process.env.FRONTEND_DIST || "../website/dist");

const app = Fastify({
  logger: false,
  bodyLimit: 10 * 1024 * 1024,
  trustProxy: true,
});

await app.register(cors, { origin: true, credentials: true });
await app.register(websocket);
await app.register(multipart, {
  limits: { fileSize: 400 * 1024 * 1024, files: 1 },
});

app.setErrorHandler((err, req, reply) => {
  logger.error({ err, url: req.url }, "Unhandled request error");
  reply.status(err.statusCode || 500).send({
    error: {
      code: err.statusCode && err.statusCode < 500 ? "BAD_REQUEST" : "INTERNAL_ERROR",
      message: err.statusCode && err.statusCode < 500 ? err.message : "Internal server error",
    },
  });
});

await app.register(authRoutes, { prefix: "/api/v1/auth" });
await app.register(apiKeyRoutes, { prefix: "/api/v1/account" });
await app.register(buildRoutes, { prefix: "/api/v1" });
await app.register(projectRoutes, { prefix: "/api/v1" });
await app.register(runtimeRoutes, { prefix: "/api/v1" });
await app.register(billingRoutes, { prefix: "/api/v1" });
await app.register(webhookRoutes, { prefix: "/api/v1" });
await app.register(websocketRoutes);

app.get("/health", async () => ({ status: "ok" }));

if (fs.existsSync(FRONTEND_DIST)) {
  await app.register(fastifyStatic, { root: FRONTEND_DIST, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Not found" },
      });
    }
    return reply.sendFile("index.html");
  });
  logger.info({ path: FRONTEND_DIST }, "Serving frontend build");
} else {
  logger.warn({ path: FRONTEND_DIST }, "Frontend build not found - API only");
}

seedPlans().catch((err) => logger.error({ err }, "Failed to seed plans"));
startLeaseExpiryWorker();

try {
  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, env: process.env.NODE_ENV }, "Control plane started");
} catch (err) {
  logger.error({ err }, "Failed to start control plane");
  process.exit(1);
}
