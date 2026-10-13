import { describe, it, expect } from "vitest";
import { resolveProjectId, scopedProjectId } from "../src/services/project-identity.js";

/**
 * The project id is the primary key and it is chosen by the caller, so this is
 * exactly where one account could take another's project. These cases pin the
 * isolation: an unclaimed slug is used as-is, the owner may update their own
 * slug, and a foreign owner forces a deterministic, per-account id that is
 * stable for that account and different for every other.
 */
describe("project identity resolution", () => {
  it("uses the requested id when the slug is unclaimed", () => {
    expect(resolveProjectId({ requestedId: "mini-app", userId: "A", ownerId: null })).toBe(
      "mini-app"
    );
  });

  it("lets the owner update their own slug", () => {
    expect(resolveProjectId({ requestedId: "mini-app", userId: "A", ownerId: "A" })).toBe(
      "mini-app"
    );
  });

  it("scopes the id when another account owns the slug", () => {
    const resolved = resolveProjectId({ requestedId: "mini-app", userId: "B", ownerId: "A" });
    expect(resolved).not.toBe("mini-app");
    expect(resolved).toBe(scopedProjectId("B", "mini-app"));
  });

  it("is stable for the same account and slug", () => {
    const first = resolveProjectId({ requestedId: "mini-app", userId: "B", ownerId: "A" });
    const second = resolveProjectId({ requestedId: "mini-app", userId: "B", ownerId: "A" });
    expect(first).toBe(second);
  });

  it("gives different accounts different ids for the same slug", () => {
    const b = resolveProjectId({ requestedId: "mini-app", userId: "B", ownerId: "A" });
    const c = resolveProjectId({ requestedId: "mini-app", userId: "C", ownerId: "A" });
    expect(b).not.toBe(c);
  });

  it("keeps the requested slug readable inside the scoped id", () => {
    expect(scopedProjectId("B", "mini-app").startsWith("mini-app--")).toBe(true);
  });
});
