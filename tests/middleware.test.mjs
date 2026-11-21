import test from 'node:test';
import assert from 'node:assert/strict';
import coreModule from '../dist/src/limiter/sliding-window.js';
import middlewareModule from '../dist/src/middleware/rate-limit.js';
const { SlidingWindowLimiter } = coreModule;
const { rateLimitMiddleware } = middlewareModule;

function invoke(limiter, ip, remoteAddress = ip) {
  const headers = new Map();
  const res = {
    statusCode: 200,
    body: undefined,
    locals: {},
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCount = 0;
  rateLimitMiddleware(limiter)({ ip, socket: { remoteAddress } }, res, () => {
    nextCount++;
  });
  return { res, headers, nextCount };
}

function limiter(limit = 1, maxTrackedClients = 10) {
  return new SlidingWindowLimiter({
    windowMs: 60_000,
    maxRequests: limit,
    maxTrackedClients,
    now: () => 0,
  });
}

test('middleware returns 429 and Retry-After when quota is exhausted', () => {
  const l = limiter();
  const a = invoke(l, '192.0.2.1');
  assert.equal(a.nextCount, 1);
  assert.equal(a.headers.get('ratelimit-remaining'), '0');
  const b = invoke(l, '192.0.2.1');
  assert.equal(b.res.statusCode, 429);
  assert.equal(b.res.body.error, 'TOO_MANY_REQUESTS');
  assert.equal(b.headers.get('retry-after'), '60');
  assert.equal(b.nextCount, 0);
});

test('IPv4-mapped IPv6 and IPv4 share the same quota', () => {
  const l = limiter();
  assert.equal(invoke(l, '::ffff:192.0.2.1').nextCount, 1);
  assert.equal(invoke(l, '192.0.2.1').res.statusCode, 429);
});

test('invalid IP is rejected before touching the store', () => {
  const l = limiter();
  const response = invoke(l, 'not-an-ip');
  assert.equal(response.res.statusCode, 400);
  assert.equal(l.trackedClients, 0);
});

test('capacity exhaustion returns a 503 with Retry-After', () => {
  const l = limiter(1, 1);
  assert.equal(invoke(l, '192.0.2.1').nextCount, 1);
  const response = invoke(l, '192.0.2.2');
  assert.equal(response.res.statusCode, 503);
  assert.equal(response.headers.get('retry-after'), '1');
});

test('equivalent address spellings and socket fallback share the same bucket', () => {
  const l = limiter();
  const a = invoke(l, undefined, '2001:0DB8:0000:0000:0000:0000:0000:0001');
  assert.equal(a.res.locals.clientIp, '2001:db8::1');
  assert.equal(invoke(l, '2001:db8::1').res.statusCode, 429);
  assert.equal(invoke(l, '2001:db8::2').nextCount, 1);
  assert.equal(invoke(l, undefined).res.statusCode, 400);
});
