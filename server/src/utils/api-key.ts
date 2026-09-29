import crypto from "node:crypto";

const DEV_FALLBACK = "dev-secret-change-in-production";

/**
 * The secret is read per call rather than captured at import time, so a
 * misconfigured deployment fails loudly instead of silently hashing keys with a
 * well known development value.
 */
function hashSecret(): string {
  const secret = process.env.API_KEY_HASH_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "API_KEY_HASH_SECRET is required in production. Refusing to hash keys with a fallback."
      );
    }
    return DEV_FALLBACK;
  }

  return secret;
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `ox_live_${crypto.randomBytes(24).toString("hex")}`;
  const hash = hashApiKey(key);
  const prefix = key.slice(0, 12);
  return { key, hash, prefix };
}

export function hashApiKey(key: string): string {
  return crypto.createHmac("sha256", hashSecret()).update(key).digest("hex");
}

export function verifyApiKey(key: string, hash: string): boolean {
  const computed = Buffer.from(hashApiKey(key), "hex");
  const expected = Buffer.from(hash, "hex");

  if (computed.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(computed, expected);
}
