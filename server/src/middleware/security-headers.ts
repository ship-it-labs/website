import { FastifyInstance } from "fastify";

/**
 * Manual security headers, no new dependency. The bundle is a single-page Vite
 * app with no inline scripts, so the policy stays tight: same-origin
 * everything, images and connections open enough for API calls and avatars.
 * Google Fonts is allowlisted (stylesheet + font files) because the UI's
 * serif/sans stack loads from there — blocking it silently fell back to
 * system fonts and the branding "disappeared".
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function securityHeadersHook(app: FastifyInstance): void {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Content-Security-Policy", CSP);
    return;
  });
}
