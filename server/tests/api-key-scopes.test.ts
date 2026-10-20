import { describe, it, expect } from "vitest";
import {
  ALL_SCOPES,
  hasScope,
  parseScopes,
  serializeScopes,
} from "../src/services/api-key-scopes.js";
import { requireScope } from "../src/middleware/auth.js";

/**
 * A key is a credential pasted into a tool, so it must be able to do less
 * than the account that made it. These tests pin the two halves of that: the
 * scope arithmetic, and the guard that refuses a key that lacks one.
 */

describe("scope storage", () => {
  it("round trips a list of scopes", () => {
    const scopes = ["projects:read", "runtimes:write"];
    expect(parseScopes(serializeScopes(scopes))).toEqual(scopes);
  });

  it("treats an unrecorded scope list as every permission", () => {
    // The keys minted by the OAuth flows before scopes existed must keep
    // working untouched.
    expect(parseScopes(null)).toBeNull();
    expect(parseScopes("")).toBeNull();
    expect(serializeScopes(null)).toBeNull();
  });

  it("drops scopes it does not know", () => {
    expect(parseScopes("projects:read,not-a-scope")).toEqual(["projects:read"]);
  });

  it("stores nothing for a key with every scope", () => {
    expect(serializeScopes([...ALL_SCOPES])).toBeNull();
  });
});

describe("scope checks", () => {
  it("lets an unscoped key through", () => {
    expect(hasScope(null, "runtimes:write")).toBe(true);
  });

  it("refuses a scope the key does not hold", () => {
    expect(hasScope(["projects:read"], "runtimes:write")).toBe(false);
    expect(hasScope(["projects:read"], "projects:read")).toBe(true);
  });
});

describe("the scope guard", () => {
  function fakeReply() {
    const state: { code?: number; payload?: unknown } = {};
    const reply = {
      status(code: number) {
        state.code = code;
        return reply;
      },
      send(payload: unknown) {
        state.payload = payload;
        return reply;
      },
    };
    return { reply, state };
  }

  it("refuses an API key without the permission", async () => {
    const { reply, state } = fakeReply();
    await requireScope("runtimes:write")(
      { auth: { isApiKey: true, scopes: ["projects:read"] } } as never,
      reply as never
    );
    expect(state.code).toBe(403);
    expect((state.payload as { error: { code: string } }).error.code).toBe(
      "INSUFFICIENT_SCOPE"
    );
  });

  it("lets a scoped key through when it holds the permission", async () => {
    const { reply, state } = fakeReply();
    await requireScope("runtimes:write")(
      { auth: { isApiKey: true, scopes: ["runtimes:write"] } } as never,
      reply as never
    );
    expect(state.code).toBeUndefined();
  });

  it("never limits the person signed in", async () => {
    const { reply, state } = fakeReply();
    await requireScope("runtimes:write")(
      { auth: { isApiKey: false, scopes: [] } } as never,
      reply as never
    );
    expect(state.code).toBeUndefined();
  });
});
