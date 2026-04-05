import type { Request, Response, NextFunction } from "express";
import { redis } from "../lib/redis.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  /** Duration of the sliding window in milliseconds */
  windowMs: number;
  /** Maximum number of requests allowed in the window */
  max: number;
  /** Redis key prefix (e.g. "rl:login") */
  keyPrefix: string;
}

type ExpressMiddleware = (req: Request, res: Response, next: NextFunction) => void;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates an Express rate-limit middleware backed by Redis.
 *
 * Uses a sliding-window counter: atomically increments a counter keyed by
 * `keyPrefix:<identity>` where identity is the authenticated user id or
 * the client IP. The first request in each window sets the TTL so old
 * counters are garbage-collected automatically.
 *
 * Fails open when Redis is unavailable so the service keeps running.
 */
export function createRateLimit(options: RateLimitOptions): ExpressMiddleware {
  const { windowMs, max, keyPrefix } = options;
  const windowSeconds = Math.ceil(windowMs / 1000);

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Prefer authenticated user id so per-user limits work correctly behind
    // shared proxies; fall back to remote IP for unauthenticated endpoints.
    const identity =
      req.userId ??
      req.ip ??
      req.socket.remoteAddress ??
      "unknown";

    const key = `${keyPrefix}:${identity}`;

    void (async () => {
      try {
        // Atomically increment and retrieve the new count
        const count = await redis.incr(key);

        if (count === 1) {
          // First hit in this window: set the expiry
          await redis.expire(key, windowSeconds);
        }

        // Remaining TTL drives the Retry-After header value
        const ttl = await redis.ttl(key);
        const retryAfter = ttl > 0 ? ttl : windowSeconds;

        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - count)));
        res.setHeader("X-RateLimit-Reset", String(Date.now() + retryAfter * 1000));

        if (count > max) {
          res.setHeader("Retry-After", String(retryAfter));
          res.status(429).json({
            error: "Too many requests",
            retryAfter,
          });
          return;
        }

        next();
      } catch {
        // Redis unavailable — fail open
        next();
      }
    })();
  };
}

// ─── Pre-configured limiters ──────────────────────────────────────────────────

/**
 * 5 login attempts per 15 minutes per IP.
 */
export const loginLimiter: ExpressMiddleware = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyPrefix: "rl:login",
});

/**
 * 5 MFA challenge attempts per 5 minutes per IP.
 */
export const mfaLimiter: ExpressMiddleware = createRateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  keyPrefix: "rl:mfa",
});

/**
 * 100 uploads per hour per authenticated user.
 */
export const uploadLimiter: ExpressMiddleware = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  keyPrefix: "rl:upload",
});

/**
 * 1 000 API calls per minute per authenticated user.
 */
export const apiLimiter: ExpressMiddleware = createRateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  keyPrefix: "rl:api",
});
