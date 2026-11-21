import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpus, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../dist/src/config.js';
import { SlidingWindowLimiter } from '../dist/src/limiter/sliding-window.js';
import { startServer } from '../dist/src/server.js';

const CORE_REQUESTS = 100_000;
const CAPACITY = 10_000;
const WINDOW_MS = 1000;
const HTTP_REQUESTS = 2000;
const HTTP_CONCURRENCY = 16;
const MiB = 1024 ** 2;

function memory() {
  globalThis.gc();
  const { heapUsed, rss } = process.memoryUsage();
  return { heapMiB: +(heapUsed / MiB).toFixed(2), rssMiB: +(rss / MiB).toFixed(2) };
}

async function measure(scenario, requests, concurrency, run, tracked) {
  const latency = new Float64Array(requests);
  const before = memory();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const outcomes = await run(latency);
  const durationMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const after = memory();
  latency.sort();
  const percentileUs = (p) => +(latency[Math.ceil(p * requests) - 1] * 1000).toFixed(3);
  return {
    scenario,
    requests,
    concurrency,
    outcomes,
    requestsPerSecond: Math.round((requests * 1000) / durationMs),
    latencyUs: { p50: percentileUs(0.5), p95: percentileUs(0.95), p99: percentileUs(0.99) },
    cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(1),
    trackedClients: tracked(),
    memoryMiB: { before, after },
  };
}

function benchmarkCore(scenario, quota, count, keyAt, prepare = () => {}) {
  let now = 0;
  const setTime = (time) => {
    now = time;
  };
  const keys = Array.from({ length: count }, (_, index) => `client-${index}`);
  const limiter = new SlidingWindowLimiter({
    windowMs: WINDOW_MS,
    maxRequests: quota,
    maxTrackedClients: CAPACITY,
    now: () => now,
  });
  prepare(limiter, keys);

  return measure(
    scenario,
    CORE_REQUESTS,
    1,
    (latency) => {
      const outcomes = { allowed: 0, rate_limited: 0, capacity_exceeded: 0 };
      for (let index = 0; index < CORE_REQUESTS; index++) {
        const key = keys[keyAt(index, setTime)];
        const started = performance.now();
        const { kind } = limiter.check(key);
        latency[index] = performance.now() - started;
        outcomes[kind]++;
      }
      return outcomes;
    },
    () => limiter.trackedClients,
  );
}

async function benchmarkHttp() {
  const service = startServer(
    { ...loadConfig({}), port: 0, maxRequests: HTTP_REQUESTS / 2, maxTrackedClients: 1 },
    { host: '127.0.0.1' },
  );
  try {
    await once(service.server, 'listening');
    const origin = `http://127.0.0.1:${service.server.address().port}`;
    await Promise.all(
      Array.from({ length: HTTP_CONCURRENCY }, async () => {
        const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      }),
    );
    const result = await measure(
      'loopback HTTP mixed 200/429',
      HTTP_REQUESTS,
      HTTP_CONCURRENCY,
      async (latency) => {
        const outcomes = { 200: 0, 429: 0 };
        let cursor = 0;
        await Promise.all(
          Array.from({ length: HTTP_CONCURRENCY }, async () => {
            while (cursor < HTTP_REQUESTS) {
              const index = cursor++;
              const started = performance.now();
              const response = await fetch(origin + '/api/demo', {
                signal: AbortSignal.timeout(10_000),
              });
              await response.arrayBuffer();
              latency[index] = performance.now() - started;
              assert.ok(
                response.status === 200 || response.status === 429,
                `Unexpected HTTP ${response.status}`,
              );
              outcomes[response.status]++;
            }
          }),
        );
        return outcomes;
      },
      () => service.limiter.trackedClients,
    );
    assert.deepEqual(result.outcomes, { 200: HTTP_REQUESTS / 2, 429: HTTP_REQUESTS / 2 });
    return result;
  } finally {
    await service.shutdown();
  }
}

const warmup = new SlidingWindowLimiter({
  windowMs: WINDOW_MS,
  maxRequests: 100,
  maxTrackedClients: CAPACITY,
  now: () => 0,
});
for (let index = 0; index < 20_000; index++) warmup.check(`warm-${index % 100}`);

const results = [
  await benchmarkCore('single key, quota exhausted', 10, 1, () => 0),
  await benchmarkCore('1000 independent keys', 100, 1000, (index) => index % 1000),
  await benchmarkCore('high cardinality at capacity', 10, CORE_REQUESTS, (index) => index),
  await benchmarkCore(
    'expired bucket reclamation at capacity',
    10,
    CORE_REQUESTS + CAPACITY,
    (index, setTime) => {
      setTime((1 + Math.floor(index / CAPACITY)) * WINDOW_MS);
      return index + CAPACITY;
    },
    (limiter, keys) => {
      for (let index = 0; index < CAPACITY; index++) limiter.check(keys[index]);
    },
  ),
  await benchmarkHttp(),
];
assert.equal(results[0].outcomes.rate_limited, CORE_REQUESTS - 10);
assert.equal(results[1].outcomes.allowed, CORE_REQUESTS);
assert.equal(results[2].outcomes.capacity_exceeded, CORE_REQUESTS - CAPACITY);
assert.equal(results[3].outcomes.allowed, CORE_REQUESTS);
console.log(
  JSON.stringify(
    {
      node: process.version,
      os: `${process.platform} ${release()} ${process.arch}`,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      systemMemoryGiB: +(totalmem() / 1024 ** 3).toFixed(1),
      coreWindowMs: WINDOW_MS,
      coreClientCapacity: CAPACITY,
      results,
    },
    null,
    2,
  ),
);
