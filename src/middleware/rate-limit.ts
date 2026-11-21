import type { RequestHandler } from 'express';
import { normalizeIp } from '../ip';
import type { SlidingWindowLimiter } from '../limiter/sliding-window';

function delaySeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

export function rateLimitMiddleware(limiter: SlidingWindowLimiter): RequestHandler {
  return (req, res, next) => {
    const clientIp = normalizeIp(req.ip ?? req.socket.remoteAddress ?? '');
    if (clientIp === null) {
      res
        .status(400)
        .json({ error: 'INVALID_CLIENT_IP', message: 'Unable to determine a valid client IP' });
      return;
    }

    const decision = limiter.check(clientIp);
    if (decision.kind === 'capacity_exceeded') {
      res.setHeader('Retry-After', delaySeconds(decision.retryAfterMs));
      res
        .status(503)
        .json({ error: 'RATE_LIMITER_CAPACITY', message: 'Limiter is temporarily at capacity' });
      return;
    }

    const reset = delaySeconds(decision.resetAfterMs);
    res.setHeader('RateLimit-Limit', String(decision.limit));
    res.setHeader('RateLimit-Remaining', String(decision.remaining));
    res.setHeader('RateLimit-Reset', reset);

    if (decision.kind === 'rate_limited') {
      res.setHeader('Retry-After', reset);
      res
        .status(429)
        .json({ error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded. Please retry later.' });
      return;
    }

    res.locals.clientIp = clientIp;
    next();
  };
}
