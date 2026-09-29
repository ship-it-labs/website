import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { hashApiKey, generateApiKey } from "../src/utils/api-key.js";

describe("api key hashing", () => {
  const originalSecret = process.env.API_KEY_HASH_SECRET;

  beforeEach(() => {
    process.env.API_KEY_HASH_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.API_KEY_HASH_SECRET = originalSecret;
  });

  it("generates a prefixed live key", () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^ox_live_[a-f0-9]{48}$/);
  });

  it("never returns the same key twice", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key));
    expect(keys.size).toBe(50);
  });

  it("hashes deterministically", () => {
    expect(hashApiKey("ox_live_abc")).toBe(hashApiKey("ox_live_abc"));
  });

  it("produces different hashes for different keys", () => {
    expect(hashApiKey("ox_live_abc")).not.toBe(hashApiKey("ox_live_abd"));
  });

  it("does not store the plaintext key", () => {
    const { key, hash, prefix } = generateApiKey();
    expect(hash).not.toContain(key);
    expect(hash).toHaveLength(64);
    expect(key.startsWith(prefix)).toBe(true);
  });

  it("salts with the configured secret", () => {
    const withSecretA = hashApiKey("ox_live_abc");

    process.env.API_KEY_HASH_SECRET = "different-secret";
    const withSecretB = hashApiKey("ox_live_abc");

    expect(withSecretA).not.toBe(withSecretB);
  });

  it("uses hmac-sha256 as documented", () => {
    const expected = crypto
      .createHmac("sha256", "test-secret")
      .update("ox_live_abc")
      .digest("hex");

    expect(hashApiKey("ox_live_abc")).toBe(expected);
  });
});
