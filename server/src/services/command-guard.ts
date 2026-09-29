/**
 * Guard for AI supplied build commands.
 *
 * These commands run inside GitHub Actions, never on the platform, but a
 * destructive command would still burn the build budget and could be used to
 * probe the runner. The list is intentionally narrow: over-blocking would stop
 * legitimate builds from working.
 */
const BLOCKLIST: RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{.*\};\s*:/,
  /\bshutdown\b/,
  /\breboot\b/,
  /curl\b[^|]*\|\s*(ba)?sh/,
  /wget\b[^|]*\|\s*(ba)?sh/,
];

export function isCommandAllowed(command: string): boolean {
  return !BLOCKLIST.some((pattern) => pattern.test(command));
}

export function firstBlockedCommand(commands: string[]): string | undefined {
  return commands.find((command) => !isCommandAllowed(command));
}
