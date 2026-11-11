import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { IntegrationError } from '../types.js';

/**
 * SSRF guard for admin-configured integration endpoints. In production a tenant admin must not
 * be able to point an "integration" at the Azure metadata service (169.254.169.254), the VNet
 * (Postgres, Redis, Key Vault private endpoints) or loopback. Local dev allows private hosts so
 * the docker-compose mocks work.
 *
 * Note: this checks at call time; a DNS-rebinding attacker could still race it. Production
 * should also route worker egress through a NAT/firewall with an allow-list.
 */
const BLOCKED_V4: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 (link-local, IMDS)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
}

export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    /^fe[89ab]/.test(v6)
  );
}

export interface EgressPolicy {
  allowPrivateNetworks: boolean;
}

export const defaultEgressPolicy = (): EgressPolicy => ({
  allowPrivateNetworks:
    process.env.INTEGRATIONS_ALLOW_PRIVATE_NETWORKS === 'true' ||
    process.env.NODE_ENV !== 'production',
});

export async function assertEgressAllowed(
  url: string | URL,
  policy: EgressPolicy = defaultEgressPolicy(),
): Promise<void> {
  const u = typeof url === 'string' ? new URL(url) : url;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new IntegrationError('config', `Unsupported scheme ${u.protocol}`, false);
  }
  if (policy.allowPrivateNetworks) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, order: 'verbatim' })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new IntegrationError(
      'config',
      `Refusing to call ${u.hostname}: it resolves to a private or reserved address`,
      false,
    );
  }
}
