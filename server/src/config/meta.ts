import { createRequire } from "node:module";

/**
 * Build identity for /health: what is running and since when. The version is
 * the package version (bumped on release); the boot time anchors uptime.
 */
const bootTime = Date.now();

// Synchronous require without an import cycle: a static JSON import would be
// resolved by tsc's module settings, while createRequire is a plain read that
// works identically in tsx and in the compiled dist output.
const nodeRequire = createRequire(import.meta.url);

function packageVersion(): string {
  try {
    // server/package.json sits two levels above src/config when compiled.
    const pkg = nodeRequire("../../package.json") as { version?: string };
    return typeof pkg?.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function appVersion(): string {
  return packageVersion();
}

/** Whole seconds since the process booted. */
export function uptimeSeconds(now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - bootTime) / 1000));
}
