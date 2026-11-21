import { isIP } from 'node:net';
import { normalizeIp } from './ip';
import { MAX_TIMESTAMP_SLOTS } from './limiter/sliding-window';

export interface AppConfig {
  port: number;
  windowMs: number;
  maxRequests: number;
  maxTrackedClients: number;
  trustedProxyCidrs: string[];
}

function integerInRange(
  name: string,
  input: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (input === undefined) return fallback;

  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max || String(value) !== input) {
    throw new Error(`${name} must be a decimal integer between ${min} and ${max}`);
  }
  return value;
}

function parseTrustedProxies(input: string | undefined): string[] {
  if (input === undefined || input === '') return [];
  const entries = input.split(',');
  if (entries.length > 32) throw new Error('TRUSTED_PROXY_CIDRS supports at most 32 entries');

  return entries.map((entry) => {
    const [address = '', prefix, ...extra] = entry.trim().split('/');
    const normalized = normalizeIp(address);
    if (normalized === null || extra.length > 0) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain literal IP addresses or CIDRs');
    }
    if (prefix === undefined) return normalized;
    if (isIP(address) !== isIP(normalized)) {
      throw new Error('Use an IPv4 CIDR for IPv4-mapped ranges in TRUSTED_PROXY_CIDRS');
    }
    const maxPrefix = isIP(normalized) === 4 ? 32 : 128;
    const bits = integerInRange('TRUSTED_PROXY_CIDRS prefix', prefix, maxPrefix, 1, maxPrefix);
    return `${normalized}/${bits}`;
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env.TRUST_PROXY_HOPS !== undefined && env.TRUST_PROXY_HOPS !== '0') {
    throw new Error('TRUST_PROXY_HOPS is retired. Set TRUSTED_PROXY_CIDRS for known proxies');
  }

  const maxRequests = integerInRange(
    'RATE_LIMIT_MAX_REQUESTS',
    env.RATE_LIMIT_MAX_REQUESTS,
    10,
    1,
    10_000,
  );
  const maxTrackedClients = integerInRange(
    'MAX_TRACKED_IPS',
    env.MAX_TRACKED_IPS,
    10_000,
    1,
    1_000_000,
  );
  if (maxRequests * maxTrackedClients > MAX_TIMESTAMP_SLOTS) {
    throw new Error(
      `RATE_LIMIT_MAX_REQUESTS × MAX_TRACKED_IPS must be at most ${MAX_TIMESTAMP_SLOTS}`,
    );
  }

  return {
    port: integerInRange('PORT', env.PORT, 3000, 1, 65_535),
    windowMs: integerInRange(
      'RATE_LIMIT_WINDOW_MS',
      env.RATE_LIMIT_WINDOW_MS,
      60_000,
      100,
      3_600_000,
    ),
    maxRequests,
    maxTrackedClients,
    trustedProxyCidrs: parseTrustedProxies(env.TRUSTED_PROXY_CIDRS),
  };
}
