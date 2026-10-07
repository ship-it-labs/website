import { describe, it, expect } from "vitest";
import {
  filterAuditEntries,
  auditActions,
  filterWebhookEvents,
  subscriptionManageUrl,
  type AuditRow,
  type WebhookRow,
} from "../src/routes/admin.js";

/**
 * Batch 10 admin/observability completion. Pure filter helpers live in the
 * route module so both drivers share them; the suite pins their semantics
 * (including the SQLite 0/1 boolean shape) without booting Fastify.
 */

const auditRows: AuditRow[] = [
  { id: "1", admin_id: "a", action: "env_set", target: "K:production", detail: null, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "2", admin_id: "a", action: "disable", target: "u1", detail: null, created_at: "2026-01-02T00:00:00.000Z" },
  { id: "3", admin_id: "a", action: "env_clear", target: "K:development", detail: null, created_at: "2026-01-03T00:00:00.000Z" },
];

describe("filterAuditEntries", () => {
  it("returns everything for all, empty or missing filters", () => {
    expect(filterAuditEntries(auditRows, "all")).toHaveLength(3);
    expect(filterAuditEntries(auditRows, "")).toHaveLength(3);
    expect(filterAuditEntries(auditRows, undefined)).toHaveLength(3);
  });

  it("narrows to one action for the env-history view", () => {
    expect(filterAuditEntries(auditRows, "env_set").map((e) => e.id)).toEqual(["1"]);
  });

  it("yields nothing for an unknown action rather than everything", () => {
    expect(filterAuditEntries(auditRows, "nope")).toHaveLength(0);
  });
});

describe("auditActions", () => {
  it("lists distinct actions sorted for the filter dropdown", () => {
    expect(auditActions(auditRows)).toEqual(["disable", "env_clear", "env_set"]);
  });

  it("is empty when the log is empty", () => {
    expect(auditActions([])).toEqual([]);
  });
});

const webhookRows: WebhookRow[] = [
  { id: "w1", provider: "whop", event_type: "membership.went_valid", processed: 1, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "w2", provider: "whop", event_type: "membership.went_invalid", processed: 0, created_at: "2026-01-02T00:00:00.000Z" },
  { id: "w3", provider: "whop", event_type: "payment.succeeded", processed: true, created_at: "2026-01-03T00:00:00.000Z" },
  { id: "w4", provider: "whop", event_type: "payment.failed", processed: false, created_at: "2026-01-04T00:00:00.000Z" },
];

describe("filterWebhookEvents", () => {
  it("passes everything through with no filters", () => {
    expect(filterWebhookEvents(webhookRows, undefined, undefined)).toHaveLength(4);
    expect(filterWebhookEvents(webhookRows, "", "all")).toHaveLength(4);
  });

  it("matches event type by case-insensitive substring", () => {
    expect(filterWebhookEvents(webhookRows, "MEMBERSHIP", "all").map((e) => e.id)).toEqual(["w1", "w2"]);
    expect(filterWebhookEvents(webhookRows, "went_valid", "all").map((e) => e.id)).toEqual(["w1"]);
  });

  it("treats SQLite 0/1 like booleans for the processed filter", () => {
    expect(filterWebhookEvents(webhookRows, undefined, "true").map((e) => e.id)).toEqual(["w1", "w3"]);
    expect(filterWebhookEvents(webhookRows, undefined, "false").map((e) => e.id)).toEqual(["w2", "w4"]);
  });

  it("combines both filters", () => {
    expect(filterWebhookEvents(webhookRows, "payment", "false").map((e) => e.id)).toEqual(["w4"]);
  });
});

describe("subscriptionManageUrl", () => {
  it("resolves null without calling Whop when no membership is stored", async () => {
    await expect(subscriptionManageUrl({})).resolves.toBeNull();
    await expect(subscriptionManageUrl({ whop_membership_id: null })).resolves.toBeNull();
  });
});
