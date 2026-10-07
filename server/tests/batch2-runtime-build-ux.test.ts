import { describe, it, expect } from "vitest";
import { notFound, attachProjectNames } from "../src/routes/runtimes.js";
import { OrchestratorError } from "../src/routes/runtimes.js";
import { shouldRetryOrchestratorError } from "../src/services/orchestrator-client.js";
import {
  isTerminalBuildStatus,
  buildDurationSeconds,
  filterBuildsByStatus,
} from "../src/services/build-service.js";
import { isStoppingSoon, sessionProgress } from "../src/services/usage-worker.js";

/**
 * Batch 2 (runtime + build UX) pure-logic coverage: 404 shapes, project-name
 * joins, the single 502 retry predicate, build duration/filter helpers, and
 * the lease helpers behind the "stopping soon" banner and progress bar.
 */

describe("consistent 404 shapes", () => {
  it("uses the shared NOT_FOUND code", () => {
    expect(notFound("Runtime not found")).toEqual({
      error: { code: "NOT_FOUND", message: "Runtime not found" },
    });
  });
});

describe("project names on runtime rows", () => {
  it("attaches names and nulls unknown projects", () => {
    const rows = attachProjectNames(
      [{ project_id: "p1" }, { project_id: "gone" }, {}],
      [{ id: "p1", name: "Shop" }]
    );
    expect(rows[0].project_name).toBe("Shop");
    expect(rows[1].project_name).toBeNull();
    expect(rows[2].project_name).toBeNull();
  });

  it("leaves the list order and rows intact", () => {
    const rows = attachProjectNames([{ project_id: "p1", id: "r1" }], [
      { id: "p1", name: "Shop" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "r1", project_name: "Shop" });
  });
});

describe("single 502 retry predicate", () => {
  it("retries only unreachable-orchestrator failures", () => {
    expect(shouldRetryOrchestratorError(new OrchestratorError("ORCHESTRATOR_UNREACHABLE", "down"))).toBe(
      true
    );
    expect(shouldRetryOrchestratorError(new OrchestratorError("RUNTIME_NOT_FOUND", "gone"))).toBe(
      false
    );
    expect(shouldRetryOrchestratorError(new OrchestratorError("ORCHESTRATOR_ERROR", "500"))).toBe(
      false
    );
    expect(shouldRetryOrchestratorError(new Error("boom"))).toBe(false);
  });
});

describe("build status helpers", () => {
  it("treats only finished states as terminal", () => {
    expect(isTerminalBuildStatus("success")).toBe(true);
    expect(isTerminalBuildStatus("failure")).toBe(true);
    expect(isTerminalBuildStatus("timeout")).toBe(true);
    expect(isTerminalBuildStatus("pending")).toBe(false);
    expect(isTerminalBuildStatus("running")).toBe(false);
  });

  it("filters by status and passes all through", () => {
    const builds = [{ status: "running" }, { status: "success" }];
    expect(filterBuildsByStatus(builds, "running")).toHaveLength(1);
    expect(filterBuildsByStatus(builds, "all")).toHaveLength(2);
    expect(filterBuildsByStatus(builds, "")).toHaveLength(2);
    expect(filterBuildsByStatus(builds, "failure")).toHaveLength(0);
  });

  it("measures finished and running durations", () => {
    const finished = buildDurationSeconds(
      { started_at: "2026-10-07T00:00:00.000Z", completed_at: "2026-10-07T00:01:30.000Z" },
      Date.parse("2026-10-07T00:05:00.000Z")
    );
    expect(finished).toBe(90);

    const running = buildDurationSeconds(
      { started_at: "2026-10-07T00:00:00.000Z", completed_at: null },
      Date.parse("2026-10-07T00:00:10.000Z")
    );
    expect(running).toBe(10);
  });

  it("returns null when the build never started", () => {
    expect(buildDurationSeconds({ started_at: null }, Date.now())).toBeNull();
    expect(buildDurationSeconds({}, Date.now())).toBeNull();
  });
});

describe("stopping-soon and session progress", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");

  it("warns inside the 10-minute window", () => {
    expect(isStoppingSoon(new Date(now + 5 * 60_000).toISOString(), "running", now)).toBe(true);
    expect(isStoppingSoon(new Date(now + 60 * 60_000).toISOString(), "running", now)).toBe(false);
    expect(isStoppingSoon(new Date(now - 1000).toISOString(), "running", now)).toBe(false);
  });

  it("always warns while stopping", () => {
    expect(isStoppingSoon(new Date(now + 60 * 60_000).toISOString(), "stopping", now)).toBe(true);
  });

  it("reports half the session consumed at the midpoint", () => {
    const progress = sessionProgress(
      new Date(now - 5400_000).toISOString(),
      new Date(now + 5400_000).toISOString(),
      now
    );
    expect(progress).toBeCloseTo(0.5);
  });

  it("clamps and nulls unknowable windows", () => {
    expect(sessionProgress(new Date(now + 1000).toISOString(), new Date(now + 5000).toISOString(), now)).toBe(0);
    expect(sessionProgress(null, new Date(now + 5000).toISOString(), now)).toBeNull();
    expect(sessionProgress("not a date", new Date(now + 5000).toISOString(), now)).toBeNull();
  });
});
