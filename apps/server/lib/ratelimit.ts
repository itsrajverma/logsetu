// Simple in-memory sliding-window rate limiter keyed by project id.
// Good enough for a single-instance self-hosted deployment; swap for Redis if you scale horizontally.

type Bucket = { windowStart: number; count: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

export function getRateLimitPerMinute(): number {
  const n = Number(process.env.LOGSETU_RATE_LIMIT_PER_MIN);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

export function checkRateLimit(key: string, cost = 1): { ok: boolean; remaining: number; resetInSeconds: number } {
  const limit = getRateLimitPerMinute();
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
  }
  const resetInSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
  if (bucket.count + cost > limit) {
    return { ok: false, remaining: Math.max(0, limit - bucket.count), resetInSeconds };
  }
  bucket.count += cost;
  return { ok: true, remaining: limit - bucket.count, resetInSeconds };
}

// Prune stale buckets occasionally so the map does not grow forever.
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.windowStart > WINDOW_MS * 2) buckets.delete(k);
}, WINDOW_MS);
pruneTimer.unref?.();
