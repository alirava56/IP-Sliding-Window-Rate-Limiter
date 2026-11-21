import { performance } from 'node:perf_hooks';

export const MAX_TIMESTAMP_SLOTS = 1_000_000;

export interface SlidingWindowOptions {
  windowMs: number;
  maxRequests: number;
  maxTrackedClients: number;
  now?: () => number;
}

type Quota = { limit: number; resetAfterMs: number };

export type RateLimitDecision =
  | (Quota & { kind: 'allowed'; remaining: number })
  | (Quota & { kind: 'rate_limited'; remaining: 0 })
  | { kind: 'capacity_exceeded'; retryAfterMs: number };

interface Bucket {
  key: string;
  timestamps: number[];
  previous: Bucket | null;
  next: Bucket | null;
}

export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxTrackedClients: number;
  private readonly now: () => number;
  private lastTime = 0;
  // Order by most recent acceptance, with direct access to the first bucket.
  private oldest: Bucket | null = null;
  private newest: Bucket | null = null;

  constructor({
    windowMs,
    maxRequests,
    maxTrackedClients,
    now = () => performance.now(),
  }: SlidingWindowOptions) {
    for (const [name, value] of Object.entries({ windowMs, maxRequests, maxTrackedClients })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    if (maxRequests * maxTrackedClients > MAX_TIMESTAMP_SLOTS) {
      throw new RangeError(`Timestamp capacity must be at most ${MAX_TIMESTAMP_SLOTS}`);
    }

    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.maxTrackedClients = maxTrackedClients;
    this.now = now;
  }

  check(key: string): RateLimitDecision {
    if (!key.trim()) throw new TypeError('Rate-limit key must be non-empty');

    const time = this.readTime();
    let bucket = this.buckets.get(key);
    if (bucket === undefined && this.buckets.size >= this.maxTrackedClients) {
      if (this.oldest === null || !this.isExpired(this.oldest, time)) {
        return { kind: 'capacity_exceeded', retryAfterMs: 1000 };
      }
      this.remove(this.oldest);
    }

    const timestamps = bucket?.timestamps ?? [];
    let expired = 0;
    for (const timestamp of timestamps) {
      if (time - timestamp < this.windowMs) break;
      expired++;
    }
    if (expired > 0) timestamps.splice(0, expired);

    const resetAfterMs = this.windowMs - (time - (timestamps[0] ?? time));
    if (timestamps.length === this.maxRequests) {
      return { kind: 'rate_limited', limit: this.maxRequests, remaining: 0, resetAfterMs };
    }

    timestamps.push(time);
    if (bucket === undefined) {
      bucket = { key, timestamps, previous: null, next: null };
      this.buckets.set(key, bucket);
      this.append(bucket);
    } else if (bucket !== this.newest) {
      this.unlink(bucket);
      this.append(bucket);
    }
    return {
      kind: 'allowed',
      limit: this.maxRequests,
      remaining: this.maxRequests - timestamps.length,
      resetAfterMs,
    };
  }

  /** Reclaims only the expired prefix, ordered by most recent acceptance. */
  sweep(): number {
    const time = this.readTime();
    let removed = 0;
    while (this.oldest !== null && this.isExpired(this.oldest, time)) {
      this.remove(this.oldest);
      removed++;
    }
    return removed;
  }

  get trackedClients(): number {
    return this.buckets.size;
  }

  private readTime(): number {
    const sample = this.now();
    if (!Number.isFinite(sample) || sample < 0 || sample > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        'Limiter clock must return finite elapsed milliseconds in the safe numeric range',
      );
    }
    // A regressed sample cannot move accepted timestamps into the future.
    this.lastTime = Math.max(this.lastTime, sample);
    return this.lastTime;
  }

  private isExpired(bucket: Bucket, time: number): boolean {
    // Every tracked bucket has an accepted timestamp.
    const latest = bucket.timestamps.at(-1);
    return latest !== undefined && time - latest >= this.windowMs;
  }

  private append(bucket: Bucket): void {
    bucket.previous = this.newest;
    bucket.next = null;
    if (this.newest === null) this.oldest = bucket;
    else this.newest.next = bucket;
    this.newest = bucket;
  }

  private unlink(bucket: Bucket): void {
    if (bucket.previous === null) this.oldest = bucket.next;
    else bucket.previous.next = bucket.next;
    if (bucket.next === null) this.newest = bucket.previous;
    else bucket.next.previous = bucket.previous;
  }

  private remove(bucket: Bucket): void {
    this.buckets.delete(bucket.key);
    this.unlink(bucket);
  }
}
