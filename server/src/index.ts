import "dotenv/config";
import crypto from "node:crypto";
import path from "path";
import fs from "fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { logger } from "./utils/logger.js";
import { usingSqlite } from "./db/index.js";
import { authRoutes } from "./routes/auth.js";
import { apiKeyRoutes, accountRoutes } from "./routes/api-keys.js";
import { accountSettingsRoutes } from "./routes/account.js";
import { allowedOrigins,
  assertUrlsConfigured,
  publicBaseUrl,
  siteUrl,
  whopWebhookUrl,
  billingReturnUrl,
} from "./config/urls.js";
import { startBuildPoller } from "./services/runtime-build.js";

// Fail here rather than later, when a customer is handed a link to nowhere.
assertUrlsConfigured();
import { buildRoutes } from "./routes/builds.js";
import { buildReportRoutes } from "./routes/build-reports.js";
import { adminRoutes } from "./routes/admin.js";
import { statusRoutes } from "./routes/status.js";
import { projectRoutes } from "./routes/projects.js";
import { runtimeRoutes } from "./routes/runtimes.js";
import { billingRoutes, webhookRoutes } from "./routes/billing.js";
import { websocketRoutes } from "./websockets/index.js";
import { startLeaseExpiryWorker } from "./services/usage-worker.js";
import { seedPlans } from "./services/plan-service.js";
import { probeSessionWrites } from "./services/sessions.js";
import { loadEnvOverrides } from "./services/runtime-env.js";
import { unconfiguredPlans } from "./services/whop-service.js";
import { requestIdHook, errorEnvelope } from "./middleware/request-id.js";
import { securityHeadersHook } from "./middleware/security-headers.js";
import { maintenanceHook } from "./middleware/maintenance.js";
import { appVersion, uptimeSeconds } from "./config/meta.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const FRONTEND_DIST = path.resolve(process.env.FRONTEND_DIST || "../website/dist");

const app = Fastify({
  logger: false,
  bodyLimit: 10 * 1024 * 1024,
  trustProxy: true,
});

// A crash log is the cheapest outage diagnosis there is. Without these the
// process dies silently and the deploy log shows nothing but an exit code.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});

// Only this deployment's own origins may call the API with credentials.
// `origin: true` reflected whatever asked, which would let any site on the
// internet make authenticated requests once the platform is on a real domain.
await app.register(cors, {
  origin: allowedOrigins(),
  credentials: true,
});
await app.register(websocket);
await app.register(multipart, {
  // Project archives are the only large upload: 400MB fits a node_modules-heavy
  // zip while the single-file cap stops multi-file smuggling past the check.
  limits: { fileSize: 400 * 1024 * 1024, files: 1 },
});

requestIdHook(app);
securityHeadersHook(app);
// Pauses new runtime starts while maintenance_mode is on. Registered before the
// routes so the check runs ahead of authentication with its own 503.
app.addHook("preHandler", maintenanceHook);

// Whop signs the exact bytes it sent. Fastify must hand the webhook route the
// raw body, because re-serialising parsed JSON produces different bytes and the
// signature check would fail for every legitimate event.
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body, done) => {
    if (req.url?.startsWith("/api/v1/webhooks/whop")) {
      try {
        const parsed = body ? JSON.parse(body as string) : {};
        (req as unknown as { rawBody: string }).rawBody = body as string;
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
      return;
    }

    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  }
);

app.setErrorHandler((err, req, reply) => {
  logger.error({ err, url: req.url, requestId: req.requestId }, "Unhandled request error");
  reply.status(err.statusCode || 500).send(
    errorEnvelope(
      req,
      err.statusCode && err.statusCode < 500 ? "BAD_REQUEST" : "INTERNAL_ERROR",
      err.statusCode && err.statusCode < 500 ? err.message : "Internal server error"
    )
  );
});

// authRoutes defines its own /auth/* paths, so it mounts at the version root to
// avoid producing /api/v1/auth/auth/*.
await app.register(authRoutes, { prefix: "/api/v1" });
await app.register(accountRoutes, { prefix: "/api/v1" });
await app.register(accountSettingsRoutes, { prefix: "/api/v1" });
await app.register(apiKeyRoutes, { prefix: "/api/v1/account" });
await app.register(buildRoutes, { prefix: "/api/v1" });
// Separate from buildRoutes: this one is called by GitHub Actions with a shared
// secret, not by a user with an API key, so it must not inherit that guard.
await app.register(buildReportRoutes, { prefix: "/api/v1" });
// Admin routes guard themselves twice: authenticateApiKey, then requireAdmin.
// The pair is registered once for the whole plugin so no route can forget it.
await app.register(adminRoutes, { prefix: "/api/v1" });
// Public and deliberately coarse: the status page renders from here, and a
// status endpoint that requires a login is a contradiction.
await app.register(statusRoutes, { prefix: "/api/v1" });
await app.register(projectRoutes, { prefix: "/api/v1" });
await app.register(runtimeRoutes, { prefix: "/api/v1" });
await app.register(billingRoutes, { prefix: "/api/v1" });
await app.register(webhookRoutes, { prefix: "/api/v1" });
await app.register(websocketRoutes);

app.get("/health", async () => ({
  status: "ok",
  version: appVersion(),
  uptime_seconds: uptimeSeconds(),
  driver: usingSqlite ? "sqlite" : "supabase",
}));

/**
 * Serves objects written by the local SQLite storage driver, so the build
 * workflow can download an uploaded project exactly as it would from Supabase
 * Storage. The signature and expiry are checked before anything is read.
 */
if (usingSqlite) {
  app.get<{ Params: { "*": string }; Querystring: { expires?: string; token?: string } }>(
    "/local-storage/*",
    async (req, reply) => {
      const relative = req.params["*"] ?? "";
      const target = path.resolve(
        process.env.LOCAL_STORAGE_ROOT || "./.data/storage",
        relative
      );
      const storageRoot = path.resolve(
        process.env.LOCAL_STORAGE_ROOT || "./.data/storage"
      );

      if (!target.startsWith(storageRoot)) {
        return reply.status(400).send({ error: { code: "BAD_PATH", message: "Invalid object path" } });
      }

      const expires = Number(req.query.expires);
      if (!Number.isFinite(expires) || expires * 1000 < Date.now()) {
        return reply.status(403).send({ error: { code: "URL_EXPIRED", message: "Link expired" } });
      }

      const expected = crypto
        .createHmac("sha256", process.env.API_KEY_HASH_SECRET ?? "dev")
        .update(`${relative}:${expires}`)
        .digest("hex")
        .slice(0, 32);

      if (req.query.token !== expected) {
        return reply.status(403).send({ error: { code: "BAD_SIGNATURE", message: "Invalid token" } });
      }

      if (!fs.existsSync(target)) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Object not found" } });
      }

      reply.header("Content-Type", "application/zip");
      return reply.send(fs.createReadStream(target));
    }
  );
}

if (fs.existsSync(FRONTEND_DIST)) {
  await app.register(fastifyStatic, {
    root: FRONTEND_DIST,
    prefix: "/",
    // Hashed Vite assets (assets/index-AbC123.js) are content-addressed: safe
    // to cache for a year. index.html is never cached — it is the pointer to
    // the current hashes, and caching it serves a stale bundle after deploy.
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  });
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

// Validates the database configuration on the real boot values before
// serving: a wrong Supabase key boots fine and then fails every write with
// row level security errors, which once broke every login with no trace.
import { assertSupabaseConfig } from "./db/index.js";
assertSupabaseConfig();

// Proves login sessions can actually be recorded before serving traffic. A
// deployment whose session writes are blocked (forced RLS, wrong key) would
// otherwise hand out tokens that 401 on next use; failing here names the
// cause at boot instead. Skipped on SQLite, which has no row level security.
if (!usingSqlite) {
  try {
    await probeSessionWrites();
  } catch (err) {
    logger.error({ err }, "Session write probe failed; refusing to boot with broken logins");
    process.exit(1);
  }
}

// DB-managed configuration lands in process.env before anything serves, so the
// first request already sees admin-set values. Refreshes every minute after
// that: rotating a secret is an admin click, and the new value flows in
// without a restart (every reader resolves per call).
await loadEnvOverrides();
setInterval(() => {
  loadEnvOverrides().catch((err) => logger.error({ err }, "Failed to refresh configuration"));
}, 60_000);

// Visible at boot, not discovered at checkout: every tier without a Whop plan
// is a 502 waiting for its first customer.
const missingPlans = unconfiguredPlans();
if (missingPlans.length > 0) {
  logger.warn(
    { plans: missingPlans },
    "Paid tiers have no Whop plan configured; checkout will refuse them until the plan ids are set"
  );
}

startLeaseExpiryWorker();
// Collects the outcome of builds running inside the platform's own runtime, so
// their status and logs reach the dashboard.
startBuildPoller();

try {
  await app.listen({ port: PORT, host: HOST });
  logger.info(
    {
      port: PORT,
      env: process.env.NODE_ENV,
      publicUrl: publicBaseUrl(),
      siteUrl: siteUrl(),
    },
    "Control plane started"
  );

  // Logged at startup because both addresses have to be pasted into a dashboard
  // somewhere, and finding them by reading the source is a waste of an outage.
  logger.info(
    { webhookUrl: whopWebhookUrl(), billingReturnUrl: billingReturnUrl() },
    "Billing endpoints to configure in Whop"
  );
} catch (err) {
  logger.error({ err }, "Failed to start control plane");
  process.exit(1);
}

// Graceful shutdown: stop accepting connections, let in-flight requests drain,
// then exit — which also stops the lease-expiry worker, the build poller and
// the config refresher above (all bare intervals owned by other batches' files,
// so they cannot be cleared individually from here; exiting is their stop).
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down control plane");
  try {
    await app.close();
  } catch (err) {
    logger.error({ err }, "Error while closing the server");
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
