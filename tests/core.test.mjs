import test from 'node:test';
import assert from 'node:assert/strict';
import limiterModule from '../dist/src/limiter/sliding-window.js';
const { SlidingWindowLimiter } = limiterModule;

function setup({ maxRequests = 2, windowMs = 1000, maxTrackedClients = 10 } = {}) {
  let time = 0;
  const limiter = new SlidingWindowLimiter({
    maxRequests,
    windowMs,
    maxTrackedClients,
    now: () => time,
  });
  return {
    limiter,
    tick: (value) => {
      time = value;
    },
  };
}

test('sliding window: allows exactly N requests and rejects N+1', () => {
  const { limiter } = setup();
  assert.deepEqual(
    [
      limiter.check('192.0.2.1').kind,
      limiter.check('192.0.2.1').kind,
      limiter.check('192.0.2.1').kind,
    ],
    ['allowed', 'allowed', 'rate_limited'],
  );
});

test('oldest entry expires at exact window boundary', () => {
  const { limiter, tick } = setup();
  assert.equal(limiter.check('a').kind, 'allowed');
  tick(500);
  assert.equal(limiter.check('a').kind, 'allowed');
  tick(999);
  assert.equal(limiter.check('a').kind, 'rate_limited');
  tick(1000);
  const result = limiter.check('a');
  assert.equal(result.kind, 'allowed');
  assert.equal(result.remaining, 0);
  tick(1500);
  assert.equal(limiter.check('a').kind, 'allowed');
});

test('rejected attempts do not extend the window', () => {
  const { limiter, tick } = setup({ maxRequests: 1 });
  assert.equal(limiter.check('a').kind, 'allowed');
  for (const time of [10, 100, 500, 999]) {
    tick(time);
    const result = limiter.check('a');
    assert.equal(result.kind, 'rate_limited');
    assert.equal(result.resetAfterMs, 1000 - time);
  }
  tick(1000);
  assert.equal(limiter.check('a').kind, 'allowed');
});

test('independent IP keys have independent quotas', () => {
  const { limiter } = setup({ maxRequests: 1 });
  assert.equal(limiter.check('192.0.2.1').kind, 'allowed');
  assert.equal(limiter.check('198.51.100.2').kind, 'allowed');
  assert.equal(limiter.check('192.0.2.1').kind, 'rate_limited');
});

test('exhausted client capacity fails closed instead of forgetting active clients', () => {
  const { limiter, tick } = setup({ maxRequests: 1, maxTrackedClients: 1 });
  assert.equal(limiter.check('a').kind, 'allowed');
  assert.equal(limiter.check('b').kind, 'capacity_exceeded');
  assert.equal(limiter.trackedClients, 1);
  tick(1000);
  assert.equal(limiter.check('b').kind, 'allowed');
  assert.equal(limiter.trackedClients, 1);
});

test('sweep frees expired buckets', () => {
  const { limiter, tick } = setup({ maxRequests: 2 });
  limiter.check('a');
  limiter.check('b');
  tick(1000);
  assert.equal(limiter.sweep(), 2);
  assert.equal(limiter.trackedClients, 0);
});

test('a fractional timestamp above the cutoff is retained by quota, capacity and sweep', () => {
  const { limiter, tick } = setup({ maxRequests: 1, maxTrackedClients: 1 });
  tick(Number.EPSILON);
  assert.equal(limiter.check('a').resetAfterMs, 1000);
  tick(1000);
  assert.equal(limiter.sweep(), 0);
  assert.deepEqual(limiter.check('a'), {
    kind: 'rate_limited',
    limit: 1,
    remaining: 0,
    resetAfterMs: Number.EPSILON,
  });
  assert.deepEqual(limiter.check('b'), {
    kind: 'capacity_exceeded',
    retryAfterMs: Number.EPSILON,
  });
  tick(1000 + 2 ** -43);
  assert.equal(limiter.check('b').kind, 'allowed');
});

test('capacity retry is based on the last acceptance in the first releasable bucket', () => {
  const { limiter, tick } = setup({ maxRequests: 2, maxTrackedClients: 2 });
  limiter.check('a');
  tick(200);
  limiter.check('b');
  tick(500);
  limiter.check('a');
  assert.deepEqual(limiter.check('c'), { kind: 'capacity_exceeded', retryAfterMs: 700 });
  tick(1199);
  assert.deepEqual(limiter.check('c'), { kind: 'capacity_exceeded', retryAfterMs: 1 });
  tick(1200);
  assert.equal(limiter.check('c').kind, 'allowed');
});

test('sweep batches reclaim only the expired prefix and respect the deletion budget', () => {
  const { limiter, tick } = setup();
  for (const key of ['a', 'b', 'c']) limiter.check(key);
  tick(100);
  limiter.check('active');
  tick(1000);
  assert.throws(() => limiter.sweep(0), /Sweep batch size/);
  assert.equal(limiter.sweep(2), 2);
  assert.equal(limiter.trackedClients, 2);
  assert.equal(limiter.sweep(2), 1);
  assert.equal(limiter.sweep(2), 0);
  assert.equal(limiter.check('active').remaining, 0);
});

test('options and empty keys are validated', () => {
  assert.throws(
    () => new SlidingWindowLimiter({ maxRequests: 0, windowMs: 1000, maxTrackedClients: 5 }),
    RangeError,
  );
  assert.throws(
    () => new SlidingWindowLimiter({ maxRequests: 1, windowMs: -1, maxTrackedClients: 5 }),
    RangeError,
  );
  assert.throws(() => setup().limiter.check('  '), TypeError);
});

test('accepted requests keep remaining quota accurate', () => {
  const { limiter } = setup({ maxRequests: 3 });
  assert.equal(limiter.check('a').remaining, 2);
  assert.equal(limiter.check('a').remaining, 1);
  assert.equal(limiter.check('a').remaining, 0);
  assert.equal(limiter.check('a').remaining, 0);
});

test('clock regression freezes logical time and preserves the accepted order', () => {
  const { limiter, tick } = setup();
  tick(100);
  assert.equal(limiter.check('a').resetAfterMs, 1000);
  tick(0);
  assert.deepEqual(limiter.check('a'), {
    kind: 'allowed',
    limit: 2,
    remaining: 0,
    resetAfterMs: 1000,
  });
  assert.equal(limiter.sweep(), 0);
  for (const [time, expected] of [
    [1000, 100],
    [1099, 1],
  ]) {
    tick(time);
    assert.deepEqual(limiter.check('a'), {
      kind: 'rate_limited',
      limit: 2,
      remaining: 0,
      resetAfterMs: expected,
    });
  }
  tick(1100);
  assert.deepEqual(limiter.check('a'), {
    kind: 'allowed',
    limit: 2,
    remaining: 1,
    resetAfterMs: 1000,
  });
  tick(1101);
  assert.equal(limiter.check('a').remaining, 0);
  tick(5_000_000);
  assert.equal(limiter.check('a').remaining, 1);
});

test('invalid elapsed samples are rejected without mutating the store', () => {
  const { limiter, tick } = setup();
  for (const invalid of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    tick(invalid);
    assert.throws(() => limiter.check('a'), /clock.*finite/);
    assert.throws(() => limiter.sweep(), /clock.*finite/);
    assert.equal(limiter.trackedClients, 0);
  }
  tick(Number.MAX_SAFE_INTEGER);
  assert.equal(limiter.check('a').resetAfterMs, 1000);
});

test('fractional clock samples preserve the boundary and a fractional positive reset', () => {
  const { limiter, tick } = setup({ windowMs: 10, maxRequests: 1 });
  tick(10.25);
  assert.equal(limiter.check('a').remaining, 0);
  tick(20);
  assert.equal(limiter.check('a').resetAfterMs, 0.25);
  tick(20.25);
  assert.equal(limiter.check('a').kind, 'allowed');
});

test('reclaims the least recently accepted bucket and keeps the active bucket', () => {
  const { limiter, tick } = setup({ maxRequests: 2, windowMs: 10, maxTrackedClients: 2 });
  limiter.check('a');
  tick(1);
  limiter.check('b');
  tick(2);
  limiter.check('a');
  tick(10);
  assert.equal(limiter.sweep(), 0);
  assert.equal(limiter.check('c').kind, 'capacity_exceeded');
  tick(11);
  assert.equal(limiter.check('c').kind, 'allowed');
  assert.equal(limiter.trackedClients, 2);
  assert.equal(limiter.check('a').remaining, 0);
  assert.equal(limiter.check('b').kind, 'capacity_exceeded');
});

test('rejects out-of-range and excessive dimensions at construction', () => {
  const valid = { windowMs: 100, maxRequests: 100, maxTrackedClients: 10_000 };
  assert.doesNotThrow(() => new SlidingWindowLimiter(valid));
  assert.throws(
    () => new SlidingWindowLimiter({ ...valid, maxTrackedClients: 10_001 }),
    /capacity/,
  );
  for (const maxRequests of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new SlidingWindowLimiter({ ...valid, maxRequests }),
      /positive safe integer/,
    );
  }
});

const modelCases = [
  { seed: 1937, windowMs: 1, maxRequests: 1, maxTrackedClients: 1, keys: 3 },
  { seed: 23399, windowMs: 9, maxRequests: 2, maxTrackedClients: 7, keys: 12 },
  { seed: 293, windowMs: 120, maxRequests: 5, maxTrackedClients: 20, keys: 17 },
  { seed: 4657, windowMs: 3000, maxRequests: 25, maxTrackedClients: 10, keys: 2 },
  { seed: 137, windowMs: 3_600_000, maxRequests: 50, maxTrackedClients: 50, keys: 100 },
];

for (const options of modelCases) {
  test(`3000 operations match a reference log (seed ${options.seed})`, () => {
    const { seed, windowMs, maxRequests, maxTrackedClients, keys } = options;
    const { limiter, tick } = setup(options);
    const reference = new Map();
    let state = seed;
    let sample = 0;
    let time = 0;
    function random() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    }

    const timeline = [0, 0, 0, 1, windowMs - 1, windowMs, windowMs + 1, -1, 15 * windowMs];
    for (let i = 0; i < 3000; i++) {
      const shape = random() % 20;
      sample = Math.max(0, sample + (timeline[shape] ?? 0));
      tick(sample);
      time = Math.max(time, sample);
      const key = `ip-${random() % keys}`;
      const active = (stamps) => stamps.filter((timestamp) => timestamp > time - windowMs);
      const stamps = active(reference.get(key) ?? []);
      const liveBuckets = [...reference.values()]
        .map(active)
        .filter((entries) => entries.length > 0);

      let expected;
      if (stamps.length === 0 && liveBuckets.length === maxTrackedClients) {
        const release = Math.min(...liveBuckets.map((entries) => entries.at(-1) + windowMs));
        expected = { kind: 'capacity_exceeded', retryAfterMs: release - time };
      } else {
        const allowed = stamps.length < maxRequests;
        if (allowed) stamps.push(time);
        reference.set(key, stamps);
        expected = {
          kind: allowed ? 'allowed' : 'rate_limited',
          limit: maxRequests,
          remaining: maxRequests - stamps.length,
          resetAfterMs: windowMs - (time - stamps[0]),
        };
      }
      assert.deepEqual(
        limiter.check(key),
        expected,
        `seed=${seed} operation=${i} rawTime=${sample} key=${key}`,
      );
      if (i % 31 === 0) {
        limiter.sweep();
        const activeCount = [...reference.values()].filter(
          (entries) => active(entries).length > 0,
        ).length;
        assert.equal(limiter.trackedClients, activeCount, `seed=${seed} sweep=${i}`);
      }
    }
  });
}
