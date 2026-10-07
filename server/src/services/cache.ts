/**
 * Minimal in-memory TTL cache for hot read-only lookups.
 *
 * Single-flight: concurrent callers share one fill rather than stampeding the
 * database. Failures are not cached, so a transient error degrades to another
 * lookup instead of a minute of stale errors.
 */
export class TtlCache<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private inflight: Promise<T> | null = null;

  constructor(private readonly ttlMs: number) {}

  get(): T | null {
    if (this.value !== undefined && Date.now() < this.expiresAt) {
      return this.value;
    }
    return null;
  }

  set(value: T): void {
    this.value = value;
    this.expiresAt = Date.now() + this.ttlMs;
  }

  invalidate(): void {
    this.value = undefined;
    this.expiresAt = 0;
  }

  async getOrFill(fill: () => Promise<T>): Promise<T> {
    const cached = this.get();
    if (cached !== null) return cached;
    if (this.inflight) return this.inflight;

    this.inflight = fill().then(
      (fresh) => {
        this.set(fresh);
        this.inflight = null;
        return fresh;
      },
      (err) => {
        this.inflight = null;
        throw err;
      }
    );
    return this.inflight;
  }
}
