import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SqliteClient } from "../src/db/sqlite/client.js";
import {
  OAuthError,
  validateRedirectUri,
  validateClientId,
  verifyPkce,
  createAuthCode,
  exchangeCode,
} from "../src/services/oauth.js";

/**
 * The OAuth ceremony must fail closed at every step: bad redirects never get
 * a redirect response, codes are single-use, PKCE binds the code to the
 * requester, and expiry is enforced on read. Runs against a throwaway
 * database rather than the real one.
 */

let client: SqliteClient;
let dir: string;

const USER = "oauth-user-1";

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-oauth-"));
  client = new SqliteClient({
    file: ":memory:",
    storageRoot: path.join(dir, "storage"),
    publicBaseUrl: "http://127.0.0.1:3000",
  });
  await client.from("users").insert({ id: USER, email: "oauth@example.test", plan_id: "free" });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

const REDIRECT = "http://localhost:4567/callback";

async function approvedCode(overrides: Record<string, unknown> = {}) {
  const { challenge } = pkcePair();
  const { code } = await createAuthCode(client, {
    userId: USER,
    clientId: "opencode",
    redirectUri: REDIRECT,
    state: "state-123",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    ...overrides,
  });
  return code;
}

describe("redirect validation", () => {
  it("accepts loopback http(s) and strips query and fragment", () => {
    expect(validateRedirectUri("http://localhost:4567/callback?x=1#y")).toBe(
      "http://localhost:4567/callback"
    );
    expect(validateRedirectUri("http://127.0.0.1:9/cb")).toBe("http://127.0.0.1:9/cb");
    expect(validateRedirectUri("https://localhost:4567/callback")).toBe("https://localhost:4567/callback");
  });

  it("rejects everything else", () => {
    for (const bad of [
      "https://evil.example.com/callback",
      "http://localhost.evil.example.com/callback",
      "http://127.0.0.1.evil.com/callback",
      "ftp://localhost/callback",
      "http://user:pass@localhost/callback",
      "not-a-url",
      "",
      "http://10.0.0.1/callback",
      "http://[::ffff:127.0.0.1]/callback",
    ]) {
      expect(() => validateRedirectUri(bad), bad).toThrow(OAuthError);
    }
  });

  it("rejects unknown clients", () => {
    expect(() => validateClientId("someone-else")).toThrow(
      expect.objectContaining({ code: "INVALID_CLIENT" })
    );
  });
});

describe("PKCE", () => {
  it("accepts a matching pair", () => {
    const { verifier, challenge } = pkcePair();
    expect(() => verifyPkce(verifier, challenge)).not.toThrow();
  });

  it("rejects mismatches and malformed verifiers", () => {
    const { challenge } = pkcePair();
    expect(() => verifyPkce("wrong-verifier-that-is-long-enough-xxxxxxxx", challenge)).toThrow(
      expect.objectContaining({ code: "INVALID_GRANT" })
    );
    expect(() => verifyPkce("short", challenge)).toThrow(OAuthError);
    expect(() => verifyPkce(undefined, challenge)).toThrow(OAuthError);
  });
});

describe("code issue and exchange", () => {
  it("exchanges a fresh code for a working access token", async () => {
    const { verifier, challenge } = pkcePair();
    const { code } = await createAuthCode(client, {
      userId: USER,
      clientId: "opencode",
      redirectUri: REDIRECT,
      state: "s",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });

    const { userId, accessToken } = await exchangeCode(client, {
      code,
      clientId: "opencode",
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });

    expect(userId).toBe(USER);
    expect(accessToken.startsWith("ox_live_")).toBe(true);

    // The minted key authenticates: same generator, same table, same check
    // the middleware performs.
    const { hashApiKey } = await import("../src/utils/api-key.js");
    const { data } = await client
      .from("api_keys")
      .select("is_active")
      .eq("key_hash", hashApiKey(accessToken))
      .single();
    expect((data as { is_active: boolean | number } | null)?.is_active).toBeTruthy();
  });

  it("rejects replays: a code is single-use", async () => {
    const { verifier, challenge } = pkcePair();
    const { code } = await createAuthCode(client, {
      userId: USER,
      clientId: "opencode",
      redirectUri: REDIRECT,
      state: "s",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });

    await exchangeCode(client, { code, clientId: "opencode", redirectUri: REDIRECT, codeVerifier: verifier });
    await expect(
      exchangeCode(client, { code, clientId: "opencode", redirectUri: REDIRECT, codeVerifier: verifier })
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
  });

  it("rejects expired codes", async () => {
    const { verifier, challenge } = pkcePair();
    const { code } = await createAuthCode(
      client,
      {
        userId: USER,
        clientId: "opencode",
        redirectUri: REDIRECT,
        state: "s",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      },
      Date.now() - 11 * 60_000
    );
    await expect(
      exchangeCode(client, { code, clientId: "opencode", redirectUri: REDIRECT, codeVerifier: verifier })
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
  });

  it("rejects redirect mismatch and unknown codes", async () => {
    const code = await approvedCode();
    const { verifier } = pkcePair();
    await expect(
      exchangeCode(client, { code, clientId: "opencode", redirectUri: "http://localhost:9999/other", codeVerifier: verifier })
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
    await expect(
      exchangeCode(client, { code: "never-issued", clientId: "opencode", redirectUri: REDIRECT, codeVerifier: verifier })
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
  });

  it("rejects non-S256 challenges at approval", async () => {
    const { challenge } = pkcePair();
    await expect(
      createAuthCode(client, {
        userId: USER,
        clientId: "opencode",
        redirectUri: REDIRECT,
        state: "s",
        codeChallenge: challenge,
        codeChallengeMethod: "plain",
      })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
