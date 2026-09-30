import { RateLimitError } from '@nexa/shared';

interface RateLimitRecord {
  timestamps: number[];
}

export class InMemoryRateLimiter {
  private records = new Map<string, RateLimitRecord>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: { windowMs?: number; maxRequests?: number } = {}) {
    this.windowMs = options.windowMs || 60_000; // 1 minute default
    this.maxRequests = options.maxRequests || 30; // 30 requests per minute
  }

  public check(key: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    let record = this.records.get(key);

    if (!record) {
      record = { timestamps: [] };
      this.records.set(key, record);
    }

    // Filter out timestamps outside window
    record.timestamps = record.timestamps.filter((ts) => now - ts < this.windowMs);

    if (record.timestamps.length >= this.maxRequests) {
      const oldest = record.timestamps[0];
      const resetMs = Math.max(0, this.windowMs - (now - oldest));
      return { allowed: false, remaining: 0, resetMs };
    }

    record.timestamps.push(now);
    const remaining = this.maxRequests - record.timestamps.length;
    return { allowed: true, remaining, resetMs: this.windowMs };
  }

  public enforce(key: string): void {
    const { allowed, resetMs } = this.check(key);
    if (!allowed) {
      throw new RateLimitError(
        `Rate limit exceeded. Please wait ${Math.ceil(resetMs / 1000)} seconds before trying again.`
      );
    }
  }

  public reset(key?: string): void {
    if (key) {
      this.records.delete(key);
    } else {
      this.records.clear();
    }
  }
}
