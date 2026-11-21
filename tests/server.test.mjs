import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import test from 'node:test';
import { loadConfig } from '../dist/src/config.js';
import { startServer } from '../dist/src/server.js';

async function start(t, options, config = {}) {
  const service = startServer({ ...loadConfig({}), ...config, port: 0 }, options);
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

async function readResponse(response) {
  const [reply] = await response;
  reply.setEncoding('utf8');
  let body = '';
  for await (const chunk of reply) body += chunk;
  return { status: reply.statusCode, headers: reply.headers, body: JSON.parse(body) };
}

test(
  '100 Continue is sent only after validating size and granting quota',
  { timeout: 5000 },
  async (t) => {
    const { server } = await start(t, { host: '127.0.0.1' }, { maxRequests: 2 });
    for (const { length, status, allowBody } of [
      { length: 16_385, status: 413, allowBody: false },
      { length: 2, status: 200, allowBody: true },
      { length: 2, status: 429, allowBody: false },
    ]) {
      const upload = request({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/echo',
        method: 'POST',
        headers: {
          Expect: '100-continue',
          'Content-Type': 'application/json',
          'Content-Length': length,
        },
      });
      t.after(() => upload.destroy());
      let continuations = 0;
      upload.on('continue', () => {
        continuations++;
        if (allowBody) upload.end('{}');
      });
      const pending = once(upload, 'response');
      upload.flushHeaders();
      const reply = await readResponse(pending);
      assert.equal(reply.status, status);
      assert.equal(continuations, allowBody ? 1 : 0);
      if (allowBody) assert.deepEqual(reply.body.data, {});
    }
  },
);

test(
  'chunked uploads exceeding the limit get 413 before the body finishes',
  { timeout: 5000 },
  async (t) => {
    const { server } = await start(t, { host: '127.0.0.1' });
    const upload = request({
      host: '127.0.0.1',
      port: server.address().port,
      path: '/api/echo',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    });
    t.after(() => upload.destroy());
    const response = once(upload, 'response');
    upload.write('[' + ' '.repeat(8191));
    upload.write(' '.repeat(8193));
    const reply = await readResponse(response);
    assert.equal(reply.status, 413);
    assert.equal(reply.headers.connection, 'close');
    assert.equal(reply.body.error, 'PAYLOAD_TOO_LARGE');
  },
);

test(
  'shutdown drains an admitted upload and rejects a later request on its connection',
  { timeout: 5000 },
  async (t) => {
    const { server, shutdown } = await start(t, { host: '127.0.0.1', shutdownGraceMs: 2000 });
    const socket = createConnection({ host: '127.0.0.1', port: server.address().port });
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    let output = '';
    socket.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    const completed = once(socket, 'close');
    const incoming = once(server, 'request');
    socket.write(
      [
        'POST /api/echo HTTP/1.1',
        'Host: localhost',
        'Content-Type: application/json',
        'Content-Length: 2',
        '',
        '',
      ].join('\r\n'),
    );
    await incoming;
    const done = shutdown();
    socket.write('{}GET /api/demo HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await Promise.all([completed, done]);
    assert.deepEqual(
      [...output.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => match[1]),
      ['200', '503'],
    );
    assert.match(output, /SERVICE_SHUTTING_DOWN/);
  },
);

test(
  'background sweeping limits a batch and schedules another when it is full',
  { timeout: 5000 },
  async (t) => {
    const { limiter, shutdown } = await start(t, { host: '127.0.0.1' }, { windowMs: 100 });
    let batches = 0;
    const nextBatch = new Promise((resolve) => {
      t.mock.method(limiter, 'sweep', (size) => {
        batches++;
        if (batches === 1) return size;
        resolve();
        return 0;
      });
    });
    await nextBatch;
    await shutdown();
    assert.deepEqual(
      limiter.sweep.mock.calls.map((call) => call.arguments),
      [[1024], [1024]],
    );
  },
);
