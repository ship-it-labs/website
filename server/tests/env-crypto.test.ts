import { describe, it, expect } from "vitest";
import {
  parseEnvVars,
  encryptEnvVars,
  decryptEnvVars,
  EnvCryptoError,
} from "../src/utils/env-crypto.js";

const KEY = "test-key-material-for-unit-tests-only";

describe("env parsing", () => {
  it("accepts a plain string map", () => {
    expect(parseEnvVars({ A: "1", DATABASE_URL: "postgres://x" })).toEqual({
      A: "1",
      DATABASE_URL: "postgres://x",
    });
  });

  it("accepts an empty map", () => {
    expect(parseEnvVars({})).toEqual({});
  });

  it("rejects bad names without echoing values", () => {
    expect(() => parseEnvVars({ "has-dash": "x" })).toThrow(EnvCryptoError);
    expect(() => parseEnvVars({ "9lives": "x" })).toThrow(EnvCryptoError);
    expect(() => parseEnvVars({ "": "x" })).toThrow(EnvCryptoError);
  });

  it("rejects non-string values and oversized maps", () => {
    expect(() => parseEnvVars({ A: 42 })).toThrow(EnvCryptoError);
    expect(() => parseEnvVars(null)).toThrow(EnvCryptoError);
    expect(() => parseEnvVars([])).toThrow(EnvCryptoError);
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`V${i}`, "x"])
    );
    expect(() => parseEnvVars(many)).toThrow(EnvCryptoError);
  });

  it("rejects oversized values", () => {
    expect(() => parseEnvVars({ A: "x".repeat(4097) })).toThrow(EnvCryptoError);
  });
});

describe("env encryption", () => {
  it("round-trips through ciphertext", () => {
    const vars = { API_KEY: "secret-123", PORT: "8000" };
    const cipher = encryptEnvVars(vars, KEY);
    expect(cipher).not.toContain("secret-123");
    expect(decryptEnvVars(cipher, KEY)).toEqual(vars);
  });

  it("rejects the wrong key", () => {
    const cipher = encryptEnvVars({ A: "b" }, KEY);
    expect(() => decryptEnvVars(cipher, "another-key")).toThrow(EnvCryptoError);
  });

  it("rejects tampered and malformed payloads", () => {
    expect(() => decryptEnvVars("not-base64!!!", KEY)).toThrow(EnvCryptoError);
    const cipher = encryptEnvVars({ A: "b" }, KEY);
    const tampered = cipher.slice(0, -4) + "AAAA";
    expect(() => decryptEnvVars(tampered, KEY)).toThrow(EnvCryptoError);
  });

  it("produces different ciphertext each time", () => {
    const vars = { A: "b" };
    expect(encryptEnvVars(vars, KEY)).not.toBe(encryptEnvVars(vars, KEY));
  });
});
