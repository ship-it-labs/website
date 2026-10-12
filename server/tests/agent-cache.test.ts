import { describe, it, expect, beforeEach } from "vitest";
import {
  clearMemoryCache,
  getCached,
  getOrFill,
  hashKey,
  normalize,
  setCached,
} from "../src/services/agent-cache.js";

/**
 * The cache has to be invisible when it works and invisible when it breaks:
 * identical questions share one answer, and nothing here may ever throw.
 */
describe("agent cache keys", () => {
  it("normalizes whitespace and case so trivia shares a key", () => {
    expect(normalize("  Hello   WORLD\n\nagain ")).toBe("hello world again");
    expect(normalize("a\tb")).toBe("a b");
  });

  it("produces a stable, order-sensitive hash", () => {
    expect(hashKey(["a", "b"])).toBe(hashKey(["a", "b"]));
    expect(hashKey(["a", "b"])).not.toBe(hashKey(["b", "a"]));
    expect(hashKey(["ab"])).not.toBe(hashKey(["a", "b"]));
  });
});

describe("agent cache behaviour", () => {
  beforeEach(() => {
    clearMemoryCache();
  });

  it("serves a fresh entry from the in-process tier", async () => {
    await setCached("key-fresh", "model-x", "the answer", { ttlMs: 60_000 });
    const hit = await getCached("key-fresh");
    expect(hit).toEqual({ value: "the answer", model: "model-x" });
  });

  it("expires immediately when the ttl is zero", async () => {
    await setCached("key-doomed", "model-x", "gone", { ttlMs: 0 });
    expect(await getCached("key-doomed")).toBeNull();
  });

  it("collapses concurrent identical fills into one model call", async () => {
    let calls = 0;
    const key = `key-shared:${Math.random().toString(36).slice(2)}`;
    const fill = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return "shared answer";
    };

    const [first, second] = await Promise.all([
      getOrFill(key, "model-x", fill),
      getOrFill(key, "model-x", fill),
    ]);

    expect(calls).toBe(1);
    expect(first.value).toBe("shared answer");
    expect(first.hit).toBe(false);
    expect(second.value).toBe("shared answer");
  });

  it("returns a hit on the second, settled call without refilling", async () => {
    let calls = 0;
    const key = `key-second:${Math.random().toString(36).slice(2)}`;
    const fill = async () => {
      calls += 1;
      return "value";
    };

    await getOrFill(key, "model-x", fill);
    const again = await getOrFill(key, "model-x", fill);

    expect(calls).toBe(1);
    expect(again.hit).toBe(true);
    expect(again.value).toBe("value");
  });

  it("does not cache a failed fill", async () => {
    let calls = 0;
    const key = `key-fail:${Math.random().toString(36).slice(2)}`;
    const fill = async () => {
      calls += 1;
      throw new Error("model down");
    };

    await expect(getOrFill(key, "model-x", fill)).rejects.toThrow("model down");
    await expect(getOrFill(key, "model-x", fill)).rejects.toThrow("model down");
    expect(calls).toBe(2);
  });
});
