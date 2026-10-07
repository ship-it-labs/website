/**
 * In-memory per-key rate limiting for the auth endpoints.
 *
 * A Map of timestamps per key, pruned on every check. Single-process state:
 * the control plane runs as one instance, and a restart clearing counters is
 * fail-open in the safe direction (a burst right after a deploy is allowed,
 * nothing is ever locked out by stale state). Limits are generous on purpose —
 * this slows credential stuffing and signup spam, it does not punish humans.
 */
const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest attempt in the window ages out. Zero when allowed. */
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitResult {
  const cutoff = now - windowMs;
  const attempts = (buckets.get(key) ?? []).filter((at) => at > cutoff);

  if (attempts.length >= limit) {
    const oldest = attempts[0] ?? now;
    buckets.set(key, attempts);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  attempts.push(now);
  buckets.set(key, attempts);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Empties every bucket. Tests only — production never calls this. */
export function clearRateLimits(): void {
  buckets.clear();
}
