import { BlockList, isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export function normalizeIp(address: string): string | null {
  // Zone identifiers describe a local interface, not a portable client identity.
  if (address.includes('%')) return null;
  const version = isIP(address);
  if (version === 0) return null;
  if (version === 4) return address;

  // Parse mixed dotted notation without treating deprecated IPv4-compatible
  // IPv6 addresses as IPv4-mapped addresses.
  const host = new URL(`http://[${address}]`).hostname.slice(1, -1);
  return ipaddr.process(host).toString();
}

export function compileProxyTrust(cidrs: readonly string[]): (address: string) => boolean {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();

  for (const entry of cidrs) {
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    const list = family === 'ipv4' ? ipv4 : ipv6;
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }

  return (address) => {
    const normalized = normalizeIp(address);
    if (normalized === null) return false;
    return isIP(normalized) === 4 ? ipv4.check(normalized, 'ipv4') : ipv6.check(normalized, 'ipv6');
  };
}
