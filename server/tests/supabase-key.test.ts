import { describe, it, expect } from "vitest";
import { serviceRoleOf, assertServiceRoleKey } from "../src/db/supabase-key.js";

function fakeJwt(role: string): string {
  const encode = (value: string) =>
    Buffer.from(value, "utf8").toString("base64url");
  return `${encode('{"alg":"HS256"}')}.${encode(JSON.stringify({ role }))}.sig`;
}

describe("supabase key role guard", () => {
  it("reads the service_role claim", () => {
    expect(serviceRoleOf(fakeJwt("service_role"))).toBe("service_role");
  });

  it("reads the anon claim", () => {
    expect(serviceRoleOf(fakeJwt("anon"))).toBe("anon");
  });

  it("returns null for garbage", () => {
    expect(serviceRoleOf("")).toBeNull();
    expect(serviceRoleOf("not-a-jwt")).toBeNull();
    expect(serviceRoleOf("a.b")).toBeNull();
  });

  it("accepts the service role key", () => {
    expect(() => assertServiceRoleKey(fakeJwt("service_role"))).not.toThrow();
  });

  it("rejects the anon key with a message naming the fix", () => {
    expect(() => assertServiceRoleKey(fakeJwt("anon"))).toThrow(/service_role/i);
    expect(() => assertServiceRoleKey("")).toThrow();
  });
});
