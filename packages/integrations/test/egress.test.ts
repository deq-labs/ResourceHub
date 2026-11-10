import { describe, expect, it } from 'vitest';
import { assertEgressAllowed, isPrivateAddress } from '../src/index.js';

describe('SSRF egress guard', () => {
  it('classifies private, loopback, link-local and metadata addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '52.168.1.1', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('blocks the Azure metadata service and private hosts in production mode', async () => {
    const prod = { allowPrivateNetworks: false };
    await expect(
      assertEgressAllowed('http://169.254.169.254/metadata/identity/oauth2/token', prod),
    ).rejects.toMatchObject({ code: 'config' });
    await expect(assertEgressAllowed('http://localhost:8088/soap', prod)).rejects.toMatchObject({
      code: 'config',
    });
    await expect(assertEgressAllowed('http://10.40.2.4:5432', prod)).rejects.toMatchObject({
      code: 'config',
    });
    await expect(assertEgressAllowed('file:///etc/passwd', prod)).rejects.toMatchObject({
      code: 'config',
    });
  });

  it('allows private hosts in local dev so the docker-compose mocks work', async () => {
    await expect(
      assertEgressAllowed('http://localhost:8088/soap', { allowPrivateNetworks: true }),
    ).resolves.toBeUndefined();
  });
});
