import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  snapshotText,
  trimToBudget,
  type AccountSnapshot,
} from "../src/services/agent-context.js";
import { searchDocs } from "../src/services/agent-docs.js";
import type { AgentMessage } from "../src/services/pollinations.js";

function snapshot(): AccountSnapshot {
  return {
    email: "dev@example.test",
    planId: "pro",
    plan: {
      name: "Pro",
      runtimeHoursPerMonth: 250,
      maxSessionHours: 6,
      maxConcurrentRuntimes: 3,
      buildTimeoutSeconds: 300,
      priceCents: 900,
    },
    subscription: {
      status: "active",
      planId: "pro",
      currentPeriodEnd: "2026-11-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    },
    projects: [{ id: "p1", name: "mini-app", language: "node" }],
    recentBuilds: [{ id: "b1abcdef", status: "success", createdAt: "2026-10-10T00:00:00.000Z" }],
    activeRuntimes: [{ id: "r1", status: "running", appUrl: "https://app.example.test" }],
    usage: { runtimeSeconds: 5400, buildCount: 4, periodStart: "2026-10-01", periodEnd: "2026-11-01" },
  };
}

describe("token estimate", () => {
  it("uses four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("account snapshot rendering", () => {
  it("surfaces plan, usage and projects in a compact form", () => {
    const text = snapshotText(snapshot());
    expect(text).toContain("email: dev@example.test");
    expect(text).toContain("Pro");
    expect(text).toContain("250h/month");
    expect(text).toContain("1.5h runtime");
    expect(text).toContain("mini-app");
    expect(text).toContain("success");
  });

  it("degrades to placeholders without a plan or usage", () => {
    const bare: AccountSnapshot = {
      ...snapshot(),
      email: null,
      planId: "free",
      plan: null,
      subscription: null,
      usage: null,
      projects: [],
      recentBuilds: [],
      activeRuntimes: [],
    };
    const text = snapshotText(bare);
    expect(text).toContain("email: unknown");
    expect(text).toContain("plan: free");
    expect(text).toContain("0.0h runtime");
    expect(text).toContain("active runtimes: none");
  });
});

describe("history trimming", () => {
  it("leaves a small conversation untouched", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(trimToBudget(messages, 30_000)).toHaveLength(3);
  });

  it("pins the system message, drops the oldest turns and keeps the newest", () => {
    const system: AgentMessage = { role: "system", cachePrefix: "x".repeat(200), content: "sys" };
    const turns: AgentMessage[] = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "m".repeat(400),
    }));
    const trimmed = trimToBudget([system, ...turns], 1000);

    expect(trimmed[0]?.role).toBe("system");
    expect(trimmed.length).toBeLessThan(turns.length + 1);
    expect(trimmed[trimmed.length - 1]?.content).toBe("m".repeat(400));
    expect(trimmed.length).toBeGreaterThanOrEqual(2);
  });
});

describe("docs search", () => {
  it("finds the pricing section for a pricing question", () => {
    const results = searchDocs("how much do the plans cost and what is the quota");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("plans");
  });

  it("falls back to the overview when nothing matches", () => {
    const results = searchDocs("zzzzz qqqqq");
    expect(results[0]?.id).toBe("overview");
  });

  it("returns the overview for an empty query", () => {
    expect(searchDocs("")[0]?.id).toBe("overview");
  });
});
