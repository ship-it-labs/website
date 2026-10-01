import { describe, it, expect } from "vitest";
import {
  isTransientDispatchFailure,
  OVER_CAPACITY_MESSAGE,
  GitHubDispatchError,
} from "../src/services/build-service.js";

/**
 * The dispatcher turns a GitHub refusal into either the shared busy message or
 * GitHub's own wording. Getting this wrong in either direction matters: a
 * permission fault hidden behind "try again later" sends nobody to fix the
 * token, and a rate limit shown as a raw 403 looks like a broken integration.
 */

const LIFETIME_REJECTION =
  "The 'ship-it-labs' organization forbids access via fine-grained personal access tokens " +
  "if the token's lifetime is greater than 366 days.";

describe("transient dispatch failures", () => {
  it.each([
    ["a conflicting run", 409, "A build is already in progress for this ref"],
    ["a rate limit", 429, "API rate limit exceeded"],
    ["a secondary rate limit", 403, "You have exceeded a secondary rate limit"],
    ["abuse detection", 403, "You have triggered an abuse detection mechanism"],
    ["an unavailable service", 503, "Service unavailable"],
  ])("treats %s as temporary", (_label, status, detail) => {
    expect(isTransientDispatchFailure(status as number, detail as string)).toBe(true);
  });

  it.each([
    ["a token the organisation refuses", 403, LIFETIME_REJECTION],
    ["bad credentials", 401, "Bad credentials"],
    ["a missing workflow", 404, "Not Found"],
    ["a plain permission failure", 403, "Resource not accessible by integration"],
  ])("keeps %s visible, since a retry cannot fix it", (_label, status, detail) => {
    expect(isTransientDispatchFailure(status as number, detail as string)).toBe(false);
  });
});

describe("build dispatch error", () => {
  it("carries the shared busy wording for a transient refusal", () => {
    const err = new GitHubDispatchError(429, OVER_CAPACITY_MESSAGE, true);

    expect(err.transient).toBe(true);
    expect(err.explanation).toBe(OVER_CAPACITY_MESSAGE);
  });

  it("defaults to non-transient so a configuration fault is never shown as busy", () => {
    const err = new GitHubDispatchError(403, LIFETIME_REJECTION);

    expect(err.transient).toBe(false);
    expect(err.explanation).toBe(LIFETIME_REJECTION);
  });

  it("says the same thing as the runtime capacity message", () => {
    // One phrase for "busy" across builds and runtimes, so the product speaks
    // with one voice.
    expect(OVER_CAPACITY_MESSAGE).toMatch(/heavy demand/i);
    expect(OVER_CAPACITY_MESSAGE).toMatch(/try again/i);
  });
});