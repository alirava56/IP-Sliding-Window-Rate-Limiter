import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../dist/src/config.js';
import appModule from '../dist/src/app.js';
const { createApp } = appModule;

async function withServer(config, fn) {
  let time = 0;
  const { app } = createApp(
    { ...loadConfig({}), maxRequests: 2, maxTrackedClients: 50, ...config },
    () => time,
  );
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(origin, (sample) => {
      time = sample;
    });
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}
test('health is available without consuming the quota', async () => {
  await withServer({ maxRequests: 1 }, async (origin) => {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${origin}/health`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('ratelimit-limit'), null);
    }
    assert.equal((await fetch(`${origin}/api/demo`)).status, 200);
    assert.equal((await fetch(`${origin}/api/demo`)).status, 429);
  });
});

test('responds with 429, JSON body, quota headers and Retry-After', async () => {
  await withServer({ maxRequests: 2 }, async (origin) => {
    const a = await fetch(`${origin}/api/demo`);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('ratelimit-limit'), '2');
    assert.equal(a.headers.get('ratelimit-remaining'), '1');
    const b = await fetch(`${origin}/api/demo`);
    assert.equal(b.headers.get('ratelimit-remaining'), '0');
    const c = await fetch(`${origin}/api/demo`);
    assert.equal(c.status, 429);
    assert.equal(c.headers.get('retry-after'), '60');
    assert.equal(c.headers.get('ratelimit-reset'), '60');
    assert.equal(c.headers.get('ratelimit-limit'), '2');
    assert.equal(c.headers.get('ratelimit-remaining'), '0');
    assert.equal(c.headers.get('cache-control'), 'no-store');
    assert.equal((await c.json()).error, 'TOO_MANY_REQUESTS');
  });
});

test('untrusted X-Forwarded-For is ignored by default', async () => {
  await withServer({ maxRequests: 1 }, async (origin) => {
    const first = await fetch(`${origin}/api/demo`, {
      headers: { 'X-Forwarded-For': '192.0.2.9' },
    });
    const second = await fetch(`${origin}/api/demo`, {
      headers: { 'X-Forwarded-For': '198.51.100.2' },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  });
});

test('one explicitly trusted reverse proxy enables per-forwarded-IP quotas', async () => {
  await withServer({ maxRequests: 1, trustedProxyCidrs: ['127.0.0.1/32'] }, async (origin) => {
    const first = await fetch(`${origin}/api/demo`, {
      headers: { 'X-Forwarded-For': '192.0.2.9' },
    });
    const second = await fetch(`${origin}/api/demo`, {
      headers: { 'X-Forwarded-For': '198.51.100.2' },
    });
    const third = await fetch(`${origin}/api/demo`, {
      headers: { 'X-Forwarded-For': '192.0.2.9' },
    });
    assert.deepEqual([first.status, second.status, third.status], [200, 200, 429]);
  });
});

test('all /api endpoints share the same IP quota', async () => {
  await withServer({ maxRequests: 1 }, async (origin) => {
    const first = await fetch(`${origin}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).data, { hello: 'world' });
    assert.equal((await fetch(`${origin}/api/demo`)).status, 429);
  });
});

test('rejects malformed JSON with 400', async () => {
  await withServer({}, async (origin) => {
    const response = await fetch(`${origin}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('ratelimit-remaining'), '1');
    assert.equal((await response.json()).error, 'INVALID_JSON');
  });
});

test('rejects oversized JSON with 413', async () => {
  await withServer({}, async (origin) => {
    const response = await fetch(`${origin}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(20_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error, 'PAYLOAD_TOO_LARGE');
  });
});

test('parallel requests do not bypass an in-process quota', async () => {
  await withServer({ maxRequests: 5 }, async (origin) => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${origin}/api/demo`)),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 5);
    assert.equal(results.filter((r) => r.status === 429).length, 15);
  });
});

test('unknown paths return JSON 404, without exposing Express details', async () => {
  await withServer({}, async (origin) => {
    const response = await fetch(`${origin}/missing`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error, 'NOT_FOUND');
  });
});

test('capacity exhaustion is a 503, never silent quota bypass', async () => {
  await withServer(
    { maxRequests: 1, maxTrackedClients: 1, trustedProxyCidrs: ['127.0.0.1/32'] },
    async (origin) => {
      assert.equal(
        (await fetch(`${origin}/api/demo`, { headers: { 'X-Forwarded-For': '192.0.2.2' } })).status,
        200,
      );
      const response = await fetch(`${origin}/api/demo`, {
        headers: { 'X-Forwarded-For': '192.0.2.3' },
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '1');
      assert.equal(response.headers.get('ratelimit-limit'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).error, 'RATE_LIMITER_CAPACITY');
    },
  );
});

test('unlisted direct peers remain untrusted with a proxy allowlist configured', async () => {
  await withServer(
    { maxRequests: 1, trustedProxyCidrs: ['192.0.2.0/24', '2001:db8::/64'] },
    async (origin) => {
      const first = await fetch(`${origin}/api/demo`, {
        headers: { 'X-Forwarded-For': '192.0.2.9' },
      });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).ip, '127.0.0.1');
      const second = await fetch(`${origin}/api/demo`, {
        headers: { 'X-Forwarded-For': '198.51.100.2' },
      });
      assert.equal(second.status, 429);
    },
  );
});

test('a selected address from a trusted proxy must be a valid unambiguous IP', async () => {
  await withServer({ maxRequests: 1, trustedProxyCidrs: ['127.0.0.1'] }, async (origin) => {
    for (const address of [
      'unknown',
      '192.0.2.1:80',
      '[2001:db8::1]',
      'fe80::1%eth0',
      '192.0.002.1',
    ]) {
      const response = await fetch(`${origin}/api/demo`, {
        headers: { 'X-Forwarded-For': address },
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('ratelimit-limit'), null);
      assert.equal((await response.json()).error, 'INVALID_CLIENT_IP');
    }
    assert.equal(
      (await fetch(`${origin}/api/demo`, { headers: { 'X-Forwarded-For': '192.0.2.1' } })).status,
      200,
    );
  });
});

test('trusted proxy chains stop at the nearest untrusted hop and canonicalize client IPs', async () => {
  await withServer(
    { maxRequests: 1, trustedProxyCidrs: ['127.0.0.1', '198.51.100.0/24'] },
    async (origin) => {
      const request = (address) =>
        fetch(`${origin}/api/demo`, { headers: { 'X-Forwarded-For': address } });
      const first = await request('192.0.2.10, 2001:0DB8:0:0:0:0:0:1, 198.51.100.2');
      assert.equal(first.status, 200);
      assert.equal((await first.json()).ip, '2001:db8::1');
      assert.equal((await request('2001:db8::1, 198.51.100.2')).status, 429);
      assert.equal((await request('2001:db8::2, 198.51.100.2')).status, 200);
      assert.equal((await request('::FFFF:c000:201')).status, 200);
      assert.equal((await request('192.0.2.1')).status, 429);
    },
  );
});

test('HTTP quota recovers at the exact boundary and rounds up Retry-After', async () => {
  await withServer({ maxRequests: 1, windowMs: 1500 }, async (origin, tick) => {
    const initial = await fetch(`${origin}/api/demo`);
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('ratelimit-reset'), '2');
    tick(1499.5);
    const blocked = await fetch(`${origin}/api/demo`);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('ratelimit-reset'), '1');
    assert.equal(blocked.headers.get('retry-after'), '1');
    tick(1500);
    const recovered = await fetch(`${origin}/api/demo`);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get('ratelimit-reset'), '2');
    assert.equal(recovered.headers.get('retry-after'), null);
  });
});

test('body byte limit is inclusive and unsupported encodings return 415', async () => {
  await withServer({ maxRequests: 4 }, async (origin) => {
    const echo = (body, headers = {}) =>
      fetch(`${origin}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
    const full = `{"data":"${'x'.repeat(16_384 - 11)}"}`;
    assert.equal(Buffer.byteLength(full), 16_384);
    assert.equal((await echo(full)).status, 200);
    assert.equal((await echo(full + ' ')).status, 413);
    for (const headers of [
      { 'Content-Encoding': 'gzip' },
      { 'Content-Type': 'application/json; charset=iso-8859-1' },
    ]) {
      const response = await echo('{}', headers);
      assert.equal(response.status, 415);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).error, 'UNSUPPORTED_BODY_ENCODING');
    }
  });
});

test('a limiter failure returns a cache-controlled 500 with a generic body and log', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  await withServer({}, async (origin, tick) => {
    tick(NaN);
    const response = await fetch(`${origin}/api/demo`);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
    assert.deepEqual(
      log.mock.calls.map((call) => call.arguments),
      [['Unhandled request error']],
    );
  });
});
