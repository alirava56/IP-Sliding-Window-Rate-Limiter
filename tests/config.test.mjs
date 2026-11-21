import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../dist/src/config.js';

test('defaults and legacy disabled mode use direct socket identity', () => {
  assert.deepEqual(loadConfig({ TRUST_PROXY_HOPS: '0', TRUSTED_PROXY_CIDRS: '' }), {
    port: 3000,
    windowMs: 60_000,
    maxRequests: 10,
    maxTrackedClients: 10_000,
    trustedProxyCidrs: [],
  });
  assert.deepEqual(loadConfig({}).trustedProxyCidrs, []);
});

test('loads integer boundaries and enforces the joint budget', () => {
  const env = {
    PORT: '65535',
    RATE_LIMIT_WINDOW_MS: '3600000',
    RATE_LIMIT_MAX_REQUESTS: '10000',
    MAX_TRACKED_IPS: '100',
  };
  assert.deepEqual(loadConfig(env), {
    port: 65_535,
    windowMs: 3_600_000,
    maxRequests: 10_000,
    maxTrackedClients: 100,
    trustedProxyCidrs: [],
  });
  assert.throws(() => loadConfig({ ...env, MAX_TRACKED_IPS: '101' }), /must be at most 1000000/);
  assert.equal(
    loadConfig({ RATE_LIMIT_MAX_REQUESTS: '1', MAX_TRACKED_IPS: '1000000' }).maxTrackedClients,
    1_000_000,
  );
});

test('rejects malformed integers and individual out-of-range settings', () => {
  for (const PORT of [
    '',
    ' 3000',
    '3000\n',
    '+1',
    '01',
    '1.0',
    '0x10',
    '1e2',
    '1.5',
    'NaN',
    'Infinity',
    '-1',
    '0',
    '65536',
    '9007199254740993',
  ]) {
    assert.throws(() => loadConfig({ PORT }), /PORT must be a decimal integer/);
  }
  for (const [variable, value] of [
    ['RATE_LIMIT_WINDOW_MS', '99'],
    ['RATE_LIMIT_WINDOW_MS', '3600001'],
    ['RATE_LIMIT_MAX_REQUESTS', '10001'],
    ['MAX_TRACKED_IPS', '1000001'],
  ]) {
    assert.throws(() => loadConfig({ [variable]: value }), new RegExp(variable));
  }
});

test('validates and normalizes a bounded list of literal IP and CIDR proxies', () => {
  assert.deepEqual(
    loadConfig({ TRUSTED_PROXY_CIDRS: ' ::FFFF:192.0.2.10, 198.51.100.0/24, 2001:0DB8::/64 ' })
      .trustedProxyCidrs,
    ['192.0.2.10', '198.51.100.0/24', '2001:db8::/64'],
  );
  for (const TRUSTED_PROXY_CIDRS of [
    'loopback',
    'proxy.local',
    '127.0.0.1,',
    ' ',
    '0.0.0.0/0',
    '::/0',
    '192.0.2.1/33',
    '2001:db8::/129',
    '::1/64/32',
    '::ffff:192.0.2.1/120',
    'fe80::1%eth0',
    '127.000.0.1',
    '::1/',
    Array(33).fill('127.0.0.1').join(','),
  ]) {
    assert.throws(() => loadConfig({ TRUSTED_PROXY_CIDRS }), /TRUSTED_PROXY_CIDRS/);
  }
  assert.throws(
    () => loadConfig({ TRUST_PROXY_HOPS: '1', TRUSTED_PROXY_CIDRS: '127.0.0.1' }),
    /retired/,
  );
});
