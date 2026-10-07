import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
  redact: {
    paths: [
      "req.headers.authorization",
      "token",
      "access_token",
      "refresh_token",
      "recovery_token",
      "apiKey",
      "key_hash",
      "token_hash",
      "password",
      "current_password",
      "new_password",
      // Emails and billing membership ids have leaked into error logs before
      // (signup failures, webhook retries). They are routing metadata, not
      // debugging context, so they are censored at the logger, which covers
      // every route without touching each call site.
      "email",
      "new_email",
      "current_email",
      "membershipId",
      "membership_id",
      "whop_membership_id",
      "promo_code",
      "promoCode",
      "WHOP_SANDBOX_API_KEY",
      "WHOP_LIVE_API_KEY",
      "GITHUB_PRIVATE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      // Secrets added by later batches; keep the list current when new ones
      // appear so a copy-paste in an error log can't leak them.
      "ORCHESTRATOR_SECRET",
      "BUILD_REPORT_TOKEN",
      "WHOP_SANDBOX_WEBHOOK_SECRET",
      "WHOP_PROD_WEBHOOK_SECRET",
      "SANDBOX_WEBHOOK_SECRET",
      "PROD_WEBHOOK_SECRET",
      "x-service-secret",
      "x_service_secret",
      "session_token",
      "accessToken",
      "sessionId",
      "api_key",
      "apiKey",
      "key",
      "webhook_secret",
    ],
    censor: "[REDACTED]",
  },
});
