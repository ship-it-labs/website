import { describe, it, expect } from "vitest";
import { isReachableFromTheInternet } from "../src/services/build-executor.js";

/**
 * A hosted runner can only build for us if it can reach this deployment. When it
 * cannot, GitHub Actions is not "unavailable" so much as guaranteed to fail at
 * the download step, and the resulting connection error gives no hint why.
 */

describe("public address reachability", () => {
  it.each([
    "https://ship-it.example",
    "https://app.ship-it.dev",
    "http://ship-it.example:3000",
  ])("treats %s as reachable", (url) => {
    expect(isReachableFromTheInternet(url)).toBe(true);
  });

  it.each([
    ["loopback host", "http://127.0.0.1:3000"],
    ["localhost", "http://localhost:3000"],
    ["wildcard bind", "http://0.0.0.0:3000"],
    ["ipv6 loopback", "http://[::1]:3000"],
    ["a .local hostname", "http://website:3000"],
    ["a container name", "http://orchestrator:3003"],
    ["a private range", "http://10.0.0.5:3000"],
    ["a 172.16 address", "http://172.16.4.4"],
    ["a 192.168 address", "http://192.168.1.10:3000"],
  ])("treats %s as unreachable", (_label, url) => {
    expect(isReachableFromTheInternet(url)).toBe(false);
  });

  it("treats an unparseable address as unreachable", () => {
    expect(isReachableFromTheInternet("not a url")).toBe(false);
    expect(isReachableFromTheInternet("")).toBe(false);
  });

  it("does not mistake a public address containing 127 for private", () => {
    // 127.example.com is a real hostname, not a loopback address.
    expect(isReachableFromTheInternet("https://127.example.com")).toBe(true);
  });
});
