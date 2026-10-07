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
    ],
    censor: "[REDACTED]",
  },
});
