import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * The checkout 401 was Whop rejecting our token, but the client held the
 * first-seen key forever: fixing the key in the admin panel (or pasting one
 * with trailing whitespace) never took effect until a restart. These tests pin
 * the rebuild-on-change behavior and the auth-error mapping without network.
 */

vi.mock("@whop/sdk", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@whop/sdk")>();
  class FakeWhopClient {
    static instances: { token: string; environment: unknown }[] = [];
    static createImpl: (args: unknown) => Promise<unknown> = async () => ({
      id: "ch_1",
      purchase_url: "https://whop.test/c/1",
      plan: { id: "plan_x" },
    });
    checkoutConfigurations = {
      create: (args: unknown) => FakeWhopClient.createImpl(args),
    };
    constructor(opts: { token: string; environment: unknown }) {
      FakeWhopClient.instances.push(opts);
    }
  }
  return { ...orig, WhopClient: FakeWhopClient };
});

import { WhopClient } from "@whop/sdk";
import {
  whopClient,
  createCheckout,
  isWhopAuthError,
  WhopConfigError,
} from "../src/services/whop-service.js";

const FakeClient = WhopClient as unknown as {
  instances: { token: string; environment: unknown }[];
  createImpl: (args: unknown) => Promise<unknown>;
};

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  FakeClient.instances.length = 0;
  FakeClient.createImpl = async () => ({
    id: "ch_1",
    purchase_url: "https://whop.test/c/1",
    plan: { id: "plan_x" },
  });
});

function devKey(key: string): void {
  process.env.NODE_ENV = "development";
  delete process.env.WHOP_LIVE_API_KEY;
  process.env.WHOP_SANDBOX_API_KEY = key;
}

describe("whop client lifecycle", () => {
  it("reuses the client while the key is unchanged", () => {
    devKey("stable_sandbox_key_abc");
    expect(whopClient()).toBe(whopClient());
    expect(FakeClient.instances).toHaveLength(1);
  });

  it("rebuilds the client when the key rotates, without a restart", () => {
    devKey("first_sandbox_key_abc");
    const first = whopClient();
    devKey("second_sandbox_key_xyz");
    const second = whopClient();
    expect(second).not.toBe(first);
    expect(FakeClient.instances.map((i) => i.token)).toEqual([
      "first_sandbox_key_abc",
      "second_sandbox_key_xyz",
    ]);
  });

  it("trims whitespace pasted around the key", () => {
    devKey("  padded_sandbox_key_123  \n");
    whopClient();
    expect(FakeClient.instances[0]!.token).toBe("padded_sandbox_key_123");
  });
});

function unauthorizedError(): Error {
  const err = new Error(
    "UnauthorizedError\nStatus code: 401\nBody: {\n  \"error\": {\n    \"type\": \"unauthorized\",\n    \"message\": \"Authentication failed\"\n  }\n}"
  ) as Error & { name: string; statusCode: number; body: unknown };
  err.name = "UnauthorizedError";
  err.statusCode = 401;
  err.body = { error: { type: "unauthorized", message: "Authentication failed" } };
  return err;
}

describe("whop auth failure mapping", () => {
  it("recognizes the SDK 401 shape in all its layers", () => {
    expect(isWhopAuthError(unauthorizedError())).toBe(true);
    expect(isWhopAuthError({ statusCode: 401 })).toBe(true);
    expect(isWhopAuthError({ status: 401 })).toBe(true);
    expect(isWhopAuthError({ name: "UnauthorizedError", message: "nope" })).toBe(true);
    expect(isWhopAuthError({ body: { error: { type: "unauthorized" } } })).toBe(true);
  });

  it("ignores non-auth failures", () => {
    expect(isWhopAuthError(null)).toBe(false);
    expect(isWhopAuthError(undefined)).toBe(false);
    expect(isWhopAuthError(new Error("socket hang up"))).toBe(false);
    expect(isWhopAuthError({ statusCode: 500, message: "boom" })).toBe(false);
  });

  it("names the sandbox key when Whop 401s in development", async () => {
    devKey("revoked_sandbox_key_abc");
    FakeClient.createImpl = async () => {
      throw unauthorizedError();
    };
    const failure = await createCheckout({
      whopPlanId: "plan_x",
      userId: "u1",
      planId: "pro",
    }).catch((err) => err);
    expect(failure).toBeInstanceOf(WhopConfigError);
    expect(String(failure.message)).toMatch(/WHOP_SANDBOX_API_KEY/);
  });

  it("names the live key when Whop 401s in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.WHOP_SANDBOX_API_KEY;
    process.env.WHOP_LIVE_API_KEY = "revoked_live_key_abc123";
    FakeClient.createImpl = async () => {
      throw unauthorizedError();
    };
    const failure = await createCheckout({
      whopPlanId: "plan_x",
      userId: "u1",
      planId: "ultra",
    }).catch((err) => err);
    expect(failure).toBeInstanceOf(WhopConfigError);
    expect(String(failure.message)).toMatch(/WHOP_LIVE_API_KEY/);
  });

  it("lets non-auth errors through untouched", async () => {
    devKey("fine_sandbox_key_abc");
    const network = new Error("socket hang up");
    FakeClient.createImpl = async () => {
      throw network;
    };
    await expect(
      createCheckout({ whopPlanId: "plan_x", userId: "u1", planId: "pro" })
    ).rejects.toBe(network);
  });
});
