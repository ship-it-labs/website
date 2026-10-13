import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import { SqliteClient } from "../src/db/sqlite/client.js";
import {
  creditsFromTokens,
  getEntitlement,
  limitsForPlan,
  periodStartDate,
  platformUsage,
  recordAiUsage,
  usageThisPeriod,
} from "../src/services/ai-credits.js";

/**
 * The credit gate is the difference between a paid feature and an open piggy
 * bank, so the rules are pinned here: free is barred, a paid plan starts with a
 * full allowance, usage decrements it, exhaustion bars the next turn, and an
 * admin is never barred. The SQLite stand-in is used instead of Supabase so the
 * schema (including agent_usage) is exercised for real.
 */

let db: SqliteClient;

beforeEach(async () => {
  db = new SqliteClient({
    file: ":memory:",
    storageRoot: os.tmpdir(),
    publicBaseUrl: "http://127.0.0.1:3000",
  });
  await db.from("users").insert({ id: "u-free", email: "free@example.test", plan_id: "free" });
  await db.from("users").insert({ id: "u-pro", email: "pro@example.test", plan_id: "pro" });
  await db.from("users").insert({ id: "u-admin", email: "admin@example.test", plan_id: "free", is_admin: 1 });
});

afterEach(() => {
  db.close();
});

describe("credit maths", () => {
  it("maps tokens to credits, rounding up", () => {
    expect(creditsFromTokens(0)).toBe(0);
    expect(creditsFromTokens(1)).toBe(1);
    expect(creditsFromTokens(10_000)).toBe(1);
    expect(creditsFromTokens(10_001)).toBe(2);
  });

  it("grants the configured per-tier allowance and bars unknown plans", () => {
    expect(limitsForPlan("free").credits).toBe(0);
    expect(limitsForPlan("pro").credits).toBe(50);
    expect(limitsForPlan("ultra").credits).toBeGreaterThan(limitsForPlan("pro").credits);
    expect(limitsForPlan("mystery").credits).toBe(0);
  });

  it("uses a day-granular period key", () => {
    expect(periodStartDate(new Date("2026-10-13T09:12:00Z"))).toBe("2026-10-13");
  });
});

describe("entitlement gate", () => {
  it("bars a free account with no allowance", async () => {
    const ent = await getEntitlement(db, "u-free", "free", false);
    expect(ent.allowed).toBe(false);
    expect(ent.reason).toBe("free");
    expect(ent.remainingCredits).toBe(0);
  });

  it("lets a pro account start with the full allowance", async () => {
    const ent = await getEntitlement(db, "u-pro", "pro", false);
    expect(ent.allowed).toBe(true);
    expect(ent.reason).toBe("ok");
    expect(ent.remainingCredits).toBe(50);
  });

  it("never bars or meters an admin", async () => {
    const ent = await getEntitlement(db, "u-admin", "free", true);
    expect(ent.allowed).toBe(true);
    expect(ent.unlimited).toBe(true);
  });
});

describe("metering", () => {
  it("decrements credits as tokens are spent", async () => {
    await recordAiUsage(db, "u-pro", {
      inputTokens: 8_000,
      outputTokens: 2_000,
      cachedTokens: 0,
      cacheHit: false,
    });
    const usage = await usageThisPeriod(db, "u-pro");
    expect(usage.inputTokens).toBe(8_000);
    expect(usage.outputTokens).toBe(2_000);

    const ent = await getEntitlement(db, "u-pro", "pro", false);
    expect(ent.usedCredits).toBe(1);
    expect(ent.remainingCredits).toBe(49);
    expect(ent.allowed).toBe(true);
  });

  it("accumulates across turns on the same monthly row", async () => {
    for (let i = 0; i < 3; i++) {
      await recordAiUsage(db, "u-pro", {
        inputTokens: 10_000,
        outputTokens: 0,
        cachedTokens: 0,
        cacheHit: false,
      });
    }
    const ent = await getEntitlement(db, "u-pro", "pro", false);
    expect(ent.usedCredits).toBe(3);
    expect(ent.remainingCredits).toBe(47);
  });

  it("counts cache hits without charging tokens", async () => {
    await recordAiUsage(db, "u-pro", {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheHit: true,
    });
    const ent = await getEntitlement(db, "u-pro", "pro", false);
    expect(ent.usedCredits).toBe(0);
    const totals = await platformUsage(db);
    expect(totals.cacheHits).toBe(1);
    expect(totals.requests).toBe(1);
  });

  it("exhausts the allowance and bars the next turn", async () => {
    await recordAiUsage(db, "u-pro", {
      inputTokens: 500_000,
      outputTokens: 100_000,
      cachedTokens: 0,
      cacheHit: false,
    });
    const ent = await getEntitlement(db, "u-pro", "pro", false);
    expect(ent.usedCredits).toBe(60);
    expect(ent.remainingCredits).toBe(0);
    expect(ent.allowed).toBe(false);
    expect(ent.reason).toBe("exhausted");
  });

  it("sums platform usage across accounts", async () => {
    await recordAiUsage(db, "u-pro", {
      inputTokens: 10_000,
      outputTokens: 0,
      cachedTokens: 0,
      cacheHit: false,
    });
    await recordAiUsage(db, "u-free", {
      inputTokens: 20_000,
      outputTokens: 0,
      cachedTokens: 5_000,
      cacheHit: false,
    });
    const totals = await platformUsage(db);
    expect(totals.users).toBe(2);
    expect(totals.requests).toBe(2);
    expect(totals.credits).toBe(3);
    expect(totals.cachedTokens).toBe(5_000);
  });
});
