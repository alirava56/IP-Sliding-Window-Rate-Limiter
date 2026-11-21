import assert from 'node:assert/strict';
import test from 'node:test';
import { compileProxyTrust, normalizeIp } from '../dist/src/ip.js';

test('IP normalization canonicalizes IPv6 and folds mapped IPv4 representations', () => {
  for (const [input, expected] of [
    ['2001:db8::1', '2001:db8::1'],
    ['2001:0dB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['192.0.2.1', '192.0.2.1'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['0:0:0:0:0:FFFF:c000:0201', '192.0.2.1'],
    ['::192.0.2.1', '::c000:201'],
    ['2001:db8::2', '2001:db8::2'],
    ['::1', '::1'],
  ]) {
    assert.equal(normalizeIp(input), expected, input);
  }
});

test('IP normalization rejects malformed and ambiguous addresses', () => {
  for (const input of [
    '',
    'unknown',
    '192.000.2.1',
    '192.0.2.1:80',
    '[::1]',
    'fe80::1%eth0',
    ' 192.0.2.1',
    '127.1',
    '192.0.2.1, 192.0.2.2',
    '2001:::2',
    '256.0.0.1',
  ]) {
    assert.equal(normalizeIp(input), null, input);
  }
});

test('proxy CIDR membership uses canonical addresses and keeps families distinct', () => {
  const trust = compileProxyTrust(['192.0.2.0/24', '2001:db8::/32']);
  for (const address of ['192.0.2.10', '::FFFF:c000:20a', '2001:0DB8::42']) {
    assert.equal(trust(address), true, address);
  }
  for (const address of ['198.51.100.1', '192.00.2.10', '::192.0.2.10', '2001:db9::42']) {
    assert.equal(trust(address), false, address);
  }
  assert.equal(compileProxyTrust(['::/1'])('192.0.2.10'), false);
});
