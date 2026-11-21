import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { loadConfig } from '../dist/src/config.js';
import { startServer } from '../dist/src/server.js';

async function start(t, options) {
  const service = startServer({ ...loadConfig({}), port: 0 }, options);
  await once(service.server, 'listening');
  t.after(() => {
    service.server.closeAllConnections();
    return service.shutdown().catch(() => {});
  });
  return service;
}

function pendingPost(server) {
  const incoming = once(server, 'request');
  const upload = request({
    host: '127.0.0.1',
    port: server.address().port,
    path: '/api/echo',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
  });
  const response = once(upload, 'response');
  upload.flushHeaders();
  return { upload, incoming, response };
}

test(
  'shutdown stops admissions and drains an in-flight request once',
  { timeout: 5000 },
  async (t) => {
    const { server, shutdown } = await start(t, { host: '127.0.0.1', shutdownGraceMs: 2000 });
    const { upload, incoming, response } = pendingPost(server);
    await incoming;
    const done = shutdown();
    assert.equal(shutdown(), done);
    assert.equal(server.listening, false);
    upload.end('{}');
    const [reply] = await response;
    reply.resume();
    await once(reply, 'end');
    assert.equal(reply.statusCode, 200);
    await done;
  },
);

test(
  'shutdown force-closes a stalled request when the grace period expires',
  { timeout: 5000 },
  async (t) => {
    const { server, shutdown } = await start(t, { host: '127.0.0.1', shutdownGraceMs: 50 });
    const { incoming, response } = pendingPost(server);
    const disconnected = assert.rejects(response, { code: 'ECONNRESET' });
    await incoming;
    const done = shutdown();
    assert.equal(shutdown(), done);
    await Promise.all([disconnected, assert.rejects(done, /Grace period expired/)]);
    assert.equal(server.listening, false);
  },
);

test('invalid process config exits with an actionable message without logging input', () => {
  const child = spawnSync(process.execPath, ['dist/src/server.js'], {
    encoding: 'utf8',
    env: { PORT: 'invalid-private-value' },
    timeout: 5000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /PORT must be a decimal integer/);
  assert.doesNotMatch(child.stderr, /invalid-private-value/);
});

test('a listener startup failure exits nonzero without hanging', async (t) => {
  const { server } = await start(t);
  const child = spawnSync(process.execPath, ['dist/src/server.js'], {
    encoding: 'utf8',
    env: { PORT: String(server.address().port) },
    timeout: 5000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /HTTP server error.*EADDRINUSE/);
});
