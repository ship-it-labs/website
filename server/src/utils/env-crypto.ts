import crypto from "node:crypto";

/**
 * Project runtime environments. Values are secrets far more often than not
 * (API keys, database URLs), so they are encrypted before storage and only
 * decrypted on the single path that hands them to a runtime. Nothing else —
 * no list endpoint, no log line, no webhook — ever sees plaintext.
 */

export const MAX_ENV_VARS = 50;
const MAX_NAME_LENGTH = 128;
const MAX_VALUE_LENGTH = 4096;
const MAX_TOTAL_LENGTH = 8192;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

export class EnvCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvCryptoError";
  }
}

/** Validates a caller-supplied env map without ever logging its values. */
export function parseEnvVars(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EnvCryptoError("env must be an object of NAME to value");
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) {
    throw new EnvCryptoError(`env carries too many variables (max ${MAX_ENV_VARS})`);
  }

  const vars: Record<string, string> = {};
  let total = 0;
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name) || name.length > MAX_NAME_LENGTH) {
      throw new EnvCryptoError(`Invalid environment variable name: ${name.slice(0, 32)}`);
    }
    if (typeof value !== "string") {
      throw new EnvCryptoError(`Environment variable ${name} must be a string`);
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new EnvCryptoError(`Environment variable ${name} is too long`);
    }
    total += name.length + value.length;
    if (total > MAX_TOTAL_LENGTH) {
      throw new EnvCryptoError("env is too large in total");
    }
    vars[name] = value;
  }
  return vars;
}

function keyFromMaterial(material: string): Buffer {
  return crypto.createHash("sha256").update(material, "utf8").digest();
}

/** Reads the encryption key. Missing means the admin has not configured env storage. */
export function projectEnvKey(): string {
  const key = process.env.PROJECT_ENV_KEY?.trim();
  if (!key) {
    throw new EnvConfigError(
      "PROJECT_ENV_KEY is not set. Set it to a long random string to enable project environments."
    );
  }
  return key;
}

/** AES-256-GCM envelope: base64 JSON {iv, data, tag}. */
export function encryptEnvVars(vars: Record<string, string>, keyMaterial: string): string {
  const key = keyFromMaterial(keyMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(vars);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = {
    iv: iv.toString("base64"),
    data: data.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Inverse of encryptEnvVars. Wrong key or tampered payload throws, never partial data. */
export function decryptEnvVars(payload: string, keyMaterial: string): Record<string, string> {
  let envelope: { iv?: string; data?: string; tag?: string };
  try {
    envelope = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    throw new EnvCryptoError("Stored environment is not valid");
  }
  if (!envelope?.iv || !envelope?.data || !envelope?.tag) {
    throw new EnvCryptoError("Stored environment is not valid");
  }

  try {
    const key = keyFromMaterial(keyMaterial);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    return parseEnvVars(parsed);
  } catch (err) {
    if (err instanceof EnvCryptoError) throw err;
    throw new EnvCryptoError("Could not decrypt the stored environment (wrong key or tampered data)");
  }
}
