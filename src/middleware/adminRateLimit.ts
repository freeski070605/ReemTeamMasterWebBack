import { NextFunction, Request, Response } from 'express';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const READ_LIMIT = 180;
const MUTATION_LIMIT = 60;
const buckets = new Map<string, RateLimitBucket>();

const cleanupBuckets = (now: number) => {
  if (buckets.size < 1000) {
    return;
  }

  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
};

export const adminRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const now = Date.now();
  cleanupBuckets(now);

  const identifier = req.authUser?.id || req.ip || 'unknown';
  const key = `${identifier}:${req.baseUrl}`;
  const limit = req.method === 'GET' ? READ_LIMIT : MUTATION_LIMIT;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(limit - 1));
    return next();
  }

  existing.count += 1;
  const remaining = Math.max(0, limit - existing.count);
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (existing.count > limit) {
    const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(Math.max(retryAfterSeconds, 1)));
    return res.status(429).json({ message: 'Too many admin requests. Please retry shortly.' });
  }

  return next();
};

