/**
 * Every address the platform hands out or calls, resolved from the environment.
 *
 * These live in one place because they are the values that change when the
 * platform moves onto a real domain: a hardcoded host in a route is the thing
 * that breaks on launch day.
 *
 * Values are read when they are used rather than at import, so importing a
 * module never fails on configuration. `assertUrlsConfigured` is called once at
 * startup instead, which is where a deployment should be told it is
 * misconfigured.
 */

function clean(value: string): string {
  return value.replace(/\/+$/, "");
}

function read(name: string): string | undefined {
  const value = process.env[name];
  return value ? clean(value) : undefined;
}

function withFallback(name: string, fallback: string): string {
  return read(name) ?? clean(fallback);
}

const port = () => process.env.PORT || "3000";

/**
 * The address a person on the internet uses. Used for signed links and for
 * telling an external build runner where to fetch a project archive.
 */
export function publicBaseUrl(): string {
  return withFallback("PUBLIC_BASE_URL", `http://127.0.0.1:${port()}`);
}

/**
 * How other services in the private network reach this process. Falls back to
 * the public address, which is correct outside containerised development.
 */
export function internalBaseUrl(): string {
  return read("INTERNAL_PUBLIC_BASE_URL") ?? publicBaseUrl();
}

/**
 * Where the browser should be returned to, for example after checkout. Must
 * never be an internal container address.
 */
export function siteUrl(): string {
  return withFallback("SITE_URL", `http://localhost:${port()}`);
}

/** Where the runtime orchestrator listens for the control plane. */
export function orchestratorUrl(): string {
  return withFallback("RUNTIME_ORCHESTRATOR_URL", "http://localhost:3003");
}

/** Shared secret presented to the orchestrator. */
export function orchestratorSecret(): string {
  return process.env.ORCHESTRATOR_SECRET || "";
}

/** Address Whop calls back on, so it must be publicly reachable. */
export function whopWebhookUrl(): string {
  return read("WHOP_WEBHOOK_URL") ?? `${publicBaseUrl()}/api/v1/webhooks/whop`;
}

/** Where a customer lands after checkout. */
export function billingReturnUrl(): string {
  return `${siteUrl()}/dashboard/billing`;
}

/**
 * Origins allowed to call the API with credentials. Defaults to this
 * deployment's own addresses only, which is the correct posture once the
 * platform is on a real domain: `origin: true` would let any site make
 * authenticated requests.
 */
export function allowedOrigins(): string[] {
  const configured = read("ALLOWED_ORIGINS");
  if (configured) {
    return configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  return [...new Set([publicBaseUrl(), siteUrl(), internalBaseUrl()])];
}

/**
 * Addresses that cannot be guessed and must be stated once the platform is
 * deployed. Called at startup so a missing value is a clear boot failure rather
 * than a wrong link handed to a customer later.
 */
export function assertUrlsConfigured(): void {
  if (process.env.NODE_ENV !== "production") return;

  const missing = ["PUBLIC_BASE_URL", "SITE_URL", "RUNTIME_ORCHESTRATOR_URL"].filter(
    (name) => !process.env[name]
  );

  if (missing.length > 0) {
    throw new Error(
      `${missing.join(", ")} must be set when NODE_ENV=production. ` +
        `These are the addresses of this deployment and cannot be guessed.`
    );
  }
}
