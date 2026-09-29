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
      "apiKey",
      "password",
      "WHOP_SANDBOX_API_KEY",
      "WHOP_LIVE_API_KEY",
      "GITHUB_PRIVATE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ],
    censor: "[REDACTED]",
  },
});
