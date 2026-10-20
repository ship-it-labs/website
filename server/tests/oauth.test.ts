import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SqliteClient } from "../src/db/sqlite/client.js";
import {
  OAuthError,
  validateMcpRedirect,
  validateClientId,
  verifyPkce,
  createAuthCode,
  exchangeCode,
} from "../src/services/oauth.js";
import { createMcpLoginSession } from "../src/services/mcp-login.js";

/**
 * The OAuth ceremony must fail closed at every step: a redirect that is not
 * the callback this server issued never gets a redirect response, codes are
 * single-use, PKCE binds the code to the requester, and expiry is enforced on
 * read. Runs against a throwaway database rather than the real one.
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

/** A live login session: the only redirect target the server will accept. */
function session() {
  return createMcpLoginSession().session;
}

describe("redirect validation", () => {
  it("accepts the callback it issued for a live session", () => {
    const live = session();
    expect(validateMcpRedirect(live.redirectUri, live.state)).toBe(live.redirectUri);
  });

  it("refuses a redirect that is not a known session", () => {
    const live = session();
    for (const bad of [
      "https://evil.example.com/callback",
      "http://127.0.0.1:3000/mcp/login/callback/not-a-session",
      "not-a-url",
      "",
    ]) {
      expect(() => validateMcpRedirect(bad, live.state), bad).toThrow(OAuthError);
    }
  });

  it("refuses another session's callback: the state does not match", () => {
    const mine = session();
    const theirs = session();
    // The callback itself is legitimate — it belongs to a live session — so
    // the state is what refuses it.
    expect(() => validateMcpRedirect(theirs.redirectUri, mine.state)).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" })
    );
  });

  it("refuses a state that does not match the session", () => {
    const live = session();
    expect(() => validateMcpRedirect(live.redirectUri, "somebody-elses-state")).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" })
    );
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
    const live = session();
    const { code } = await createAuthCode(client, {
      userId: USER,
      clientId: "mcp",
      redirectUri: live.redirectUri,
      state: live.state,
      codeChallenge: live.challenge,
      codeChallengeMethod: "S256",
    });

    const { userId, accessToken } = await exchangeCode(client, {
      code,
      clientId: "mcp",
      redirectUri: live.redirectUri,
      codeVerifier: live.verifier,
    });

    expect(userId).toBe(USER);
    expect(accessToken.startsWith("ox_live_")).toBe(true);

    // The minted key authenticates: same generator, same table, same check
    // the middleware performs.
    const { hashApiKey } = await import("../src/utils/api-key.js");
    const { data } = await client
      .from("api_keys")
      .select("is_active, name")
      .eq("key_hash", hashApiKey(accessToken))
      .single();
    expect((data as { is_active: boolean | number } | null)?.is_active).toBeTruthy();
    expect((data as { name: string } | null)?.name).toBe("MCP (OAuth)");
  });

  it("rejects replays: a code is single-use", async () => {
    const live = session();
    const { code } = await createAuthCode(client, {
      userId: USER,
      clientId: "mcp",
      redirectUri: live.redirectUri,
      state: live.state,
      codeChallenge: live.challenge,
      codeChallengeMethod: "S256",
    });

    await exchangeCode(client, {
      code,
      clientId: "mcp",
      redirectUri: live.redirectUri,
      codeVerifier: live.verifier,
    });
    await expect(
      exchangeCode(client, {
        code,
        clientId: "mcp",
        redirectUri: live.redirectUri,
        codeVerifier: live.verifier,
      })
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
  });

  it("rejects expired codes", async () => {
    const live = session();
    const { code } = await createAuthCode(
      client,
      {
        userId: USER,
        clientId: "mcp",
        redirectUri: live.redirectUri,
        state: live.state,
        codeChallenge: live.challenge,
        codeChallengeMethod: "S256",
      },
      Date.now() - 11 * 60_000
    );
    await expect(
      exchangeCode(client, {
        code,
        clientId: "mcp",
        redirectUri: live.redirectUri,
        codeVerifier: live.verifier,
      })
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
  });

  it("rejects redirect mismatch and unknown codes", async () => {
    const live = session();
    const other = session();
    const { code } = await createAuthCode(client, {
      userId: USER,
      clientId: "mcp",
      redirectUri: live.redirectUri,
      state: live.state,
      codeChallenge: live.challenge,
      codeChallengeMethod: "S256",
    });

    await expect(
      exchangeCode(client, {
        code,
        clientId: "mcp",
        redirectUri: other.redirectUri,
        codeVerifier: live.verifier,
      })
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
    await expect(
      exchangeCode(client, {
        code: "never-issued",
        clientId: "mcp",
        redirectUri: live.redirectUri,
        codeVerifier: live.verifier,
      })
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
  });

  it("rejects non-S256 challenges at approval", async () => {
    const live = session();
    await expect(
      createAuthCode(client, {
        userId: USER,
        clientId: "mcp",
        redirectUri: live.redirectUri,
        state: live.state,
        codeChallenge: live.challenge,
        codeChallengeMethod: "plain",
      })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("names a missing table as unmigrated, not a generic failure", async () => {
    const stubDb = {
      from: () => ({
        insert: async () => ({ error: { code: "42P01", message: 'relation "oauth_codes" does not exist' } }),
      }),
    };
    const live = session();
    await expect(
      createAuthCode(stubDb as never, {
        userId: USER,
        clientId: "mcp",
        redirectUri: live.redirectUri,
        state: live.state,
        codeChallenge: live.challenge,
        codeChallengeMethod: "S256",
      })
    ).rejects.toMatchObject({ code: "SERVER_ERROR", message: expect.stringMatching(/migration/i) });
  });

  it("names an RLS refusal as row-level security", async () => {
    const stubDb = {
      from: () => ({
        insert: async () => ({ error: { code: "42501", message: "new row violates row-level security policy" } }),
      }),
    };
    const live = session();
    await expect(
      createAuthCode(stubDb as never, {
        userId: USER,
        clientId: "mcp",
        redirectUri: live.redirectUri,
        state: live.state,
        codeChallenge: live.challenge,
        codeChallengeMethod: "S256",
      })
    ).rejects.toMatchObject({ code: "SERVER_ERROR", message: expect.stringMatching(/row-level security/i) });
  });
});
