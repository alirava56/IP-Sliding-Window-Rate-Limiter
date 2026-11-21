import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig } from '../dist/src/config.js';
import { startServer } from '../dist/src/server.js';

const service = startServer({ ...loadConfig({}), port: 0 }, { host: '127.0.0.1' });
try {
  await once(service.server, 'listening');
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const request = (path) => fetch(origin + path, { signal: AbortSignal.timeout(5000) });
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  for (let i = 0; i < 12; i++) {
    const response = await request('/api/demo');
    const accepted = i < 10;
    assert.equal(response.status, accepted ? 200 : 429);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('ratelimit-limit'), '10');
    assert.equal(response.headers.get('ratelimit-remaining'), String(Math.max(0, 9 - i)));
    const reset = response.headers.get('ratelimit-reset');
    assert.ok(Number(reset) >= 1 && Number(reset) <= 60);
    assert.equal(response.headers.get('retry-after'), accepted ? null : reset);
    const payload = await response.json();
    assert.equal(
      accepted ? payload.ip : payload.error,
      accepted ? '127.0.0.1' : 'TOO_MANY_REQUESTS',
    );
  }
  const stillHealthy = await request('/health');
  assert.equal(stillHealthy.status, 200);
  await stillHealthy.json();
  console.log('Smoke passed: 10 accepted, 2 rate limited, and health remained available.');
} finally {
  await service.shutdown();
}
